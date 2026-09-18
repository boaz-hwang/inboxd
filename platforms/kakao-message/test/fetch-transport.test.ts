import { describe, expect, test } from "bun:test";

import {
  createKakaoFetchTransport,
  type KakaoFetch,
} from "../src/fetch-transport.ts";

const request = {
  method: "POST",
  url: "https://kapi.kakao.com/v1/api/talk/friends/message/send",
  headers: { "content-type": "application/x-www-form-urlencoded;charset=utf-8" },
  body: "receiver_uuids=%5B%22friend-uuid%22%5D&template_id=notice-7",
  timeout_ms: 1_000,
  max_response_bytes: 1_024,
} as const;

describe("Kakao one-attempt fetch transport", () => {
  test("makes exactly one non-redirecting authenticated fetch and reads a bounded response", async () => {
    const calls: { input: string | URL | Request; init?: RequestInit }[] = [];
    const fetchImpl: KakaoFetch = async (input, init) => {
      calls.push({ input, init });
      return new Response('{"successful_receiver_uuids":["friend-uuid"]}', { status: 200 });
    };

    const response = await createKakaoFetchTransport("synthetic-access-token", fetchImpl)(request);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toBe(request.url);
    expect(calls[0]!.init).toMatchObject({
      method: "POST",
      redirect: "error",
      body: request.body,
      headers: {
        authorization: "Bearer synthetic-access-token",
        "content-type": request.headers["content-type"],
      },
    });
    expect(calls[0]!.init!.signal).toBeInstanceOf(AbortSignal);
    expect(response).toEqual({
      status: 200,
      body: '{"successful_receiver_uuids":["friend-uuid"]}',
    });
  });

  test("cuts off an oversized streamed response without another fetch attempt", async () => {
    let calls = 0;
    const fetchImpl: KakaoFetch = async () => {
      calls += 1;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("1234"));
          controller.enqueue(new TextEncoder().encode("56"));
          controller.close();
        },
      }), { status: 200 });
    };

    await expect(createKakaoFetchTransport("synthetic-access-token", fetchImpl)({
      ...request,
      max_response_bytes: 5,
    })).rejects.toThrow(/response.*bytes|limit/i);
    expect(calls).toBe(1);
  });

  test("aborts a timed-out fetch once and never retries", async () => {
    let calls = 0;
    let observedAbort = false;
    const fetchImpl: KakaoFetch = async (_input, init) => {
      calls += 1;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          observedAbort = true;
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
    };

    await expect(createKakaoFetchTransport("synthetic-access-token", fetchImpl)({
      ...request,
      timeout_ms: 5,
    })).rejects.toThrow();
    expect(calls).toBe(1);
    expect(observedAbort).toBe(true);
  });

  test("returns at the deadline even if the fetch implementation ignores abort", async () => {
    let calls = 0;
    const fetchImpl: KakaoFetch = async () => {
      calls += 1;
      return await new Promise<Response>(() => {});
    };

    await expect(createKakaoFetchTransport("synthetic-access-token", fetchImpl)({
      ...request,
      timeout_ms: 5,
    })).rejects.toThrow(/timeout|deadline|abort/i);
    expect(calls).toBe(1);
  }, 100);

  test("surfaces response-stream EOF failure after one fetch without returning a partial body", async () => {
    let calls = 0;
    const fetchImpl: KakaoFetch = async () => {
      calls += 1;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"successful_receiver_uuids":'));
          controller.error(new Error("unexpected EOF"));
        },
      }), { status: 200 });
    };

    await expect(createKakaoFetchTransport("synthetic-access-token", fetchImpl)(request)).rejects.toThrow(/EOF/);
    expect(calls).toBe(1);
  });

  test("measures response limits in UTF-8 bytes and rejects malformed UTF-8", async () => {
    const exact = createKakaoFetchTransport("synthetic-access-token", async () => new Response("한ab", { status: 200 }));
    await expect(exact({ ...request, max_response_bytes: 5 })).resolves.toEqual({ status: 200, body: "한ab" });

    const multibyteOver = createKakaoFetchTransport(
      "synthetic-access-token",
      async () => new Response("한한", { status: 200 }),
    );
    await expect(multibyteOver({ ...request, max_response_bytes: 5 })).rejects.toThrow(/response.*bytes|limit/i);

    const malformed = createKakaoFetchTransport(
      "synthetic-access-token",
      async () => new Response(Uint8Array.of(0xff), { status: 200 }),
    );
    await expect(malformed(request)).rejects.toThrow();
  });
});