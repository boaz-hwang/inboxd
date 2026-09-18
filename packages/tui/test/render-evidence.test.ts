import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { displayWidth } from "../src/index.ts";

const directory = join(import.meta.dir, "..", "rendered");
const script = join(import.meta.dir, "..", "scripts", "render-evidence.ts");
const repository = resolve(import.meta.dir, "../../..");

function captures(): Record<string, string> {
  return Object.fromEntries(readdirSync(directory).filter(name => name.endsWith(".txt")).sort().map(name => [name, readFileSync(join(directory, name), "utf8")]));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("render evidence is deterministic, cell-exact and labels unknown and refused scope honestly", () => {
  execFileSync(process.execPath, [script]);
  const first = captures();
  expect(first["unknown-coverage-80x24.txt"]).toContain("unknown · ? chats / ? gaps");
  for (const dimensions of ["80x24", "120x40"]) {
    const inbox = first[`inbox-${dimensions}.txt`];
    expect(inbox).toContain("slack › work › chat:ops");
    expect(inbox).toContain("telegram › personal › chat:-100123");
    expect(inbox).toContain("kakao › local › chat:room-7");
    expect(inbox).toContain("READ bounded_history max_page=100 pages=1 cursor=opaque");
    expect(inbox).toContain("WRITE send content=text reply=yes");
    expect(inbox).toContain("RECEIPT independent_readback");
    expect(inbox).toContain("AUTH authenticated reason=none observed_at=1726650000");
    expect(first[`inbox-scope-limit-${dimensions}.txt`]).toContain("100-chat limit");
    expect(first[`inbox-scope-limit-${dimensions}.txt`]).toContain("partial");
    expect(first[`approvals-completion-lost-${dimensions}.txt`]).toContain("outcome unknown; do not resend");
    expect(first[`approvals-completion-lost-${dimensions}.txt`]).toContain("Approve [disabled: disconnected]");
    expect(first[`inbox-${dimensions}.txt`]).toContain("Unread: ? (unknown)");
    expect(first[`doctor-${dimensions}.txt`]).toContain("Authentication: slack=unknown");
  }
  for (const dimensions of ["80x24", "120x40"]) {
    const active = first[`approvals-active-prompt-${dimensions}.txt`];
    expect(active).toBeDefined();
    expect(active).toContain("Approval code [memory-only]");
    expect(active).toContain("••••_");
    expect(active).toContain("Enter submit · Esc cancel");
    expect(active).toContain("Other intent: UNCERTAIN");
    const approvalDetail = first[`approvals-detail-${dimensions}.txt`];
    expect(approvalDetail).toContain("Detail — Approvals");
    expect(approvalDetail).toContain("Other intent: UNCERTAIN");
    expect(approvalDetail).toContain("State: Proposed");
    expect(first[`chat-active-compose-${dimensions}.txt`]).toContain("Enter propose · Esc cancel");
    for (const screen of ["chat", "approvals"]) for (const [outcome, meaning] of [["sent", "acknowledged; not verified"], ["verified", "destination read-back matched"], ["uncertain", "outcome unknown; do not resend"]]) {
      expect(first[`${screen}-${outcome}-${dimensions}.txt`]).toContain(meaning!);
    }
    expect(first[`inbox-empty-${dimensions}.txt`]).not.toContain("focus 1/0");
    const emptyChat = first[`chat-empty-${dimensions}.txt`];
    expect(emptyChat).toContain("No messages");
    expect(emptyChat).not.toContain("whole grapheme clipping evidence");
    expect(emptyChat).not.toContain("Telegram text/reply capability");
    expect(emptyChat).not.toContain("read-only measured local history");
    expect(first[`inbox-long-detail-${dimensions}.txt`]).toContain("PgUp/PgDn scroll");
    expect(first[`inbox-long-detail-scrolled-${dimensions}.txt`]).toContain("END-OF-MESSAGE");
    expect(first[`approvals-rejected-${dimensions}.txt`]).toContain("invalid approval code");
    expect(first[`approvals-rejected-${dimensions}.txt`]).toContain("Code unavailable");
    expect(first[`approvals-rejected-${dimensions}.txt`]).toContain("re-proposal required");
    expect(first[`approvals-rejected-${dimensions}.txt`]).toContain("Approve [disabled");
    expect(first[`approvals-rejected-${dimensions}.txt`]).not.toContain("Approval code required");
    expect(first[`approvals-rejected-${dimensions}.txt`]).not.toContain("Sending");
    expect(first[`chat-read-only-${dimensions}.txt`]).toContain("WRITE none content=none reply=no");
    expect(first[`chat-read-only-${dimensions}.txt`]).toContain("compose disabled — exact resource is read-only");
    const kakaoSent = first[`approvals-kakao-template-sent-${dimensions}.txt`];
    expect(kakaoSent).toContain("Resource: kakao › official-app › destination:friend-uuid");
    expect(kakaoSent).toContain("WRITE send content=approved_template reply=no");
    expect(kakaoSent).toContain("RECEIPT ack_only");
    expect(kakaoSent).toContain("State: Sent");
    expect(kakaoSent).toContain("acknowledged; not verified");
    expect(kakaoSent).not.toContain("State: Verified");
    expect(kakaoSent).not.toContain("destination read-back matched");
    expect(first[`approvals-reconnected-${dimensions}.txt`]).toContain("connected");
    expect(first[`approvals-reconnected-${dimensions}.txt`]).toContain("Code unavailable");
    expect(first[`approvals-reconnected-${dimensions}.txt`]).toContain("re-proposal required");
    expect(first[`inbox-scope-limit-${dimensions}.txt`]).toContain("Recovery: configure at most 100 chats.");
    const destinationCompose = first[`native-destination-compose-${dimensions}.txt`];
    expect(destinationCompose).toContain("destination:friend-uuid");
    expect(destinationCompose).toContain("Template ID: notice-7");
    expect(destinationCompose).toContain("Preview: 승인 👩‍💻_");
    for (const provider of ["slack", "telegram"]) {
      const reply = first[`native-${provider}-reply-success-${dimensions}.txt`];
      expect(reply).toContain(`${provider} ›`);
      expect(reply).toContain("proposal created");
    }
    const kakaoLocal = first[`native-kakao-local-read-only-${dimensions}.txt`];
    expect(kakaoLocal).toContain("kakao › local › chat:room-7");
    expect(kakaoLocal).toContain("WRITE none content=none reply=no");
    expect(kakaoLocal).toContain("exact resource is read-only");
    const authDenied = first[`native-auth-denied-${dimensions}.txt`];
    expect(authDenied).toContain("AUTH unauthenticated reason=access_denied");
    expect(authDenied).toContain("compose disabled — AUTH unauthenticated");
    const revoked = first[`native-capability-revoked-${dimensions}.txt`];
    expect(revoked).toContain("AUTH unknown reason=capability_unavailable");
    expect(revoked).toContain("current capability unavailable");
  }
  const expectedNames = [
    ...["inbox", "search", "chat", "approvals", "doctor"].flatMap(screen => [screen, `${screen}-detail`]),
    "inbox-focus-before-selection", "unknown-coverage", "approvals-disconnected", "approvals-degraded", "doctor-stale", "inbox-scope-limit", "approvals-completion-lost",
    "approvals-active-prompt", "chat-active-compose", "approvals-sent", "approvals-verified", "approvals-uncertain", "chat-sent", "chat-verified", "chat-uncertain", "inbox-empty", "chat-empty", "inbox-long-detail", "inbox-long-detail-scrolled", "approvals-rejected", "chat-read-only", "approvals-kakao-template-sent", "approvals-reconnected",
    "native-destination-compose", "native-slack-reply-success", "native-telegram-reply-success", "native-kakao-local-read-only", "native-auth-denied", "native-capability-revoked",
  ].flatMap(name => ["80x24", "120x40"].map(size => `${name}-${size}.txt`)).sort();
  expect(Object.keys(first).sort()).toEqual(expectedNames);
  for (const [name, text] of Object.entries(first)) {
    const match = /-(\d+)x(\d+)\.txt$/.exec(name)!;
    expect(text).not.toContain("\x1b");
    const lines = text.split("\n");
    expect(lines).toHaveLength(Number(match[2]));
    for (const line of lines) expect(displayWidth(line)).toBe(Number(match[1]));
  }
  execFileSync(process.execPath, [script]);
  expect(captures()).toEqual(first);
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  const targetRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
  const baseRevision = execFileSync("git", ["merge-base", targetRevision, "origin/main"], { cwd: repository, encoding: "utf8" }).trim();
  expect(manifest).toMatchObject({
    schema: "inboxd.tui.capture-manifest.v1",
    base: baseRevision,
    working_tree_base: targetRevision,
    runtime: expect.any(String),
  });
  expect(manifest.source_hashes).toEqual({
    renderer: sha256(readFileSync(join(repository, "packages/tui/src/index.ts"), "utf8")),
    runtime: sha256(readFileSync(join(repository, "packages/tui/src/runtime.ts"), "utf8")),
    generator: sha256(readFileSync(script, "utf8")),
  });
  expect(Object.keys(manifest.captures)).toHaveLength(78);
  for (const [name, content] of Object.entries(first)) expect(manifest.captures[name]).toBe(sha256(content));

  const override = execFileSync("git", ["rev-parse", "HEAD^"], { cwd: repository, encoding: "utf8" }).trim();
  execFileSync(process.execPath, [script], { env: { ...process.env, INBOXD_TUI_TARGET_REVISION: override } });
  expect(JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")).working_tree_base).toBe(override);
  execFileSync(process.execPath, [script]);
});
