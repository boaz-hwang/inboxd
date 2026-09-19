// Synthetic JSON-line provider for Rust scheduling tests; no SDK/network access.
import { createInterface } from "node:readline";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const root = process.argv[2]!;
let calls = 0;
for await (const line of createInterface({input:process.stdin, crlfDelay:Infinity})) {
  const r = JSON.parse(line);
  appendFileSync(`${root}/calls`, `${JSON.stringify(r)}\n`);
  let result: unknown;
  switch (r.op) {
    case "kakao_metadata": result = {own_id:"7",has_details:false}; break;
    case "kakao_rooms": result = {data:["long","fast"].map(chat_id=>({chat_id,title:chat_id,type:"MultiChat",last_message:{message:"before",sent_at:1}}))}; break;
    case "kakao_page": {
      if (r.chat_id === "long" && !r.cursor) {
        writeFileSync(`${root}/entered`, "1");
        while (!existsSync(`${root}/release`)) await Bun.sleep(2);
      }
      await Bun.sleep(2);
      const i = Number(r.cursor || 0) + 1;
      const complete = r.chat_id !== "long" || i >= 12;
      result = {messages:[{id:String(i),chat_id:r.chat_id,author_id:"7",author_name:"Known",ts:i,body:`message ${i}`}],complete,next_cursor:complete ? null : String(i)};
      break;
    }
    case "kakao_send": calls++; result = {state:"Sent",receipt:`sent-${calls}`}; break;
    default: throw new Error(`Unexpected request: ${line}`);
  }
  process.stdout.write(JSON.stringify({ok:true,result})+"\n");
}
