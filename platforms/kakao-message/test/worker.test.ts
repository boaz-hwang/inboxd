import { expect, test } from "bun:test";

import {
  createKakaoMessageWorker,
  type KakaoConsentPermissionObservation,
  type KakaoHttpTransport,
  type KakaoTrustedAuthObservation,
} from "../src/worker.ts";

const limits = {
  timeout_ms: 5_000,
  max_response_bytes: 65_536,
  max_queue_depth: 8,
} as const;

function request(operation: unknown) {
  return {
    v: 1,
    type: "worker_request",
    request_id: "request-1",
    generation: 1,
    binding_id: "kakao-official",
    limits,
    operation,
  } as const;
}

const now = () => 1_726_650_100;
const trustedAuthObservation: KakaoTrustedAuthObservation = {
  source: "kakao_access_token_info",
  state: "authenticated",
  observed_at: 1_726_650_003,
};

function readyWorker(
  observation: KakaoConsentPermissionObservation = {
    talk_message_consent: "granted",
    friends_message_permission: "granted",
    observed_at: 1_726_650_003,
  },
  transport: KakaoHttpTransport = async () => {
    throw new Error("health must not use HTTP");
  },
  authObservation: KakaoTrustedAuthObservation = trustedAuthObservation,
) {
  return createKakaoMessageWorker({
    bindingId: "kakao-official",
    account: "official-app",
    recipientUuidAllowlist: ["friend-uuid"],
    templateIdAllowlist: ["notice-7"],
    observation,
    trustedAuthObservation: authObservation,
    authObservationMaxAgeSeconds: 300,
    now,
    transport,
  });
}

test("health is ready only from fresh trusted token auth plus observed consent and permission", async () => {
  const response = await readyWorker().handleRequest(request({ op: "health" }));

  expect(response).toEqual({
    v: 1,
    type: "worker_response",
    request_id: "request-1",
    generation: 1,
    operation: "health",
    ok: true,
    result: {
      state: "ready",
      auth: { state: "authenticated", reason: null, observed_at: 1_726_650_003 },
    },
  });
});

test("health degrades stale, revoked, unknown, and missing token-auth observations", async () => {
  const cases: readonly {
    readonly name: string;
    readonly authObservation?: KakaoTrustedAuthObservation;
    readonly auth: { readonly state: string; readonly reason: string; readonly observed_at: number };
  }[] = [
    {
      name: "stale",
      authObservation: {
        source: "kakao_access_token_info",
        state: "authenticated",
        observed_at: 1_726_649_799,
      },
      auth: { state: "unknown", reason: "access_token_auth_observation_stale", observed_at: 1_726_649_799 },
    },
    {
      name: "revoked",
      authObservation: {
        source: "kakao_access_token_info",
        state: "revoked",
        observed_at: 1_726_650_099,
      },
      auth: { state: "unauthenticated", reason: "access_token_revoked", observed_at: 1_726_650_099 },
    },
    {
      name: "unknown",
      authObservation: {
        source: "kakao_access_token_info",
        state: "unknown",
        observed_at: 1_726_650_099,
      },
      auth: { state: "unknown", reason: "access_token_auth_unknown", observed_at: 1_726_650_099 },
    },
    {
      name: "missing",
      auth: { state: "unknown", reason: "access_token_auth_observation_missing", observed_at: 1_726_650_100 },
    },
  ];

  for (const entry of cases) {
    const worker = createKakaoMessageWorker({
      bindingId: "kakao-official",
      account: "official-app",
      recipientUuidAllowlist: ["friend-uuid"],
      templateIdAllowlist: ["notice-7"],
      observation: {
        talk_message_consent: "granted",
        friends_message_permission: "granted",
        observed_at: 1_726_650_003,
      },
      ...(entry.authObservation === undefined ? {} : { trustedAuthObservation: entry.authObservation }),
      authObservationMaxAgeSeconds: 300,
      now,
      transport: async () => { throw new Error("health must not use HTTP"); },
    });

    await expect(worker.handleRequest(request({ op: "health" }))).resolves.toMatchObject({
      ok: true,
      result: { state: "degraded", auth: entry.auth },
    });
  }
});

test("health reports unavailable when consent or friends-message permission was not observed", async () => {
  const cases = [
    {
      observation: {
        talk_message_consent: "unknown" as const,
        friends_message_permission: "granted" as const,
        observed_at: 1_726_650_004,
      },
      auth: { state: "authenticated", reason: null, observed_at: 1_726_650_003 },
    },
    {
      observation: {
        talk_message_consent: "granted" as const,
        friends_message_permission: "denied" as const,
        observed_at: 1_726_650_005,
      },
      auth: { state: "authenticated", reason: null, observed_at: 1_726_650_003 },
    },
  ];

  for (const entry of cases) {
    const response = await readyWorker(entry.observation).handleRequest(request({ op: "health" }));
    expect(response).toMatchObject({
      ok: true,
      result: { state: "unavailable", auth: entry.auth },
    });
  }
});

