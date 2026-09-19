import { expect, test } from "bun:test";
import { KakaoTalkClient } from "agent-messenger/kakaotalk";

test("full directory refresh ignores even a complete fresh-login snapshot", async () => {
  const client = new KakaoTalkClient();
  const calls: string[][] = [];
  let revision = 0;
  // Exercise the installed, patched SDK's real getChats conversion. Only the
  // protocol session is synthetic: a stale login snapshot must never win.
  (client as any).oauthToken = "synthetic";
  (client as any).state = {
    needsChatListBootstrap: false,
    loginResult: { eof: true, chatDatas: [{ c: 1, t: 1, k: ["old"], i: [7], a: 1, n: 0, o: 1 }] },
    session: {
      async getChatList(token: { toString(): string }, chat: { toString(): string }) {
        calls.push([token.toString(), chat.toString()]);
        revision++;
        return { statusCode: 0, body: { status: 0, eof: true, chatDatas: [{ c: 2, t: 1, k: ["new"], i: [7], a: 1, n: 0, o: revision, l: { authorId: 7, message: `v${revision}`, sendAt: revision } }] } };
      },
      close() {},
    },
  };
  const first = await client.getChats({ all: true, resolveTitles: false });
  const second = await client.getChats({ all: true, resolveTitles: false });
  expect(first.map(c => c.chat_id)).toEqual(["2"]);
  expect(first[0]!.last_message?.message).toBe("v1");
  expect(second[0]!.last_message?.message).toBe("v2");
  expect(calls).toEqual([["0", "0"], ["0", "0"]]);
  client.close();
});
