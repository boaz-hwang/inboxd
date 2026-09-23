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

test("personal room names override shared titles and member names in directory and detail", async () => {
  const client = new KakaoTalkClient();
  (client as any).oauthToken = "synthetic";
  const info = { chatId: 2, type: "MultiChat", activeMembersCount: 3,
    newMessageCount: 1, lastLogId: 9, meta: { name: "가족" },
    displayMembers: [{ userId: 7, nickName: "참여자" }],
    chatMetas: [{ type: 3, content: "공유 이름" }] };
  (client as any).state = { loginResult: {}, session: {
    async getChatList() { return { statusCode: 0, body: { eof: true,
      chatDatas: [{ c: 2, t: "MultiChat", k: ["참여자"], a: 3, n: 1, m: '{"name":"가족"}' }] } }; },
    async getChannelInfo() { return { statusCode: 0, body: { chatInfo: info } }; },
    close() {},
  } };
  expect((await client.getChats({ all: true }))[0]?.title).toBe("가족");
  expect((await client.getChat("2")).title).toBe("가족");
  expect(await client.getChatTitle("2")).toBe("가족");
  info.meta.name = "";
  expect((await client.getChat("2")).title).toBe("공유 이름");
  client.close();
});


test("current CHATINFO mcMetas JSON carries the personal title when directory m is null", async () => {
  const client = new KakaoTalkClient();
  (client as any).oauthToken = "synthetic";
  const info = { chatId: 2, type: "MultiChat", activeMembersCount: 3, newMessageCount: 1,
    lastLogId: 9, mcMetas: '{"name":"가족"}', chatMetas: [{ type: 3, content: "공유 이름" }] };
  (client as any).state = { loginResult: {}, session: {
    async getChatList() { return { statusCode: 0, body: { eof: true,
      chatDatas: [{ c: 2, t: "MultiChat", k: ["참여자"], a: 3, n: 1, m: null }] } }; },
    async getChannelInfo() { return { statusCode: 0, body: { chatInfo: info } }; }, close() {},
  } };
  expect((await client.getChats({ all: true, resolveTitles: true }))[0]?.title).toBe("가족");
  expect((await client.getChat("2")).title).toBe("가족");
  expect(await client.getChatTitle("2")).toBe("가족");
  info.mcMetas = '{"name":""}';
  expect((await client.getChat("2")).title).toBe("공유 이름");
  info.mcMetas = 'malformed';
  expect((await client.getChat("2")).title).toBe("공유 이름");
  client.close();
});