test("read_page and read_receipt are fixed unsupported operations", async () => {
  const chat = { v: 1, kind: "chat", platform: "kakao", account: "local", chat_id: "room-7" } as const;
  const operations = [
    {
      op: "read_page",
      chat,
      interval: { from_ts: 1, to_ts: 2 },
      limit: 1,
      cursor: null,
    },
    {
      op: "read_receipt",
      destination: chat,
      receipt_id: "receipt-1",
      expected: {
        v: 2,
        destination: chat,
        content: { mode: "text", body: "not supported" },
      },
    },
  ] as const;

  for (const operation of operations) {
    const response = await readyWorker().handleRequest(request(operation));
    expect(response).toMatchObject({
      operation: operation.op,
      ok: false,
      error: {
        code: "unsupported",
        retryable: false,
        may_have_sent: false,
      },
    });
  }
});

test("send performs one custom-template HTTP attempt and returns only Sent acknowledgment", async () => {
  const attempts: Parameters<KakaoHttpTransport>[0][] = [];
  const transport: KakaoHttpTransport = async (httpRequest) => {
    attempts.push(httpRequest);
    return {
      status: 200,
      body: JSON.stringify({ successful_receiver_uuids: ["friend-uuid"] }),
    };
  };
  const idempotencyKey = "a".repeat(64);
  const operation = {
    op: "send",
    envelope: {
      v: 2,
      destination: {
        v: 1,
        kind: "destination",
        platform: "kakao",
        account: "official-app",
        destination_id: "friend-uuid",
      },
      content: {
        mode: "approved_template",
        template_id: "notice-7",
        arguments: { amount: 1000, label: "승인" },
        preview: "승인: 1000",
      },
    },
    idempotency_key: idempotencyKey,
  } as const;

  const response = await readyWorker(undefined, transport).handleRequest(request(operation));

  expect(attempts).toHaveLength(1);
  expect(attempts[0]).toMatchObject({
    method: "POST",
    url: "https://kapi.kakao.com/v1/api/talk/friends/message/send",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=utf-8" },
    timeout_ms: limits.timeout_ms,
  });
  const body = new URLSearchParams(attempts[0]!.body);
  expect(body.get("receiver_uuids")).toBe('["friend-uuid"]');
  expect(body.get("template_id")).toBe("notice-7");
  expect(JSON.parse(body.get("template_args")!)).toEqual({ amount: 1000, label: "승인" });
  expect(body.has("preview")).toBe(false);
  expect(response).toMatchObject({
    operation: "send",
    ok: true,
    result: { outcome: "sent", receipt_id: `kakao-api-ack:${idempotencyKey}` },
  });
  expect(JSON.stringify(response)).not.toContain("verified");
  expect(JSON.stringify(response)).not.toContain("friend-uuid");
});

test("send refuses stale, revoked, unknown, and missing trusted auth before HTTP", async () => {
  let attempts = 0;
  const transport: KakaoHttpTransport = async () => {
    attempts += 1;
    return { status: 200, body: '{"successful_receiver_uuids":["friend-uuid"]}' };
  };
  const cases: readonly {
    readonly name: string;
    readonly authObservation?: KakaoTrustedAuthObservation;
  }[] = [
    {
      name: "stale",
      authObservation: {
        source: "kakao_access_token_info",
        state: "authenticated",
        observed_at: 1_726_649_799,
      },
    },
    {
      name: "revoked",
      authObservation: {
        source: "kakao_access_token_info",
        state: "revoked",
        observed_at: 1_726_650_099,
      },
    },
    {
      name: "unknown",
      authObservation: {
        source: "kakao_access_token_info",
        state: "unknown",
        observed_at: 1_726_650_099,
      },
    },
    { name: "missing" },
  ];
  const responses = [];

  for (const entry of cases) {
    const worker = createKakaoMessageWorker({
      bindingId: "kakao-official",
      account: "official-app",
      recipientUuidAllowlist: ["friend-uuid"],
      templateIdAllowlist: ["notice-7"],
      observation: {
        talk_message_consent: "granted",
        friends_message_permission: "granted",
        observed_at: 1_726_650_003,
      },
      ...(entry.authObservation === undefined ? {} : { trustedAuthObservation: entry.authObservation }),
      authObservationMaxAgeSeconds: 300,
      now,
      transport,
    });
    responses.push({
      name: entry.name,
      response: await worker.handleRequest(request(templateSendOperation())),
    });
  }

  expect(attempts).toBe(0);
  for (const entry of responses) {
    expect(entry.response).toMatchObject({
      operation: "send",
      ok: false,
      error: {
        code: "authentication_unavailable",
        retryable: false,
        may_have_sent: false,
      },
    });
  }
});

