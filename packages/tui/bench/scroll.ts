// Run: bun packages/tui/bench/scroll.ts
// No network: 1,000 Unicode messages, 20 viewport movements. Includes rendering,
// read-observation geometry and scroll metrics for chat; rendering for search.
import { createInitialState } from "../src/index.ts";
import { renderWorkspace, renderedObservation, chatScrollMetrics } from "../src/workspace.ts";
const resource = { v: 1, kind: "chat", platform: "slack", account: "me", chat_id: "room" } as const;
const rows = Array.from({ length: 1000 }, (_, i) => ({ id: String(i), body: `${i}: 한글 👩‍💻 message `.repeat(8), author: "person", resource }));
const state = { ...createInitialState(), screen: "chat" as const, pane: "messages" as const, activeResource: resource, focus: 999, chatScrollOffset: 0 };
state.views.chat = { ...state.views.chat, status: "ready", data: rows };
const size = { width: 120, height: 40 };
const chat = () => { renderWorkspace(state, size); renderedObservation(state, size); chatScrollMetrics(state, size); };
chat(); chat();
let start = performance.now();
for (let i = 0; i < 20; i++) { state.chatScrollOffset = i; chat(); }
console.log(JSON.stringify({ screen: "chat", rows: rows.length, iterations: 20, ms: performance.now() - start }));
const search = { ...state, screen: "search" as const, searchQuery: "message", views: { ...state.views, search: { ...state.views.search, status: "ready" as const, data: rows } } };
renderWorkspace(search, size); renderWorkspace(search, size);
start = performance.now();
for (let i = 0; i < 20; i++) { search.focus = 500 + i; renderWorkspace(search, size); }
console.log(JSON.stringify({ screen: "search", rows: rows.length, iterations: 20, ms: performance.now() - start }));
