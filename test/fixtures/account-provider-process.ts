import { existsSync } from "node:fs";
import { join } from "node:path";
// Synthetic SDK ports only. Exercises the production thin adapters and dispatcher
// over the same JSON-lines transport used by the Rust daemon, without networking.
import { createInterface } from "node:readline";
import { dispatch } from "../../packages/accounts/src/dispatch.ts";
import { createSlackAccount } from "../../platforms/slack/src/account.ts";
import { createKakaoAccount } from "../../contrib/kakao/src/account.ts";
import { createTelegramAdapter } from "../../platforms/telegram/src/account.ts";
import type { AccountAdapter } from "../../packages/accounts/src/contracts.ts";

const platform = process.argv[2];
let sends = 0;
const send = (body: unknown) => {
  sends++;
  if (body === "ambiguous") throw new Error("synthetic lost acknowledgement");
  return `sent-${sends}`;
};
const messages = (n = 100) => Array.from({length:n + (process.argv[3] && existsSync(join(process.argv[3], "new-message")) ? 1 : 0)}, (_, i) => ({
  id:String(i+1), chat_id:"1", author_id:"7", author_name:"실제 이름", ts:i+1, body:`needle ${i+1} ${"가".repeat(400)}`,
}));
let adapter: AccountAdapter;
if (platform === "slack") {
  adapter = createSlackAccount({bot_token:"synthetic"}, (async (url: string, init: RequestInit) => {
    const method = String(url).split("/").at(-1)!;
    if (String(url).startsWith("https://files.slack.com/")) return new Response("");
    const params = new URLSearchParams(String(init.body));
    let result: Record<string, unknown>;
    switch (method) {
      case "files.getUploadURLExternal": result = {upload_url:"https://files.slack.com/upload/test",file_id:"F1"}; break;
      case "files.completeUploadExternal": send("file"); result = {files:[{id:"F1"}]}; break;
      case "users.list": result = {members:[{id:"7",name:"실제 이름"}]}; break;
      case "users.info": result = {user:{name:"실제 이름"}}; break;
      case "conversations.list": result = {channels:[{id:"1",is_member:true,name:"원래 방 이름"}]}; break;
      case "client.counts": result = {}; break;
      case "conversations.history": result = {messages:messages(params.get("limit") === "1" ? 1 : 30).reverse().map(m=>({ts:String(m.ts),user:m.author_id,text:m.body})),has_more:false}; break;
      case "search.messages": {
        const paged = params.get("query") === "paged";
        const rows = paged ? messages(2).slice(Number(params.get("page"))-1, Number(params.get("page"))) : messages();
        result = {messages:{matches:rows.map(m=>({ts:String(m.ts),user:m.author_id,text:m.body,channel:{id:"1"}})),pagination:{page_count:paged ? 2 : 1}}}; break;
      }
      case "chat.postMessage": result = {ts:send(params.get("text")),message:{user:"7",text:params.get("text")}}; break;
      default: throw new Error(`unexpected synthetic method ${method}`);
    }
    return Response.json({ok:true,...result});
  }) as typeof fetch);
} else if (platform === "kakao") {
  adapter = await createKakaoAccount({userId:"7"} as never, {
    async getChats() { return [{chat_id:"1",title:"원래 방 이름",last_message:{sent_at:100,message:"latest"}}]; },
    async getMessagePage(_: string, options: {from?:string}) { return {messages:messages().slice(options.from ? 50 : 0, options.from ? undefined : 50).map(m=>({log_id:m.id,author_id:7,author_name:m.author_name,sent_at:m.ts,message:m.body})),complete:!!options.from,...(!options.from ? {next_cursor:"50"} : {})}; },
    async getMembersByIds() { return [{user_id:"7",nickname:"실제 이름"}]; },
    async getMembers() { return [{user_id:"7",nickname:"실제 이름"}]; },
    async sendFile(_: string, bytes: Buffer) { if (bytes.toString() !== "abc") throw new Error("wrong bytes"); return {success:true,log_id:send("file")}; },
    async sendMessage(_: string, body: string) { return {success:true,log_id:send(body)}; },
    close() {},
  } as never);
} else if (platform === "telegram") {
  const tdMessages = (n: number) => messages(n).reverse().map(m=>({id:Number(m.id),chat_id:1,sender_id:{user_id:7},date:m.ts,content:{text:{text:m.body}}}));
  adapter = createTelegramAdapter({
    async accountQuery(req: Record<string, unknown>) {
      switch (req._) {
        case "loadChats": throw Object.assign(new Error("end"), {code:404});
        case "getChats": return {chat_ids:[1]};
        case "getChat": return {id:1,title:"원래 방 이름",permissions:{can_send_basic_messages:true}};
        case "getUser": return {first_name:"실제 이름"};
        case "searchMessages": {
          if (req.query === "repeat") return {messages:tdMessages(1),next_offset:"loop"};
          if (req.query === "paged") return {messages:[tdMessages(2)[req.offset ? 1 : 0]],next_offset:req.offset ? "" : "older"};
          return {messages:tdMessages(100),next_offset:""};
        }
        default: throw new Error(`unexpected synthetic query ${req._}`);
      }
    },
    async getChatHistory() { return tdMessages(30); },
    async sendDocumentMessage(req: {path:string}) { if (await Bun.file(req.path).text() !== "abc") throw new Error("wrong bytes"); return {...tdMessages(1)[0],id:send("file")}; },
    async sendTextMessage(req: {text:string}) { const receipt=send(req.text); return {...tdMessages(1)[0],id:receipt}; },
    close() {},
  } as never);
} else throw new Error("synthetic platform required");

for await (const line of createInterface({input:process.stdin,crlfDelay:Infinity})) {
  try { process.stdout.write(JSON.stringify({ok:true,result:await dispatch(adapter,JSON.parse(line))})+"\n"); }
  catch { process.stdout.write(JSON.stringify({ok:false,error:"synthetic failure"})+"\n"); }
}
await adapter.close();