test("send refuses missing consent, scope drift, template mutation, free text, and replies before HTTP", async () => {
  let attempts = 0;
  const transport: KakaoHttpTransport = async () => {
    attempts += 1;
    return { status: 200, body: '{"successful_receiver_uuids":["friend-uuid"]}' };
  };
  const idempotencyKey = "b".repeat(64);
  const templateOperation = () => ({
    op: "send",
    envelope: {
      v: 2,
      destination: {
        v: 1,
        kind: "destination",
        platform: "kakao",
        account: "official-app",
        destination_id: "friend-uuid",
      },
      content: {
        mode: "approved_template",
        template_id: "notice-7",
        arguments: { amount: 1000 },
        preview: "승인: 1000",
      },
    },
    idempotency_key: idempotencyKey,
  });

  const noConsent = await readyWorker({
    talk_message_consent: "unknown",
    friends_message_permission: "granted",
    observed_at: 1_726_650_004,
  }, transport).handleRequest(request(templateOperation()));
  expect(noConsent).toMatchObject({ ok: false, error: { code: "access_not_observed", may_have_sent: false } });

  const wrongRecipient = templateOperation();
  wrongRecipient.envelope.destination.destination_id = "not-allowlisted";
  const changedTemplate = templateOperation();
  changedTemplate.envelope.content.template_id = "notice-8";
  const textEnvelope = {
    op: "send",
    envelope: {
      v: 2,
      destination: { v: 1, kind: "chat", platform: "kakao", account: "official-app", chat_id: "room-7" },
      content: { mode: "text", body: "unapproved free text" },
    },
    idempotency_key: idempotencyKey,
  };
  const replyEnvelope = {
    ...textEnvelope,
    envelope: { ...textEnvelope.envelope, reply: { parent_id: "message-1" } },
  };
  const invalid = [
    { operation: wrongRecipient, code: "scope_denied" },
    { operation: changedTemplate, code: "template_not_allowed" },
    { operation: textEnvelope, code: "free_text_unsupported" },
    { operation: replyEnvelope, code: "reply_unsupported" },
  ];

  for (const entry of invalid) {
    const response = await readyWorker(undefined, transport).handleRequest(request(entry.operation));
    expect(response).toMatchObject({
      ok: false,
      error: { code: entry.code, retryable: false, may_have_sent: false },
    });
  }
  expect(attempts).toBe(0);
});

function templateSendOperation(idempotencyKey = "c".repeat(64)) {
  return {
    op: "send",
    envelope: {
      v: 2,
      destination: {
        v: 1,
        kind: "destination",
        platform: "kakao",
        account: "official-app",
        destination_id: "friend-uuid",
      },
      content: {
        mode: "approved_template",
        template_id: "notice-7",
        arguments: { amount: 1000 },
        preview: "승인: 1000",
      },
    },
    idempotency_key: idempotencyKey,
  } as const;
}

test("classifies explicit Kakao API and quota rejections as definite non-retryable failures", async () => {
  const cases = [
    {
      status: 400,
      body: JSON.stringify({ code: -2, msg: "invalid template arguments" }),
      code: "api_rejected",
    },
    {
      status: 400,
      body: JSON.stringify({ code: -502, msg: "recipient is not a friend" }),
      code: "api_rejected",
    },
    {
      status: 400,
      body: JSON.stringify({ code: -530, msg: "recipient refused messages" }),
      code: "api_rejected",
    },
    {
      status: 400,
      body: JSON.stringify({ code: -10, msg: "API limit has been exceeded." }),
      code: "quota_exceeded",
    },
    {
      status: 429,
      body: JSON.stringify({ code: -532, msg: "daily message limit per sender has been exceeded." }),
      code: "quota_exceeded",
    },
    {
      status: 400,
      body: JSON.stringify({ code: -533, msg: "daily message limit per recipient has been exceeded." }),
      code: "quota_exceeded",
    },
    {
      status: 400,
      body: JSON.stringify({ code: -536, msg: "daily sender/recipient pair limit has been exceeded." }),
      code: "quota_exceeded",
    },
  ] as const;

  for (const entry of cases) {
    let attempts = 0;
    const response = await readyWorker(undefined, async () => {
      attempts += 1;
      return { status: entry.status, body: entry.body };
    }).handleRequest(request(templateSendOperation()));

    expect(response).toMatchObject({
      operation: "send",
      ok: false,
      error: {
        code: entry.code,
        retryable: false,
        may_have_sent: false,
      },
    });
    expect(attempts).toBe(1);
  }
});

