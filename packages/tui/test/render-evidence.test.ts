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
  for (const dimensions of ["80x24", "120x40"]) {
    const inbox = first[`inbox-${dimensions}.txt`]!;
    for (const mark of ["[SL]", "[TG]", "[KK]"]) expect(inbox).toContain(mark);
    expect(inbox).toContain("전체 메시지");
    expect(inbox).toContain("일부 기록만 표시 중");
    for (const hidden of ["observed_at", "max_page", "RECEIPT", "AUTH", "Unread: ?", "generation"]) expect(inbox).not.toContain(hidden);
    const detail = first[`inbox-detail-${dimensions}.txt`]!;
    expect(detail).toContain("Resource: slack › work › chat:ops");
    expect(detail).toContain("READ bounded_history");
    expect(detail).toContain("Unread: ? (unknown)");
    expect(first[`inbox-scope-limit-${dimensions}.txt`]).toContain("100-chat limit");
    expect(first[`approvals-completion-lost-${dimensions}.txt`]).toContain("전송 결과 확인 필요");
    expect(first[`approvals-completion-lost-${dimensions}.txt`]).toContain("연결 끊김");
    expect(first[`doctor-${dimensions}.txt`]).toContain("계정 추가 / 다시 연결");
    expect(first[`doctor-detail-${dimensions}.txt`]).toContain("SQLCipher ready=true");
    expect(first[`approvals-active-prompt-${dimensions}.txt`]).toContain("••••_");
    expect(first[`chat-active-compose-${dimensions}.txt`]).toContain("Enter propose · Esc cancel");
    expect(first[`chat-empty-${dimensions}.txt`]).toContain("아직 불러온 메시지가 없습니다");
    expect(first[`chat-read-only-${dimensions}.txt`]).toContain("읽기 전용 대화");
    expect(first[`inbox-long-detail-scrolled-${dimensions}.txt`]).toContain("END-OF-MESSAGE");
    for (const screen of ["chat", "approvals"]) {
      expect(first[`${screen}-sent-${dimensions}.txt`]).toContain("수신 확인 전");
      expect(first[`${screen}-verified-${dimensions}.txt`]).toContain("수신 확인됨");
      expect(first[`${screen}-uncertain-${dimensions}.txt`]).toContain("다시 보내지 마세요");
    }
    expect(first[`native-destination-compose-${dimensions}.txt`]).toContain("Template ID: notice-7");
    expect(first[`native-destination-compose-${dimensions}.txt`]).toContain("승인 👩‍💻_");
    expect(first[`native-kakao-local-read-only-${dimensions}.txt`]).toContain("읽기 전용 대화");
    expect(first[`native-auth-denied-${dimensions}.txt`]).toContain("계정 연결 확인 필요");
    expect(first[`native-capability-revoked-${dimensions}.txt`]).toContain("current capability unavailable");
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
    workspace: sha256(readFileSync(join(repository, "packages/tui/src/workspace.ts"), "utf8")),
    model: sha256(readFileSync(join(repository, "packages/tui/src/workspace-model.ts"), "utf8")),
    theme: sha256(readFileSync(join(repository, "packages/tui/src/theme.ts"), "utf8")),
    text: sha256(readFileSync(join(repository, "packages/tui/src/text.ts"), "utf8")),
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
