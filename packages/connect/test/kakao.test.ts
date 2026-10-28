import { expect, test } from "bun:test";
import { verifyKakaoConnection } from "../src/drivers/kakao.ts";

function session(types = ["MultiChat", "MemoChat"]) {
  const reads: unknown[] = [];
  const client = {
    getChats: async (options: unknown) => {
      reads.push(options);
      return types.map((type, i) => ({ type, chat_id: String(100 + i) }));
    },
    getMessagePage: async (id: string, options: unknown) => {
      reads.push({ id, options });
      return { messages: [], complete: true };
    },
    getCredentials: () => ({ synthetic: "test-only" }),
  } as unknown as Parameters<typeof verifyKakaoConnection>[0];
  return { client, reads };
}

test("Kakao connects without a room picker and probes the self chat, not the first room", async () => {
  const { client, reads } = session();
  const reports: string[] = [];
  const result = await verifyKakaoConnection(client, "test-account", { report: message => reports.push(message) });
  expect(reads).toEqual([{ all: true, resolveTitles: false }, { id: "101", options: { count: 1 } }]);
  expect(result.chat_id).toBe("101");
  expect(result.account).toBe("kakao:self:test-account");
  expect(reports).toEqual(["KakaoTalk 연결을 확인했습니다. 전체 대화 목록을 불러옵니다."]);
});

test("Kakao does not silently pick another room when the self identity is missing or ambiguous", async () => {
  for (const types of [["MultiChat"], ["MemoChat", "MemoChat"]]) {
    const { client, reads } = session(types);
    await expect(verifyKakaoConnection(client, "test-account", { report: () => { throw new Error("must not report success"); } })).rejects.toThrow("나와의 채팅");
    expect(reads).toHaveLength(1);
  }
});

test("Kakao does not report a successful connection when the automatic read fails", async () => {
  const { client } = session();
  client.getMessagePage = async () => { throw new Error("read denied"); };
  const reports: string[] = [];
  await expect(verifyKakaoConnection(client, "test-account", { report: message => reports.push(message) })).rejects.toThrow("read denied");
  expect(reports).toEqual([]);
});
