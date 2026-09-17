import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { displayWidth } from "../src/index.ts";

const directory = join(import.meta.dir, "..", "rendered");
const script = join(import.meta.dir, "..", "scripts", "render-evidence.ts");

function captures(): Record<string, string> {
  return Object.fromEntries(readdirSync(directory).filter(name => name.endsWith(".txt")).sort().map(name => [name, readFileSync(join(directory, name), "utf8")]));
}

test("render evidence is deterministic, cell-exact and labels unknown and refused scope honestly", () => {
  execFileSync(process.execPath, [script]);
  const first = captures();
  expect(first["unknown-coverage-80x24.txt"]).toContain("unknown · ? chats / ? gaps");
  for (const dimensions of ["80x24", "120x40"]) {
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
    expect(first[`chat-active-compose-${dimensions}.txt`]).toContain("Enter propose · Esc cancel");
    for (const screen of ["chat", "approvals"]) for (const [outcome, meaning] of [["sent", "acknowledged; not verified"], ["verified", "destination read-back matched"], ["uncertain", "outcome unknown; do not resend"]]) {
      expect(first[`${screen}-${outcome}-${dimensions}.txt`]).toContain(meaning!);
    }
    expect(first[`inbox-empty-${dimensions}.txt`]).not.toContain("focus 1/0");
    expect(first[`inbox-long-detail-${dimensions}.txt`]).toContain("PgUp/PgDn scroll");
    expect(first[`inbox-long-detail-scrolled-${dimensions}.txt`]).toContain("END-OF-MESSAGE");
    expect(first[`approvals-rejected-${dimensions}.txt`]).toContain("invalid approval code");
    expect(first[`approvals-rejected-${dimensions}.txt`]).toContain("Code unavailable");
    expect(first[`approvals-rejected-${dimensions}.txt`]).toContain("re-proposal required");
    expect(first[`approvals-rejected-${dimensions}.txt`]).toContain("Approve [disabled");
    expect(first[`approvals-rejected-${dimensions}.txt`]).not.toContain("Approval code required");
    expect(first[`approvals-rejected-${dimensions}.txt`]).not.toContain("Sending");
    expect(first[`chat-read-only-${dimensions}.txt`]).toContain("send capability unavailable");
    expect(first[`approvals-reconnected-${dimensions}.txt`]).toContain("connected");
    expect(first[`approvals-reconnected-${dimensions}.txt`]).toContain("Code unavailable");
    expect(first[`approvals-reconnected-${dimensions}.txt`]).toContain("re-proposal required");
    expect(first[`inbox-scope-limit-${dimensions}.txt`]).toContain("Recovery: configure at most 100 chats.");
  }
  const expectedNames = [
    ...["inbox", "search", "chat", "approvals", "doctor"].flatMap(screen => [screen, `${screen}-detail`]),
    "inbox-focus-before-selection", "unknown-coverage", "approvals-disconnected", "approvals-degraded", "doctor-stale", "inbox-scope-limit", "approvals-completion-lost",
    "approvals-active-prompt", "chat-active-compose", "approvals-sent", "approvals-verified", "approvals-uncertain", "chat-sent", "chat-verified", "chat-uncertain", "inbox-empty", "inbox-long-detail", "inbox-long-detail-scrolled", "approvals-rejected", "chat-read-only", "approvals-reconnected",
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
  expect(manifest).toMatchObject({
    schema: "inboxd.tui.capture-manifest.v1",
    base: "30f80c966076eddea0ffc185b1f7e22be0df74bb",
    working_tree_base: "3eef18fc2ae8eb129ac41abe5a17cc4c647143a0",
    runtime: expect.any(String),
  });
  expect(manifest.source_hashes).toMatchObject({ renderer: expect.stringMatching(/^[a-f0-9]{64}$/), generator: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(Object.keys(manifest.captures)).toHaveLength(62);
});
