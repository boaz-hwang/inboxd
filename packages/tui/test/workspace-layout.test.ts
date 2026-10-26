import { expect, test } from "bun:test";
import { createInitialState } from "../src/index.ts";
import { chatScrollMetrics, renderWorkspace, renderedObservation, sidebarWidth } from "../src/workspace.ts";
import { wrapCells } from "../src/text.ts";

function chat() {
  const resource = { v: 1, kind: "chat", platform: "slack", account: "me", chat_id: "room" } as const;
  const state = { ...createInitialState(), screen: "chat" as const, pane: "messages" as const, activeResource: resource, focus: 30, chatScrollOffset: 0 };
  state.views.chat = { ...state.views.chat, status: "ready", data: Array.from({ length: 40 }, (_, i) => ({ id: String(i), body: `${i} 한글 👩‍💻 `.repeat(8), resource })) };
  return state;
}

test("chat layout reuses geometry while scrolling and recomputes for edits, deletions and resize", () => {
  const state = chat(), size = { width: 120, height: 40 };
  const before = chatScrollMetrics(state, size);
  const moved = { ...state, focus: 20, chatScrollOffset: 15 };
  expect(chatScrollMetrics(moved, size).blocks).toBe(before.blocks);
  // Replacement snapshots may keep IDs while changing displayed content.
  const edited = { ...state, views: { ...state.views, chat: { ...state.views.chat, data: state.views.chat.data.map((row, i) => i === 0 ? { ...row, body: "edited ".repeat(300) } : row) } } };
  const afterEdit = chatScrollMetrics(edited, size);
  expect(afterEdit.blocks[0]).toBeGreaterThan(before.blocks[0]!);
  const deleted = { ...edited, views: { ...edited.views, chat: { ...edited.views.chat, data: edited.views.chat.data.map((row, i) => i === 0 ? { ...row, deleted: true } : row) } } };
  expect(chatScrollMetrics(deleted, size).blocks[0]).toBe(3);
  expect(chatScrollMetrics(edited, { width: 80, height: 24 }).total).toBeGreaterThan(afterEdit.total);
});

test("viewport rendering and observation slices retain exact wrapped geometry across cached scrolling", () => {
  const state = chat(), size = { width: 120, height: 40 };
  const width = size.width - sidebarWidth(size.width) - 2;
  const expected = state.views.chat.data.map(row => wrapCells(row.body!, width - 4).length + 2);
  for (const offset of [0, 1, 12, 45, 100, 10000]) {
    state.chatScrollOffset = offset;
    const metrics = chatScrollMetrics(state, size);
    expect(metrics.blocks).toEqual(expected);
    const slices = renderedObservation(state, size).slices;
    expect(slices.length).toBeGreaterThan(0);
    let position = 0;
    const first = expected.findIndex(length => { position += length; return position > metrics.top; });
    expect(slices[0]!.id).toBe(String(first));
    expect(slices[0]!.start).toBe(metrics.top - (position - expected[first]!));
    for (const slice of slices) expect(slice.total).toBe(expected[Number(slice.id)]!);
    expect(renderWorkspace(state, size).split("\n")).toHaveLength(size.height);
  }
});

test("moving through unified search wraps only viewport neighbors", () => {
  const state = { ...chat(), screen: "search" as const, focus: 500, searchQuery: "needle" };
  let bodyReads = 0;
  state.views.search = { ...state.views.search, status: "ready", data: Array.from({ length: 1000 }, (_, i) => ({ id: String(i), get body() { bodyReads++; return `result ${i}`; } })) };
  const frame = renderWorkspace(state, { width: 120, height: 40 });
  expect(frame).toContain("result 500");
  expect(bodyReads).toBeLessThan(20);
});