test("keeps unknown, malformed, and non-definitive Kakao 4xx bodies ambiguous after dispatch", async () => {
  const cases = [
    { name: "empty body", status: 400, body: "" },
    { name: "malformed JSON", status: 400, body: "{not-json" },
    { name: "missing error fields", status: 400, body: "{}" },
    { name: "non-numeric code", status: 400, body: JSON.stringify({ code: "-2", msg: "invalid" }) },
    { name: "missing message", status: 400, body: JSON.stringify({ code: -2 }) },
    { name: "unknown Kakao code", status: 400, body: JSON.stringify({ code: -99_999, msg: "future error" }) },
    { name: "processing timeout", status: 400, body: JSON.stringify({ code: -603, msg: "processing timed out" }) },
    { name: "status-only quota", status: 429, body: "not a Kakao error body" },
  ] as const;

  for (const entry of cases) {
    let attempts = 0;
    const response = await readyWorker(undefined, async () => {
      attempts += 1;
      return { status: entry.status, body: entry.body };
    }).handleRequest(request(templateSendOperation()));

    expect(response).toMatchObject({
      operation: "send",
      ok: false,
      error: {
        code: "send_ambiguous",
        retryable: false,
        may_have_sent: true,
      },
    });
    if (entry.body.length > 0) expect(JSON.stringify(response)).not.toContain(entry.body);
    expect(attempts).toBe(1);
  }
});

test("marks timeout, EOF, server failure, oversized response, and malformed acknowledgement ambiguous without retry", async () => {
  const cases: { readonly name: string; readonly transport: KakaoHttpTransport }[] = [
    {
      name: "timeout",
      transport: async () => { throw new DOMException("aborted", "AbortError"); },
    },
    {
      name: "EOF",
      transport: async () => { throw new Error("unexpected EOF"); },
    },
    {
      name: "server failure",
      transport: async () => ({ status: 503, body: '{"code":-1,"msg":"maintenance"}' }),
    },
    {
      name: "oversized response",
      transport: async () => ({ status: 200, body: "x".repeat(limits.max_response_bytes + 1) }),
    },
    {
      name: "malformed acknowledgement",
      transport: async () => ({ status: 200, body: '{"successful_receiver_uuids":[]}' }),
    },
  ];

  for (const entry of cases) {
    let attempts = 0;
    const response = await readyWorker(undefined, async (httpRequest) => {
      attempts += 1;
      return entry.transport(httpRequest);
    }).handleRequest(request(templateSendOperation()));

    expect(response).toMatchObject({
      operation: "send",
      ok: false,
      error: {
        code: "send_ambiguous",
        retryable: false,
        may_have_sent: true,
      },
    });
    expect(JSON.stringify(response)).not.toContain("friend-uuid");
    expect(attempts).toBe(1);
  }
});

test("binding mismatch is a definite refusal and never reaches HTTP", async () => {
  let attempts = 0;
  const value = request(templateSendOperation()) as { binding_id: string };
  value.binding_id = "other-binding";

  const response = await readyWorker(undefined, async () => {
    attempts += 1;
    return { status: 200, body: '{"successful_receiver_uuids":["friend-uuid"]}' };
  }).handleRequest(value);

  expect(response).toMatchObject({
    ok: false,
    error: { code: "binding_mismatch", retryable: false, may_have_sent: false },
  });
  expect(attempts).toBe(0);
});

test("snapshots and validates fixed configuration before serving requests", async () => {
  const recipients = ["friend-uuid"];
  const templates = ["notice-7"];
  const worker = createKakaoMessageWorker({
    bindingId: "kakao-official",
    account: "official-app",
    recipientUuidAllowlist: recipients,
    templateIdAllowlist: templates,
    observation: {
      talk_message_consent: "granted",
      friends_message_permission: "granted",
      observed_at: 1_726_650_003,
    },
    trustedAuthObservation,
    authObservationMaxAgeSeconds: 300,
    now,
    transport: async () => ({ status: 200, body: '{"successful_receiver_uuids":["friend-uuid"]}' }),
  });
  recipients[0] = "mutated-recipient";
  templates[0] = "mutated-template";

  await expect(worker.handleRequest(request(templateSendOperation()))).resolves.toMatchObject({
    ok: true,
    result: { outcome: "sent" },
  });
  expect(() => createKakaoMessageWorker({
    bindingId: "kakao-official",
    account: "official-app",
    recipientUuidAllowlist: ["duplicate", "duplicate"],
    templateIdAllowlist: ["notice-7"],
    observation: {
      talk_message_consent: "granted",
      friends_message_permission: "granted",
      observed_at: 1,
    },
    authObservationMaxAgeSeconds: 300,
    transport: async () => ({ status: 200, body: "{}" }),
  })).toThrow(/allowlist|duplicate/i);
});
