/** Authentication responses stay bounded and never appear in parse errors. */
export async function readConnectionResponse(response: Response): Promise<Record<string, any>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("계정 확인 응답이 비어 있습니다.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 1_048_576) { await reader.cancel(); throw new Error("계정 확인 응답이 너무 큽니다."); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  try {
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error();
    return result as Record<string, unknown>;
  } catch { throw new Error("계정 확인 응답 형식이 올바르지 않습니다."); }
}
