import { runKakaoLocalReadWorker } from "../../src/worker-entrypoint.ts";

const chat = {
  v: 1,
  kind: "chat",
  platform: "kakao",
  account: "stable:kakao_account_alpha",
  chat_id: "stable:kakao_chat_alpha",
} as const;

async function main(): Promise<void> {
  await runKakaoLocalReadWorker({
    binding_id: "kakao-local-alpha",
    allowed_chat: chat,
    measurement: {
      schema_version: "kakao-contrib-read-measurement/v1",
      kind: "kakao-read-field-measurement",
      status: "VALIDATED",
      observation: "observed",
      source: "authorized-live-measurement",
      observed_at: 900,
      send: false,
      supported_read_fields: ["account_id", "chat_id", "message_id", "author_id", "ts", "body", "revision"],
    },
    max_measurement_age: 200,
    max_items: 1,
    max_raw_bytes: 65_536,
    now: () => 1_000,
    reader: async (request) => {
      if (request.interval.from_ts === 30) throw new Error("private fixed-reader failure");
      return [{
        account_id: request.account,
        chat_id: request.chat_id,
        message_id: "11",
        author_id: "7",
        ts: request.interval.from_ts + 1,
        body: "한🙂",
        revision: "11",
      }];
    },
  });
}

if (import.meta.main) await main();
