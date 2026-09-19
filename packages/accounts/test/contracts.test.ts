import { expect, test } from "bun:test";
import fixtures from "../schema/parity-fixtures.json";
import schema from "../schema/primitives.json";
import { parseRequest, parseResponse } from "../src/validation.ts";
import { dispatch, dispatchWire } from "../src/dispatch.ts";

test("checked-in Rust and TS declarations match their one wire schema", () => {
  const result = Bun.spawnSync(["bun","scripts/generate-account-contract.ts","--check"], {cwd:new URL("../../../",import.meta.url).pathname});
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});
for (const fixture of fixtures) test(`wire parity: ${fixture.name}`, () => {
  if (!fixture.request_valid) {
    expect(() => parseRequest(fixture.request)).toThrow();
    return;
  }
  const request = parseRequest(fixture.request);
  if (fixture.result_valid) expect(() => parseResponse(request,fixture.result)).not.toThrow();
  else expect(() => parseResponse(request,fixture.result)).toThrow();
});
test("parity fixtures cover every primitive operation", () => {
  expect(Object.keys(schema.operations).every(op=>fixtures.some(f=>f.name===op))).toBe(true);
});
test("invalid nested batch request causes zero calls; malformed nested response rejected", async () => {
  let calls=0;
  const adapter={close(){},async run(){calls++;return {messages:[{id:"1"}],complete:true};}};
  await expect(dispatchWire(adapter,{op:"batch",requests:[{op:"kakao_page",chat_id:"r"},{op:"kakao_members",chat_id:"r",ids:[42]}]})).rejects.toThrow();
  expect(calls).toBe(0);
  await expect(dispatch(adapter,{op:"kakao_page",chat_id:"r"})).rejects.toThrow();
  expect(calls).toBe(1);
});
test("integral JSON lexical forms agree with the Rust decoder", () => {
  for (const integer of ["1", "1.0", "1e0"]) {
    const request = JSON.parse(`{"op":"telegram_history","chat_id":"1","limit":${integer}}`);
    expect(parseRequest(request)).toEqual({op:"telegram_history",chat_id:"1",limit:1});
  }
});
