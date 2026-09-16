# Native core bridge

`coreCall(op, input, database?, hooks?)` is the sole TypeScript entry point to
the Rust core. It loads `native/libinboxd_core.<suffix>` lazily; callers must
run `bun run build:native` explicitly. The library exposes:

```c
char *inboxd_core_call(const char *op, const char *input_json, HostCallback);
void inboxd_core_free(char *result);
```

Every result is a UTF-8 JSON envelope: `{ok:true,value}` or
`{ok:false,error:{name,message}}`. Rust allocates successful and failed result
buffers; TypeScript copies the string then always calls `inboxd_core_free`.
Rust catches panics at the ABI boundary. The Bun callback is synchronous,
call-scoped, and closed in `finally`; Rust must not retain it or call it from
another thread.

The callback receives `{method,args}` and returns the same result envelope.
Its frozen host methods are `sql.run|get|all|exec`,
`sql.transaction.begin|commit|rollback`, `host.now`, `host.id`,
`host.approvalCode`, `host.allowSend`, `host.canonicalJson`, `host.canonicalSha256`,
`host.sha256Text`,
`host.jsonStringify`, `host.jsonParse`, `host.numberToString`,
`host.utf16Compare` (`{left,right}` → -1/0/1), `host.codePointLength`, and
`host.base64urlEncode`/`host.base64urlDecode`. SQL owns the existing Bun
SQLCipher `Database`; `run` returns `{changes}`, `get` an object or `null`,
and `all` an array. Host exceptions are returned as structured errors.

Private bridge encoding preserves every JavaScript UTF-16 code unit,
including unpaired surrogates, and rejects non-finite numbers before JSON can
coerce them to `null`. It is applied at both sides of the callback and result;
Rust modules receive transport strings, use `wire_utf16_units`/`wire_cmp` when
JavaScript code-unit semantics matter, and never persist the transport escape.
