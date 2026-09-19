import { describe, expect, test } from "bun:test";
import {
  SLACK_WEB_API_ORIGIN,
  createSlackWebApiTransport,
} from "../src/transport.ts";
import type { SlackApiCall } from "../src/worker.ts";

const signal = new AbortController().signal;
const call: SlackApiCall = { method: "auth.test", payload: {}, signal };

describe("fetch-backed Slack Web API transport", () => {
  test("makes one fixed-origin JSON POST with the bearer token and returns only bounded response metadata", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const transport = createSlackWebApiTransport({
      token: "xoxb-synthetic-secret",
      fetch: async (input, init) => {
        requests.push({ url: String(input), init });
        return new Response('{"ok":false,"error":"ratelimited"}', {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "7", "x-secret-provider-header": "drop-me" },
        });
      },
    });

    expect(await transport.call(call)).toEqual({
      status: 429,
      headers: { "retry-after": "7" },
      body: { ok: false, error: "ratelimited" },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${SLACK_WEB_API_ORIGIN}/auth.test`);
    expect(requests[0]?.init).toMatchObject({
      method: "POST",
      body: "{}",
      signal,
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer xoxb-synthetic-secret");
    expect(headers.get("content-type")).toBe("application/json; charset=utf-8");
  });

  test("enforces provider request bytes before fetch", async () => {
    let calls = 0;
    const transport = createSlackWebApiTransport({
      token: "xoxb-synthetic-secret",
      fetch: async () => {
        calls += 1;
        return new Response("{}");
      },
    });

    await expect(transport.call({
      method: "chat.postMessage",
      payload: { text: "x".repeat(131_073) },
      signal,
    })).rejects.toThrow("request exceeded its byte limit");
    expect(calls).toBe(0);
  });

  test("accepts an exact response byte ceiling and rejects a chunked response one byte over", async () => {
    const exact = createSlackWebApiTransport({
      token: "xoxb-synthetic-secret",
      maxResponseBytes: 7,
      fetch: async () => new Response('{"a":1}'),
    });
    expect((await exact.call(call)).body).toEqual({ a: 1 });

    const over = createSlackWebApiTransport({
      token: "xoxb-synthetic-secret",
      maxResponseBytes: 7,
      fetch: async () => new Response('{"aa":1}'),
    });
    await expect(over.call(call)).rejects.toThrow("response exceeded its byte limit");
  });

  test("rejects malformed JSON and UTF-8 without exposing provider bytes", async () => {
    for (const body of [
      "not-json-private-provider-data",
      new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]),
    ]) {
      const transport = createSlackWebApiTransport({
        token: "xoxb-synthetic-secret",
        fetch: async () => new Response(body),
      });
      let message = "";
      try {
        await transport.call(call);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toBe("Slack Web API response was malformed");
      expect(message).not.toContain("private-provider-data");
      expect(message).not.toContain("xoxb-synthetic-secret");
    }
  });

  test("does not retry or propagate a fetch error that could contain a token", async () => {
    const token = "xoxb-never-log-this";
    let calls = 0;
    const transport = createSlackWebApiTransport({
      token,
      fetch: async () => {
        calls += 1;
        throw new Error(`synthetic failure with ${token}`);
      },
    });

    let message = "";
    try {
      await transport.call(call);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Slack Web API request failed");
    expect(message).not.toContain(token);
    expect(calls).toBe(1);
  });
});

test("personal Slack sessions use one fixed-origin form request and never forward cookies through redirects", async () => {
  let calls = 0;
  const transport = createSlackWebApiTransport({ token: "xoxc-synthetic", cookie: "synthetic-session", fetch: async (url, init) => {
    calls++;
    expect(String(url)).toBe("https://slack.com/api/chat.postMessage");
    const headers = new Headers(init?.headers);
    expect(headers.get("cookie")).toBe("d=synthetic-session");
    expect(headers.get("content-type")).toContain("application/x-www-form-urlencoded");
    expect(init?.redirect).toBe("error");
    const form = new URLSearchParams(String(init?.body));
    expect(form.get("text")).toBe("hello & 안녕");
    expect(form.get("mrkdwn")).toBe("false");
    return new Response('{"ok":true}');
  } });
  await transport.call({ method: "chat.postMessage", payload: { channel: "D123", text: "hello & 안녕", mrkdwn: false }, signal });
  expect(calls).toBe(1);
  expect(() => createSlackWebApiTransport({ token: "xoxc-synthetic", cookie: "a; another=b" })).toThrow();
});
