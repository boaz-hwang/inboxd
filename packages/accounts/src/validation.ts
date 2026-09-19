import schema from "../schema/primitives.json";
import type { AccountRequest, PrimitiveRequest, ResultFor } from "./generated.ts";
type Shape = string | { fields: Record<string, Shape> } | { optional: Shape } | { array: Shape } | { enum: string[] } | { union: Shape[] };
const definitions = schema as unknown as {types: Record<string, Shape>; operations: Record<string, {request: Shape; result: Shape}>};
const writes = new Set(["kakao_send", "telegram_send", "slack.chat.postMessage", "slack_send_file", "kakao_send_file", "telegram_send_file"]);
function check(shape: Shape, value: unknown, strict: boolean): void {
  if (typeof shape === "string") {
    if (shape in definitions.types) return check(definitions.types[shape]!, value, strict);
    if (shape === "nonempty" ? typeof value !== "string" || value.length === 0
      : shape === "file_size" ? !Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 104857600
      : shape === "integer" ? !Number.isSafeInteger(value) || (value as number) < (strict ? 1 : 0) || (strict && (value as number) > 20000)
      : shape === "number" ? typeof value !== "number" || !Number.isFinite(value)
      : typeof value !== shape) throw new Error("invalid primitive field");
    if (typeof value === "string" && strict && Buffer.byteLength(value) > 16000) throw new Error("primitive field limit");
    return;
  }
  if ("optional" in shape) { if (value != null) check(shape.optional,value,strict); return; }
  if ("enum" in shape) { if (!shape.enum.includes(value as string)) throw new Error("invalid primitive enum"); return; }
  if ("union" in shape) {
    for (const member of shape.union) { try { check(member,value,strict); return; } catch {} }
    throw new Error("invalid primitive union");
  }
  if ("array" in shape) {
    if (!Array.isArray(value) || value.length > 20000) throw new Error("invalid primitive array");
    for (const item of value) check(shape.array,item,strict);
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid primitive object");
  const object = value as Record<string,unknown>;
  if (strict && Object.keys(object).some(k => !Object.hasOwn(shape.fields,k))) throw new Error("unknown primitive field");
  for (const [key, member] of Object.entries(shape.fields)) check(member,object[key],strict);
}
export function parseRequest(value: unknown): AccountRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid primitive");
  const {op,...fields} = value as Record<string,unknown>;
  if (op === "batch") {
    if (Object.keys(fields).length !== 1 || !Array.isArray(fields.requests) || fields.requests.length < 1 || fields.requests.length > 8) throw new Error("invalid read batch");
    const requests = fields.requests.map(parseRequest);
    if (requests.some(r => r.op === "batch" || writes.has(r.op)) || new Set(requests.map(r => r.op.split(/[._]/)[0])).size !== 1) throw new Error("invalid read batch");
  } else {
    if (typeof op !== "string" || !Object.hasOwn(definitions.operations,op)) throw new Error("unsupported primitive");
    check(definitions.operations[op]!.request,fields,true);
  }
  return value as AccountRequest;
}
export function parseResult<R extends PrimitiveRequest>(request: R, value: unknown): ResultFor<R> {
  // Additive vendor fields are allowed; every field used by the daemon is checked.
  check(definitions.operations[request.op]!.result,value,false);
  return value as ResultFor<R>;
}

export function parseResponse<R extends AccountRequest>(request: R, value: unknown): ResultFor<R> {
  if (request.op !== "batch") return parseResult(request,value) as ResultFor<R>;
  const results = (value as { results?: unknown } | null)?.results;
  if (!Array.isArray(results) || results.length !== request.requests.length) throw new Error("primitive batch result length");
  request.requests.forEach((r,i) => parseResult(r,results[i]));
  return value as ResultFor<R>;
}
