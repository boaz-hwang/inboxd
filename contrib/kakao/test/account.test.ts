import { dispatch, dispatchWire } from "../../../packages/accounts/src/dispatch.ts";
import { expect, test } from "bun:test";
import { createKakaoAccount } from "../src/account.ts";
import type { PersonalCredentials } from "../src/personal-session.ts";

test("page primitive performs one provider read and preserves empty names without policy", async () => {
  const calls: unknown[]=[];
  const adapter=await createKakaoAccount({ userId:"self" } as PersonalCredentials, {
    async getMessagePage(chat: string, options: unknown) { calls.push([chat,options]); return { messages:[{log_id:"1",author_id:7,message:"body",sent_at:1}],complete:false,next_cursor:"1" }; },
    async getMembersByIds() { throw new Error("name policy belongs to Rust"); }, close() {},
  } as never);
  const result=await dispatch(adapter, {op:"kakao_page",chat_id:"r",cursor:"0",limit:100});
  expect(calls).toEqual([["r",{count:100,from:"0"}]]);
  expect(result).toEqual({messages:[{id:"1",chat_id:"r",author_id:"7",author_name:"",ts:1,body:"body"}],complete:false,next_cursor:"1"});
  await dispatch(adapter, {op:"kakao_page",chat_id:"r"}); expect(calls).toHaveLength(2);
  await expect(dispatchWire(adapter, {op:"search",query:"body"})).rejects.toThrow("unsupported primitive");
  await adapter.close();
});

test("metadata excludes credentials and directory/detail/member calls obey Rust requests", async () => {
  let titleResolution: unknown;
  const adapter=await createKakaoAccount({userId:"7",accessToken:"secret"} as unknown as PersonalCredentials, {
    async getChats(options: unknown) { titleResolution=options; return [{chat_id:"self",type:"MemoChat"}]; },
    async getChat(id:string) { return {chat_id:id,type:"MemoChat",display_name:"이름"}; },
    async getMembersByIds(_:string, ids:string[]) { return ids.map(user_id=>({user_id,nickname:"이름"})); },
    async getMembers() { return [{user_id:"7",nickname:"내 이름"}]; }, close() {},
  } as never);
  expect(await dispatch(adapter, {op:"kakao_metadata"})).toEqual({own_id:"7",has_details:true});
  await dispatch(adapter, {op:"kakao_rooms",params:{resolve_titles:false}});
  expect(titleResolution).toEqual({all:true,resolveTitles:false});
  expect((await dispatch(adapter, {op:"kakao_detail",chat_id:"self"})).data).toEqual({chat_id:"self",type:"MemoChat",display_name:"이름"});
  expect((await dispatch(adapter, {op:"kakao_members",chat_id:"r",ids:["7"]})).data).toEqual([{user_id:"7",nickname:"이름"}]);
  expect((await dispatch(adapter, {op:"kakao_self_members",chat_id:"self"})).data).toEqual([{user_id:"7",nickname:"내 이름"}]);
});

test("send is a single SDK invocation with rejection propagated", async () => {
  let sends=0;
  const adapter=await createKakaoAccount({userId:"7"} as PersonalCredentials, {
    async sendMessage() { sends++; return {success:sends===1,log_id:"receipt"}; }, close() {},
  } as never);
  expect(await dispatch(adapter, {op:"kakao_send",chat_id:"r",body:"hello"})).toEqual({state:"Sent",receipt:"receipt"});
  await expect(dispatch(adapter, {op:"kakao_send",chat_id:"r",body:"hello"})).rejects.toThrow("전송 거부");
  expect(sends).toBe(2);
});

test("mark-read is scoped to the exact chat/cursor and supplies open-chat link id", async () => {
  const calls: unknown[]=[];
  const adapter=await createKakaoAccount({userId:"7"} as PersonalCredentials, {
    async getChat(chatId:string) { return {chat_id:chatId,type:"OM",open_link_id:"777"}; },
    async markRead(chatId:string,messageId:string,options:unknown) { calls.push([chatId,messageId,options]); return {success:true,watermark:messageId}; },
    close() {},
  } as never);
  expect(await dispatch(adapter,{op:"kakao_mark_read",chat_id:"123",message_id:"456"})).toEqual({state:"Marked",message_id:"456"});
  expect(calls).toEqual([["123","456",{linkId:"777"}]]);
});

test("mark-read rejects a provider ACK that fails readback verification", async () => {
  const adapter=await createKakaoAccount({userId:"7"} as PersonalCredentials, {
    async getChat(chatId:string) { return {chat_id:chatId,type:"PlusChat",open_link_id:null}; },
    async markRead(_chatId:string,messageId:string) { return {success:false,status_code:0,watermark:messageId}; },
    close() {},
  } as never);
  await expect(dispatch(adapter,{op:"kakao_mark_read",chat_id:"123",message_id:"456"})).rejects.toThrow("KakaoTalk read receipt rejected");
});

test("push and reconnect share the existing Kakao session and detach on stop", async () => {
  let push: ((packet: any) => void) | undefined;
  let state: ((event: any) => void) | undefined;
  const events: unknown[] = [];
  const adapter = await createKakaoAccount({ userId: "7" } as PersonalCredentials, {
    onPush(fn: typeof push) { push = fn; return () => { push = undefined; }; },
    onSessionEvent(fn: typeof state) { state = fn; return () => { state = undefined; }; },
    isConnected: () => true,
    close() {},
  } as never);
  const stop = await adapter.listen!(event => events.push(event));
  push!({ method: "PING" });
  push!({ method: "NOTIREAD", body: { userId: "another user", chatId: "r", watermark: "10" } });
  push!({ method: "MSG", body: { private: "never forwarded" } });
  state!({ type: "kicked", reason: "private provider error" });
  state!({ type: "connected" });
  expect(events).toEqual([{ event: "state", state: "connected" }, { event: "changed" }, { event: "changed" }, { event: "state", state: "disconnected" }, { event: "state", state: "connected" }]);
  stop();
  expect(push).toBeUndefined();
  expect(state).toBeUndefined();
});
