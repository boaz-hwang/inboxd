import { describe, expect, test } from "bun:test";
import {
  parseWorkerRequest,
  parseWorkerRequestFrame,
  parseWorkerResponse,
  parseWorkerResponseFrame,
  type WorkerResponseV1,
  WORKER_OPERATIONS,
} from "../src/index.ts";

const fixture = await Bun.file(new URL("../../../test/fixtures/protocol/worker-contract-v1.json", import.meta.url)).json();

const typedSendResponse: WorkerResponseV1<"send"> = {
  v: 1,
  type: "worker_response",
  request_id: "typed-send",
  generation: 1,
  operation: "send",
  ok: true,
  result: { outcome: "sent", receipt_id: "receipt" },
};
void typedSendResponse;

const mismatchedTypedResponse: WorkerResponseV1<"send"> = {
  v: 1,
  type: "worker_response",
  request_id: "typed-mismatch",
  generation: 1,
  operation: "send",
  ok: true,
  // @ts-expect-error A send response cannot carry a read_page result.
  result: { items: [], next_cursor: null, authoritative: true },
};
void mismatchedTypedResponse;

describe("provider worker contract v1", () => {
  test("parses all four bounded request operations", () => {
    expect(WORKER_OPERATIONS).toEqual(["read_page", "send", "read_receipt", "health"]);
    for (const operation of WORKER_OPERATIONS) {
      const request = parseWorkerRequest(fixture.requests[operation]);
      expect(request.operation.op).toBe(operation);
      expect(request.request_id).toBe(fixture.requests[operation].request_id);
      expect(request.generation).toBe(7);
      expect(request.binding_id).toBe("slack-work");
    }
  });

  test("requires exact binding, generation, time, byte, and operation bounds", () => {
    const read = fixture.requests.read_page;
    for (const invalid of [
      { ...read, request_id: "" },
      { ...read, generation: 0 },
      { ...read, binding_id: "" },
      { ...read, limits: { ...read.limits, timeout_ms: 0 } },
      { ...read, limits: { ...read.limits, max_response_bytes: 16777217 } },
      { ...read, limits: { ...read.limits, max_queue_depth: 0 } },
      { ...read, limits: { ...read.limits, max_queue_depth: 1025 } },
      { ...read, operation: { ...read.operation, limit: 101 } },
      { ...read, operation: { ...read.operation, cursor: "x".repeat(4097) } },
      { ...read, executable: "/tmp/untrusted-worker" },
    ]) expect(() => parseWorkerRequest(invalid)).toThrow();

    for (const cursor of ["한".repeat(1_366), "\ud800".repeat(1_366)]) {
      expect(new TextEncoder().encode(cursor).byteLength).toBeGreaterThan(4_096);
      expect(() => parseWorkerRequest({
        ...read,
        operation: { ...read.operation, cursor },
      })).toThrow(/cursor.*bytes|cursor.*limit/i);
      expect(() => parseWorkerResponse({
        ...fixture.responses.read_page,
        result: { ...fixture.responses.read_page.result, next_cursor: cursor },
      }, read)).toThrow(/cursor.*bytes|cursor.*limit/i);
    }
  });

  test("accepts only normalized sends and exact receipt destinations", () => {
    const send = fixture.requests.send;
    expect(parseWorkerRequest(send).operation).toEqual(send.operation);
    expect(() => parseWorkerRequest({ ...send, operation: { op: "send", envelope: { scope: { platform: "slack", account: "work", chat_id: "C0123" }, body: "legacy" }, idempotency_key: send.operation.idempotency_key } })).toThrow();
    expect(() => parseWorkerRequest({ ...send, operation: { ...send.operation, idempotency_key: "not-a-sha256" } })).toThrow(/idempotency/i);

    const receipt = fixture.requests.read_receipt;
    expect(parseWorkerRequest(receipt).operation).toEqual(receipt.operation);
    expect(() => parseWorkerRequest({
      ...receipt,
      operation: { ...receipt.operation, destination: { ...receipt.operation.destination, chat_id: "C9999" } },
    })).toThrow(/destination/i);
  });

  test("parses operation-specific results and explicit send uncertainty", () => {
    for (const operation of WORKER_OPERATIONS) {
      const response = parseWorkerResponse(fixture.responses[operation], fixture.requests[operation]);
      expect(response.operation).toBe(operation);
      expect(response.ok).toBe(true);
    }
    expect(parseWorkerResponse({
      ...fixture.responses.send,
      result: { outcome: "uncertain", reason: "connection_lost_after_dispatch" },
    }, fixture.requests.send)).toMatchObject({ ok: true, result: { outcome: "uncertain" } });
    expect(parseWorkerResponse({
      ...fixture.responses.read_receipt,
      result: { outcome: "unavailable", reason: "history_read_failed" },
    }, fixture.requests.read_receipt)).toMatchObject({ ok: true, result: { outcome: "unavailable" } });
  });

  test("binds verified receipt evidence and response identity to the originating request", () => {
    const request = fixture.requests.read_receipt;
    const response = fixture.responses.read_receipt;
    expect(parseWorkerResponse(response, request)).toEqual(response);

    for (const invalid of [
      { ...response, request_id: "another-request" },
      { ...response, generation: request.generation + 1 },
      { ...response, operation: "send" },
      { ...response, result: { outcome: "verified", evidence: {} } },
      { ...response, result: { ...response.result, evidence: { ...response.result.evidence, receipt_id: "another-receipt" } } },
      { ...response, result: { ...response.result, evidence: { ...response.result.evidence, destination: { ...response.result.evidence.destination, chat_id: "C9999" } } } },
      { ...response, result: { ...response.result, evidence: { ...response.result.evidence, content: { mode: "text", body: "changed" } } } },
      { ...response, result: { ...response.result, evidence: { ...response.result.evidence, reply: { parent_id: "changed" } } } },
    ]) expect(() => parseWorkerResponse(invalid, request)).toThrow(/request|generation|operation|evidence|destination|receipt|body|reply/i);

    const templateRequest = {
      ...fixture.requests.read_receipt,
      request_id: "req-template-receipt",
      operation: {
        op: "read_receipt",
        destination: { v: 1, kind: "destination", platform: "kakao", account: "official-app", destination_id: "friend-uuid" },
        receipt_id: "kakao-receipt-1",
        expected: {
          v: 2,
          destination: { v: 1, kind: "destination", platform: "kakao", account: "official-app", destination_id: "friend-uuid" },
          content: { mode: "approved_template", template_id: "notice-7", arguments: { amount: 1000 }, preview: "승인: 1000" },
        },
      },
    };
    expect(() => parseWorkerRequest(templateRequest)).toThrow(/read_receipt.*chat|independent readback/i);
  });

  test("enforces queue, requested item, payload, aggregate JSON, evidence, and encoded response bounds", () => {
    const readRequest = fixture.requests.read_page;
    expect(parseWorkerRequest(readRequest).limits.max_queue_depth).toBe(8);

    const oneItemRequest = { ...readRequest, operation: { ...readRequest.operation, limit: 1 } };
    expect(() => parseWorkerResponse({
      ...fixture.responses.read_page,
      result: { ...fixture.responses.read_page.result, items: [{ id: "one" }, { id: "two" }] },
    }, oneItemRequest)).toThrow(/requested limit|items/i);

    const responseBytes = new TextEncoder().encode(JSON.stringify(fixture.responses.read_page)).byteLength;
    expect(() => parseWorkerResponse(fixture.responses.read_page, {
      ...readRequest,
      limits: { ...readRequest.limits, max_response_bytes: responseBytes - 1 },
    })).toThrow(/response.*bytes|frame/i);

    const compactResponse = JSON.stringify(fixture.responses.read_page);
    const paddedResponse = `${" ".repeat(512)}${compactResponse}`;
    const escapedResponse = compactResponse.replace("hello", "\\u0068\\u0065\\u006c\\u006c\\u006f");
    const rawLimitRequest = {
      ...readRequest,
      limits: { ...readRequest.limits, max_response_bytes: responseBytes + 16 },
    };
    expect(parseWorkerResponseFrame(compactResponse, rawLimitRequest)).toEqual(fixture.responses.read_page);
    expect(() => parseWorkerResponseFrame(paddedResponse, rawLimitRequest)).toThrow(/response.*bytes|frame/i);
    expect(() => parseWorkerResponseFrame(escapedResponse, rawLimitRequest)).toThrow(/response.*bytes|frame/i);
    expect(parseWorkerRequestFrame(JSON.stringify(readRequest))).toEqual(readRequest);

    const sendRequest = fixture.requests.send;
    expect(() => parseWorkerRequest({
      ...sendRequest,
      operation: { ...sendRequest.operation, envelope: { ...sendRequest.operation.envelope, content: { mode: "text", body: "한".repeat(21_846) } } },
    })).toThrow(/body.*bytes|body.*limit/i);

    const templateEnvelope = {
      v: 2,
      destination: { v: 1, kind: "destination", platform: "kakao", account: "official-app", destination_id: "friend-uuid" },
      content: { mode: "approved_template", template_id: "notice-7", arguments: {}, preview: "preview" },
    };
    const templateSend = { ...sendRequest, operation: { ...sendRequest.operation, envelope: templateEnvelope } };
    expect(() => parseWorkerRequest({ ...templateSend, operation: { ...templateSend.operation, envelope: { ...templateEnvelope, content: { ...templateEnvelope.content, template_id: "한".repeat(342) } } } })).toThrow(/template_id.*bytes|template_id.*limit/i);
    expect(() => parseWorkerRequest({ ...templateSend, operation: { ...templateSend.operation, envelope: { ...templateEnvelope, content: { ...templateEnvelope.content, preview: "한".repeat(21_846) } } } })).toThrow(/preview.*bytes|preview.*limit/i);
    expect(() => parseWorkerRequest({ ...templateSend, operation: { ...templateSend.operation, envelope: { ...templateEnvelope, content: { ...templateEnvelope.content, arguments: { blob: "x".repeat(65_530) } } } } })).toThrow(/arguments.*bytes|arguments.*limit/i);

    let tooDeep: unknown = "leaf";
    for (let depth = 0; depth < 34; depth++) tooDeep = { nested: tooDeep };
    const wideObject = Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`k${index}`, index]));
    const wideArray = Array.from({ length: 1001 }, (_, index) => index);
    const tooManyNodes = { matrix: Array.from({ length: 1000 }, () => Array.from({ length: 10 }, () => 0)) };
    const tooManyKeys = { groups: Array.from({ length: 20 }, () => Object.fromEntries(Array.from({ length: 210 }, (_, index) => [`k${index}`, 0]))) };
    for (const argumentsValue of [tooDeep, wideObject, { wideArray }, tooManyNodes, tooManyKeys]) {
      expect(() => parseWorkerRequest({
        ...templateSend,
        operation: { ...templateSend.operation, envelope: { ...templateEnvelope, content: { ...templateEnvelope.content, arguments: argumentsValue } } },
      })).toThrow(/JSON|depth|node|key|array|object|limit/i);
    }

  });

  test("keeps failed frames exclusive and marks possible sends", () => {
    const failed = {
      v: 1,
      type: "worker_response",
      request_id: "req-send-1",
      generation: 7,
      operation: "send",
      ok: false,
      error: { code: "worker_io", message: "connection lost", retryable: false, may_have_sent: true },
    } as const;
    expect(parseWorkerResponse(failed, fixture.requests.send)).toEqual(failed);
    expect(() => parseWorkerResponse({ ...failed, error: { ...failed.error, retryable: true } }, fixture.requests.send)).toThrow(/retry/i);
    expect(() => parseWorkerResponse({ ...failed, result: { outcome: "failed", reason: "duplicate" } }, fixture.requests.send)).toThrow(/result/i);
    expect(() => parseWorkerResponse({ ...failed, operation: "read_page" }, fixture.requests.send)).toThrow(/operation|may_have_sent/i);
    expect(() => parseWorkerResponse({ ...fixture.responses.send, error: failed.error }, fixture.requests.send)).toThrow(/error/i);
  });
});
