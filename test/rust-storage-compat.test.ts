import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coreCall } from "../packages/native/src/index.ts";
import { openSqlCipherDatabase } from "../packages/store/src/index.ts";

const root = join(import.meta.dir, "..");
const env = { ...process.env, SQLCIPHER_LIB_DIR: "/opt/homebrew/opt/sqlcipher/lib", SQLCIPHER_INCLUDE_DIR: "/opt/homebrew/opt/sqlcipher/include", PKG_CONFIG_PATH: "/opt/homebrew/opt/sqlcipher/lib/pkgconfig" };
const key = new Uint8Array(32).fill(42);
function native(path: string, calls: { op: string; input: unknown }[]): any[] {
  const child = Bun.spawnSync({ cmd: [join(process.env.HOME!, ".cargo/bin/cargo"), "run", "--quiet", "-p", "inboxd-storage", "--example", "compat"], cwd: root, env, stdin: new TextEncoder().encode(JSON.stringify({ path, calls })), stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) throw new Error(`native fixture failed ${child.exitCode}: ${new TextDecoder().decode(child.stderr)}`);
  return JSON.parse(new TextDecoder().decode(child.stdout));
}
function host(method: string, args: unknown) { return { op: "host.roundtrip", input: { method, args } }; }
function temporary(run: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "inboxd-rust-compat-"));
  try { run(join(dir, "synthetic.db")); } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("Rust-owned SQLCipher compatibility", () => {
  test("numeric SQL bindings match Bun storage classes and persisted affinities", () => temporary(path => {
    const values = [0, -0, 1, 1.5, 2147483647, 2147483648, 9007199254740991, 9007199254740992, 9007199254740994, 1000000000000000100, -1000000000000000100, 1e20];
    const calls = [host("sql.exec", { sql: "CREATE TABLE numeric_affinity (i INTEGER, r REAL, t TEXT, n)" }),
      ...values.flatMap(value => [
        host("sql.get", { sql: "SELECT typeof(?) AS kind, CAST(? AS TEXT) AS text", params: [value, value] }),
        host("sql.run", { sql: "INSERT INTO numeric_affinity VALUES (?, ?, ?, ?)", params: [value, value, value, value] }),
      ]),
      host("sql.all", { sql: "SELECT typeof(i) AS ik, CAST(i AS TEXT) AS iv, typeof(r) AS rk, CAST(r AS TEXT) AS rv, typeof(t) AS tk, t AS tv, typeof(n) AS nk, CAST(n AS TEXT) AS nv FROM numeric_affinity ORDER BY rowid" }),
    ];
    const db = openSqlCipherDatabase({ filename: path, keyProvider: { getKey: () => key } });
    let expected: { ok: boolean; value: unknown }[];
    try { expected = calls.map(call => ({ ok: true, value: coreCall(call.op, call.input, db) })); }
    finally { db.close(); }
    const nativePath = path + ".native-numbers";
    expect(native(nativePath, calls)).toEqual(expected);
    const reopened = openSqlCipherDatabase({ filename: nativePath, keyProvider: { getKey: () => key } });
    try {
      const last = calls[calls.length - 1]!;
      expect({ ok: true, value: coreCall(last.op, last.input, reopened) }).toEqual(expected[expected.length - 1]);
    } finally { reopened.close(); }
  }), 30000);
  test("native serializer matches the current Bun producer on JS edge cases", () => temporary(path => {
    const values = [null, {}, { missing: undefined, nil: null }, -0, 1e-7, 1e-6, 1e20, 1e21, 1000000000000000100,
      { z: 1, "10": 2, "2": 3, a: ["\ud800", "\udfff", "😀", "\u{f0000}", "\u{f0800}", "\u0000\b\f\n\r\t"] },
      { "\ue000": 1, "😀": 2, "\ud800": 3, "\u{f0000}": 4 },
    ];
    const calls = values.flatMap(value => ["host.jsonStringify", "host.canonicalJson", "host.canonicalSha256"].map(method => host(method, value)));
    calls.push(...["Y", "Yf", "77-9", "8J-YgA", ""].map(v => host("host.base64urlDecode", v)));
    calls.push(...["\ud800", "\u{f0000}", "😀", "abc"].flatMap(v => [host("host.sha256Text",v), host("host.base64urlEncode",v), host("host.codePointLength",v)]));
    const results = native(path, calls);
    expect(results).toHaveLength(calls.length);
    calls.forEach((call, i) => expect(results[i]).toEqual({ ok: true, value: coreCall(call.op, call.input) }));
  }), 30000);

  test("Bun create → Rust mutate → Bun reopen and Rust create → Bun mutate → Rust reopen", () => temporary(path => {
    const chat = { platform: "synthetic", account: "offline", chat_id: "room\u{f0000}" };
    const event = (id: string, body: string, revision: number) => ({ kind: "create", revision: { source: "adapter", value: revision }, message: { key: { ...chat, msg_id: id }, author_id: "a", ts: 10, body, attachments: [{ filename: "\ud800\u{f0000}", mime: "text/plain", size: 1e21 }] } });
    const query = { chat, interval: { from_ts: 0, to_ts: 100 }, limit: 1, scope_codec: "synthetic-scope" };
    const open = () => openSqlCipherDatabase({ filename: path, keyProvider: { getKey: () => key } });
    let db = open();
    coreCall("store.migrate", null, db);
    coreCall("store.applySyncBatch", { events: [event("a", "needle bun", 1e21),event("b", "needle other",1)], sync: { chat, cursor: "bun", updated_at: 10 }, expected_page_sequence: 0 }, db);
    const first = coreCall<any>("store.inboxMessages", query, db);
    const expected = coreCall("store.inboxMessages", { ...query, cursor: first.next_cursor }, db);
    db.close();
    const results = native(path, [
      { op: "store.inboxMessages", input: query },
      { op: "store.inboxMessages", input: { ...query, cursor: first.next_cursor } },
      { op: "store.applySyncBatch", input: { events: [{ kind: "edit", key: { ...chat, msg_id: "b" }, body: "needle native", edited_at: 11, revision: { source: "adapter", value: 2 } }], sync: { chat, cursor: "rust", updated_at: 11 }, expected_page_sequence: 1 } },
      { op: "store.searchMessages", input: { ...query, query: "native" } },
    ]);
    expect(results[0]).toEqual({ ok: true, value: first });
    expect(results[1]).toEqual({ ok: true, value: expected });
    expect(results[2]).toEqual({ ok: true, value: null });
    db = open();
    expect(coreCall("store.searchMessages", { ...query, query: "native" }, db)).toEqual(results[3].value);
    expect(coreCall<any>("store.readSyncState", chat, db).cursor).toBe("rust");
    expect((db.query("SELECT attachments_json FROM messages WHERE msg_id='a'").get() as any).attachments_json).toBe(JSON.stringify([{ filename: "\ud800\u{f0000}", mime: "text/plain", size: 1e21 }]));
    db.close();
    const reversePath = path + ".reverse";
    expect(native(reversePath, [{ op: "store.migrate", input: null },{ op: "store.applySyncBatch", input: { events: [event("a", "reverse needle",1),event("b", "reverse two",1)], sync: { chat, cursor: "native-first", updated_at: 10 }, expected_page_sequence: 0 } }]).every(v => v.ok)).toBe(true);
    db = openSqlCipherDatabase({ filename: reversePath, keyProvider: { getKey: () => key } });
    const reverseFirst = coreCall<any>("store.inboxMessages", query, db);
    coreCall("store.applySyncBatch", { events: [event("c", "reverse three",1)], sync: { chat, cursor: "bun-second", updated_at: 12 }, expected_page_sequence: 1 }, db);
    const reverseExpected = coreCall("store.inboxMessages", { ...query, cursor: reverseFirst.next_cursor }, db);
    db.close();
    const reverse = native(reversePath, [{ op: "store.inboxMessages", input: { ...query, cursor: reverseFirst.next_cursor } },{ op: "store.readSyncState", input: chat }]);
    expect(reverse[0]).toEqual({ ok: true, value: reverseExpected });
    expect(reverse[1].value.cursor).toBe("bun-second");
  }), 30000);
});
