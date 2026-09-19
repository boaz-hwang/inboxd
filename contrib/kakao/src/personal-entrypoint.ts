import { encodeJsonLine, parseWorkerRequestFrame, PROTOCOL_LIMITS } from "../../../packages/protocol/src/index.ts";
import { personalSession, parsePersonalCredentials } from "./personal-session.ts";
import { createPersonalWorker } from "./personal-worker.ts";

async function main(): Promise<void> {
  const env = process.env;
  const credentials = parsePersonalCredentials(JSON.parse(env.INBOXD_KAKAO_PERSONAL_CREDENTIALS ?? "null"));
  delete env.INBOXD_KAKAO_PERSONAL_CREDENTIALS;
  const binding = { bindingId: env.INBOXD_KAKAO_PERSONAL_BINDING!, account: env.INBOXD_KAKAO_PERSONAL_ACCOUNT!, chatId: env.INBOXD_KAKAO_PERSONAL_CHAT!, selfId: credentials.userId };
  if (!binding.bindingId || binding.account !== `kakao:self:${credentials.userId}` || !/^[1-9]\d*$/.test(binding.chatId)) throw new Error("configuration");
  const client = await personalSession(credentials);
  const worker = createPersonalWorker(binding, client);
  let pending = Buffer.alloc(0);
  try {
    for await (const chunk of Bun.stdin.stream()) {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > PROTOCOL_LIMITS.worker_frame_bytes) throw new Error("frame limit");
      const newline = pending.indexOf(10);
      if (newline < 0) continue;
      const request = parseWorkerRequestFrame(pending.subarray(0, newline));
      const response = await worker.handle(request);
      await Bun.write(Bun.stdout, encodeJsonLine(response, request.limits.max_response_bytes));
      return; // One supervised process owns exactly one operation and session.
    }
    throw new Error("incomplete frame");
  } finally { client.close(); }
}
if (import.meta.main) main().catch(() => { process.stderr.write("Kakao personal worker failed\n"); process.exitCode = 74; });
