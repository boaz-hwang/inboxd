import type { ClientRole, JsonObject, ProtocolEventMethod, ProtocolMethod } from "../../protocol/src/schema.ts";

export const screens = ["inbox", "search", "chat", "approvals", "doctor"] as const;
export type Screen = (typeof screens)[number];
export type ConnectionStatus = "connected" | "reconnecting" | "degraded";
type ViewStatus = "idle" | "loading" | "ready" | "empty" | "error" | "stale";

export interface Coverage {
  chats?: number;
  gaps?: number;
  limits?: number;
  freshness: "fresh" | "partial" | "unknown" | "stale";
}

export interface Row {
  id: string;
  /** Protocol identity; display IDs are never parsed to recover a chat scope. */
  chat?: ChatRef;
  author?: string;
  ts?: string;
  body?: string;
  edited?: boolean;
  deleted?: boolean;
  state?: string;
  destination?: string;
  expires?: string;
  codeRequired?: boolean;
}

interface View {
  status: ViewStatus;
  data: Row[];
  error?: string;
  /** Opaque daemon continuation token retained only for this in-memory view. */
  nextCursor?: string;
}

export interface TuiState {
  screen: Screen;
  focus: number;
  selected: Record<Screen, number>;
  views: Record<Screen, View>;
  coverage: Coverage;
  connection: { status: ConnectionStatus; generation: number; subscribedGeneration: number; stale: boolean };
  requery: Screen[];
  helpOpen: boolean;
  /** Narrow terminals replace the list with the activated row's detail. */
  detailOpen: boolean;
  searchActive: boolean;
  /** Search text is process-memory-only and is cleared on cancel or exit. */
  searchQuery: string;
  /** Compose is available only for an open Chat and is cleared on cancel or exit. */
  composeActive: boolean;
  approvalPrompt: boolean;
  codeBuffer: string;
  /** Compose content never leaves memory and is cleared when the operator exits. */
  draft: string;
  notice?: string;
  platform?: string;
  period?: string;
  quitRequested: boolean;
}

export type TuiAction =
  | { type: "key"; key: string }
  | { type: "switchScreen"; screen: Screen }
  | { type: "connected"; generation: number }
  | { type: "subscribed"; generation: number }
  | { type: "disconnected"; generation: number; degraded?: boolean }
  | { type: "queryLoading"; generation: number; screen: Screen }
  | { type: "querySucceeded"; generation: number; screen: Screen; data: Row[]; coverage?: Coverage; nextCursor?: string; append?: boolean }
  | { type: "queryFailed"; generation: number; screen: Screen; error: string }
  | { type: "querySkipped"; generation: number; screen: Screen }
  | { type: "coverage"; coverage: Coverage }
  | { type: "event"; generation: number; method: ProtocolEventMethod };

const screenLabels: Record<Screen, string> = {
  inbox: "INBOX",
  search: "SEARCH",
  chat: "CHAT",
  approvals: "APPROVALS",
  doctor: "DOCTOR",
};

function blankView(): View {
  return { status: "idle", data: [] };
}

function views(): Record<Screen, View> {
  return { inbox: blankView(), search: blankView(), chat: blankView(), approvals: blankView(), doctor: blankView() };
}

export function createInitialState(settings: { platform?: string; period?: string; screen?: Screen } = {}): TuiState {
  return {
    screen: settings.screen ?? "inbox",
    focus: 0,
    selected: { inbox: 0, search: 0, chat: 0, approvals: 0, doctor: 0 },
    views: views(),
    coverage: { freshness: "unknown" },
    connection: { status: "reconnecting", generation: 0, subscribedGeneration: 0, stale: false },
    requery: [],
    helpOpen: false,
    detailOpen: false,
    searchActive: false,
    searchQuery: "",
    composeActive: false,
    approvalPrompt: false,
    codeBuffer: "",
    draft: "",
    platform: settings.platform,
    period: settings.period,
    quitRequested: false,
  };
}

function withView(state: TuiState, screen: Screen, next: View): TuiState {
  return { ...state, views: { ...state.views, [screen]: next } };
}

function accepted(state: TuiState, generation: number): boolean {
  return state.connection.generation === generation && state.connection.subscribedGeneration === generation;
}

function allScreens(): Screen[] {
  return [...screens];
}

function settleRequery(state: TuiState, screen: Screen): Pick<TuiState, "requery" | "notice"> {
  const requery = state.requery.filter((item) => item !== screen);
  return {
    requery,
    ...(requery.length === 0 && state.notice === "subscribed — re-query required" ? { notice: undefined } : { notice: state.notice }),
  };
}

function eventScreens(method: ProtocolEventMethod): Screen[] {
  if (method === "safety.intent.changed") return ["approvals"];
  if (method === "coverage.changed") return ["inbox", "search", "chat"];
  return ["inbox", "search", "chat"];
}

function maxFocus(state: TuiState): number {
  return Math.max(0, state.views[state.screen].data.length - 1);
}

/** Pure state reducer. A generation must subscribe before its responses or events are trusted. */
export function reduce(state: TuiState, action: TuiAction): TuiState {
  if (action.type === "switchScreen") return { ...state, screen: action.screen, focus: state.selected[action.screen], helpOpen: false, detailOpen: false };
  if (action.type === "connected") {
    if (action.generation < state.connection.generation) return state;
    return {
      ...state,
      connection: { status: "reconnecting", generation: action.generation, subscribedGeneration: 0, stale: state.connection.stale },
      notice: "reconnecting — subscribing before re-query",
    };
  }
  if (action.type === "subscribed") {
    if (action.generation !== state.connection.generation) return state;
    return {
      ...state,
      connection: { ...state.connection, status: "connected", subscribedGeneration: action.generation, stale: false },
      requery: allScreens(),
      notice: "subscribed — re-query required",
    };
  }
  if (action.type === "disconnected") {
    if (action.generation !== state.connection.generation) return state;
    const staleViews = Object.fromEntries(screens.map((screen) => {
      const view = state.views[screen];
      return [screen, view.status === "ready" || view.status === "empty" ? { ...view, status: "stale" as const } : view];
    })) as Record<Screen, View>;
    return {
      ...state,
      views: staleViews,
      connection: { ...state.connection, status: action.degraded ? "degraded" : "reconnecting", subscribedGeneration: 0, stale: true },
      approvalPrompt: false,
      detailOpen: false,
      searchActive: false,
      searchQuery: "",
      composeActive: false,
      draft: "",
      codeBuffer: "",
      notice: "connection lost — send actions disabled; no action retried",
    };
  }
  if (action.type === "queryLoading") {
    if (!accepted(state, action.generation)) return state;
    return withView(state, action.screen, { ...state.views[action.screen], status: "loading", error: undefined });
  }
  if (action.type === "querySucceeded") {
    if (!accepted(state, action.generation)) return state;
    const prior = state.views[action.screen];
    const data = action.append ? [...prior.data, ...action.data] : action.data;
    const next = withView(state, action.screen, {
      status: data.length ? "ready" : "empty",
      data,
      nextCursor: action.nextCursor,
    });
    return { ...next, coverage: action.coverage ?? next.coverage, ...settleRequery(next, action.screen) };
  }
  if (action.type === "queryFailed") {
    if (!accepted(state, action.generation)) return state;
    const next = withView(state, action.screen, { ...state.views[action.screen], status: "error", error: action.error });
    return { ...next, ...settleRequery(next, action.screen) };
  }
  if (action.type === "querySkipped") {
    if (!accepted(state, action.generation)) return state;
    return { ...state, ...settleRequery(state, action.screen) };
  }
  if (action.type === "coverage") return { ...state, coverage: action.coverage };
  if (action.type === "event") {
    if (!accepted(state, action.generation)) return state;
    return { ...state, requery: [...new Set([...state.requery, ...eventScreens(action.method)])], notice: "update received — re-query required" };
  }

  if (action.key === "Escape") {
    if (state.approvalPrompt) return { ...state, approvalPrompt: false, codeBuffer: "", notice: "approval code cleared from memory" };
    if (state.searchActive) return { ...state, searchActive: false, searchQuery: "", notice: "search query cleared from memory" };
    if (state.composeActive) return { ...state, composeActive: false, draft: "", notice: "compose draft cleared from memory" };
    if (state.helpOpen) return { ...state, helpOpen: false };
    if (state.detailOpen) return { ...state, detailOpen: false, notice: "detail closed" };
    return state;
  }
  if (state.approvalPrompt) {
    if (action.key === "Enter") {
      if (state.connection.status !== "connected") return { ...state, notice: "approval disabled while disconnected" };
      if (state.codeBuffer.length < 4) return { ...state, notice: "approval code required — enter the full code" };
      return { ...state, approvalPrompt: false, codeBuffer: "", notice: "approval submitted; code cleared from memory" };
    }
    if (action.key === "Backspace") return { ...state, codeBuffer: state.codeBuffer.slice(0, -1) };
    if (action.key.length === 1) return { ...state, codeBuffer: state.codeBuffer + action.key };
    return state;
  }
  if (state.searchActive) {
    if (action.key === "Enter") {
      if (state.searchQuery.trim().length === 0) return { ...state, notice: "search query required" };
      return { ...state, searchActive: false, notice: "search submitted — query remains memory-only" };
    }
    if (action.key === "Backspace") return { ...state, searchQuery: state.searchQuery.slice(0, -1) };
    if (action.key.length === 1) return { ...state, searchQuery: state.searchQuery + action.key };
    return state;
  }
  if (state.composeActive) {
    if (action.key === "Enter") {
      if (state.draft.trim().length === 0) return { ...state, notice: "compose body required" };
      return { ...state, composeActive: false, draft: "", notice: "proposal submitting; draft cleared from memory" };
    }
    if (action.key === "Backspace") return { ...state, draft: state.draft.slice(0, -1) };
    if (action.key.length === 1) return { ...state, draft: state.draft + action.key };
    return state;
  }
  if (action.key >= "1" && action.key <= "5") return reduce(state, { type: "switchScreen", screen: screens[Number(action.key) - 1]! });
  if (action.key === "?") return { ...state, helpOpen: !state.helpOpen };
  if (action.key === "/") return { ...state, screen: "search", searchActive: true, searchQuery: "", helpOpen: false, notice: "search input is memory-only" };
  if (action.key === "q") return { ...state, quitRequested: true, detailOpen: false, draft: "", searchQuery: "", composeActive: false, codeBuffer: "", approvalPrompt: false, notice: "memory drafts cleared on exit" };
  if (action.key === "j" || action.key === "ArrowDown") return { ...state, focus: Math.min(maxFocus(state), state.focus + 1) };
  if (action.key === "k" || action.key === "ArrowUp") return { ...state, focus: Math.max(0, state.focus - 1) };
  if (action.key === "Enter") {
    return { ...state, selected: { ...state.selected, [state.screen]: state.focus }, detailOpen: true, notice: `${screenLabels[state.screen].toLowerCase()} selection opened` };
  }
  if (action.key === "a") {
    if (state.screen !== "approvals") return { ...state, notice: "approval prompt is only available in Approvals" };
    if (state.connection.status !== "connected") return { ...state, notice: "approval disabled while disconnected" };
    return { ...state, approvalPrompt: true, codeBuffer: "", notice: undefined };
  }
  if (action.key === "b") {
    if (state.connection.status !== "connected") return { ...state, notice: "backfill disabled while disconnected" };
    return { ...state, notice: "backfill requested — no action retried after disconnect" };
  }
  if (action.key === "n") {
    if (state.connection.status !== "connected") return { ...state, notice: "more results disabled while disconnected" };
    if (state.views[state.screen].nextCursor === undefined) return { ...state, notice: "no more results" };
    return { ...state, notice: "fetching more results" };
  }
  if (action.key === "c") {
    if (state.screen !== "chat") return { ...state, notice: "compose proposal is only available in Chat" };
    if (state.connection.status !== "connected") return { ...state, notice: "compose disabled while disconnected" };
    return { ...state, composeActive: true, draft: "", notice: "compose proposal — draft remains memory-only" };
  }
  return state;
}

export function displayWidth(value: string): number {
  let width = 0;
  for (const character of Array.from(value)) {
    const code = character.codePointAt(0)!;
    if (code === 0x200d || (code >= 0x300 && code <= 0x36f) || (code >= 0xfe00 && code <= 0xfe0f)) continue;
    width += code >= 0x1100 && (code <= 0x115f || code >= 0x2e80 && code <= 0xa4cf || code >= 0xac00 && code <= 0xd7a3 || code >= 0xf900 && code <= 0xfaff || code >= 0xff01 && code <= 0xff60 || code >= 0x1f300) ? 2 : 1;
  }
  return width;
}

/** Clips by terminal cells and emits an ellipsis without splitting a grapheme. */
export function truncateCells(value: string, width: number): string {
  if (width <= 0) return "";
  if (displayWidth(value) <= width) return value;
  if (width === 1) return "…";
  const target = width - 1;
  let result = "";
  let used = 0;
  const clusters = typeof Intl.Segmenter === "function"
    ? Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value), (part) => part.segment)
    : Array.from(value);
  for (const character of clusters) {
    const characterWidth = displayWidth(character);
    if (used + characterWidth > target) break;
    result += character;
    used += characterWidth;
  }
  return `${result}…`;
}

function fit(line: string, width: number): string {
  const clipped = truncateCells(line, width);
  return clipped + " ".repeat(Math.max(0, width - displayWidth(clipped)));
}

function count(value: number | undefined, label: string): string {
  return `${value === undefined ? "?" : value} ${label}`;
}

function coverageText(coverage: Coverage): string {
  const limits = coverage.limits === undefined ? "" : ` / ${count(coverage.limits, "limits")}`;
  return `${coverage.freshness} · ${count(coverage.chats, "chats")} / ${count(coverage.gaps, "gaps")}${limits}`;
}

function visibleRows(state: TuiState, screen: Screen): Row[] {
  if (screen === "chat" && state.views.chat.data.length === 0) return state.views.inbox.data;
  return state.views[screen].data;
}

function dataLines(state: TuiState, screen: Screen, empty: string): string[] {
  const view = state.views[screen];
  if (view.status === "loading") return ["> Loading…"];
  if (view.status === "error") return [`> ${view.error} — retry query`];
  if (view.status === "empty") return [`> ${empty}`];
  const rows = visibleRows(state, screen);
  if (rows.length === 0) return [`> ${empty}`];
  const data = rows.map((row, index) => {
    const focus = index === state.focus ? ">" : " ";
    const selected = index === state.selected[screen] ? "●" : "○";
    const revision = row.deleted ? " deleted" : row.edited ? " (edited)" : "";
    return `${focus} ${selected} ${row.author ?? row.state ?? "item"} ${row.ts ?? row.expires ?? ""} ${row.destination ?? ""} ${row.body ?? ""}${revision}`.replace(/\s+/g, " ").trimEnd();
  });
  return state.views[screen].nextCursor === undefined ? data : [...data, "  more results [n] — fetch next page"];
}

function listContentLines(state: TuiState): string[] {
  const screen = state.screen;
  const view = state.views[screen];
  if (screen === "inbox") return ["Inbox", ...dataLines(state, screen, "No messages")];
  if (screen === "search") {
    const query = state.searchQuery.length === 0 ? "(memory-only)" : `${state.searchQuery} [memory-only]`;
    const inputHint = state.searchActive ? " · Enter submit · Esc cancel" : "";
    return [`Search query: ${query}${inputHint}`, `Coverage: ${coverageText(state.coverage)}`, "", "Results", ...dataLines(state, screen, "No results")];
  }
  if (screen === "chat") {
    const compose = state.composeActive ? [`Compose proposal: ${state.draft || "_"} [memory-only] · Enter propose · Esc cancel`] : [];
    const gap = `── coverage gap: ${state.coverage.gaps === undefined ? "?" : state.coverage.gaps} · ${state.coverage.freshness} ──`;
    return ["Chat", ...compose, gap, ...dataLines(state, screen, "No messages")];
  }
  if (screen === "approvals") {
    const disabled = state.connection.status === "connected" ? "Approve [a]" : "Approve [disabled: disconnected]";
    const uncertain = visibleRows(state, screen).some((row) => row.state === "Uncertain") ? ["UNCERTAIN — do not resend automatically"] : [];
    const prompt = state.approvalPrompt ? ["┌ Approval code [memory-only]", `│ ${"•".repeat(state.codeBuffer.length)}_`, "└ Enter submit · Esc cancel"] : [];
    return ["Approvals", ...dataLines(state, screen, "No pending approvals"), ...uncertain, disabled, ...prompt];
  }
  const stale = state.connection.stale ? "stale response retained" : "connected";
  return ["Doctor", `> Encryption: ${view.data[0]?.state ?? "unknown"}`, `  Authentication: ${view.data[1]?.state ?? "unknown"}`, `  Daemon: ${stale}`, `  Connection: ${state.connection.status}`, `  Generation: ${state.connection.generation} / subscribed ${state.connection.subscribedGeneration}`];
}

function detailLines(state: TuiState): string[] {
  const screen = state.screen;
  const row = visibleRows(state, screen)[state.selected[screen]];
  const title = `Detail — ${screenLabels[screen][0]}${screenLabels[screen].slice(1).toLowerCase()}`;
  if (row === undefined) return [title, "No selected item", "Back: Esc"];
  const details = [
    row.author === undefined ? undefined : `Author: ${row.author}`,
    row.state === undefined ? undefined : `State: ${row.state}`,
    row.ts === undefined ? undefined : `Time: ${row.ts}`,
    row.destination === undefined ? undefined : `Destination: ${row.destination}`,
    row.expires === undefined ? undefined : `Expires: ${row.expires}`,
    row.body === undefined ? undefined : `Message: ${row.body}${row.deleted ? " deleted" : row.edited ? " (edited)" : ""}`,
    row.codeRequired ? "Approval code required" : undefined,
  ].filter((line): line is string => line !== undefined);
  const warnings = [
    screen === "chat" ? `── coverage gap: ${state.coverage.gaps === undefined ? "?" : state.coverage.gaps} · ${state.coverage.freshness} ──` : undefined,
    screen === "approvals" && visibleRows(state, screen).some((item) => item.state === "Uncertain") ? "UNCERTAIN — do not resend automatically" : undefined,
  ].filter((line): line is string => line !== undefined);
  return [title, `Context: ${state.selected[screen] + 1} of ${visibleRows(state, screen).length} · ${coverageText(state.coverage)}`, `ID: ${row.id}`, ...details, ...warnings, "Back: Esc"];
}

function joinColumns(left: readonly string[], right: readonly string[], width: number): string[] {
  const leftWidth = Math.floor(width * 0.4);
  const rightWidth = width - leftWidth - 1;
  const rowCount = Math.max(left.length, right.length);
  return Array.from({ length: rowCount }, (_, index) => `${fit(left[index] ?? "", leftWidth)}│${fit(right[index] ?? "", rightWidth)}`);
}

function narrowBodyLines(state: TuiState): string[] {
  const prefix = ["DETAIL (in place)", `Evidence rail: ${coverageText(state.coverage)} · ${state.connection.status}${state.connection.stale ? " · stale" : ""}`];
  const content = state.detailOpen ? detailLines(state) : listContentLines(state);
  return [...prefix, ...content];
}

function wideBodyLines(state: TuiState, width: number): string[] {
  const list = ["LIST 40%", `Evidence rail: ${coverageText(state.coverage)}`, `Status rail: ${state.connection.status}${state.connection.stale ? " · stale retained" : ""} · generation ${state.connection.generation}/${state.connection.subscribedGeneration}`, ...listContentLines(state), ...(state.notice === undefined ? [] : [`! ${state.notice}`])];
  const detail = ["DETAIL 60%", `Context rail: ${screenLabels[state.screen]} · focus ${state.focus + 1}/${visibleRows(state, state.screen).length || 0}`, ...detailLines(state)];
  return joinColumns(list, detail, width);
}

/** Deterministic fixed-size text renderer used for capture evidence. */
export function renderScreen(state: TuiState, size: { width: number; height: number }, ephemeral: { approvalCode?: string } = {}): string {
  if (size.width < 80 || size.height < 24) {
    return Array.from({ length: Math.max(1, size.height) }, (_, index) => fit(index === 0 ? "terminal too small — minimum 80×24" : "", Math.max(1, size.width))).join("\n");
  }
  const status = `INBOXD · ${state.connection.status}${state.connection.stale ? " · STALE" : ""} · ${state.platform ?? "account ?"}`;
  const tabs = screens.map((screen, index) => screen === state.screen ? `● ${screenLabels[screen]}` : `${index + 1} ${screenLabels[screen]}`).join(" | ");
  const wide = size.width >= 120;
  const body = wide ? wideBodyLines(state, size.width) : narrowBodyLines(state);
  if (state.screen === "approvals" && ephemeral.approvalCode !== undefined) body.push(`Approval code [ephemeral]: ${ephemeral.approvalCode}`);
  if (!wide && state.notice) body.push(`! ${state.notice}`);
  if (state.helpOpen) body.push("Keys: 1–5 screens · j/k/↑↓ move · Enter open · / search · n more · b backfill", "      c compose · a approve · Esc cancel/back · ? help · q quit");
  const rowsForBody = size.height - 3;
  const lines = [status, tabs, ...body.slice(0, rowsForBody)];
  while (lines.length < size.height - 1) lines.push("");
  lines.push("1–5 j/k ↑↓ Enter / n-more b c a Esc ? q");
  return lines.slice(0, size.height).map((line) => fit(line, size.width)).join("\n");
}

/** Persist only navigation/filter settings; content and secrets are rejected at every nesting level. */
export function sanitizePersistence(value: Record<string, unknown>): { screen?: Screen; platform?: string; period?: string } {
  assertNoPersistedSecret(value);
  const screen = screens.includes(value.screen as Screen) ? value.screen as Screen : undefined;
  const platform = typeof value.platform === "string" ? value.platform : undefined;
  const period = typeof value.period === "string" ? value.period : undefined;
  return { ...(screen === undefined ? {} : { screen }), ...(platform === undefined ? {} : { platform }), ...(period === undefined ? {} : { period }) };
}

function assertNoPersistedSecret(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoPersistedSecret(item);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (/(draft|query|body|code|token|secret)/i.test(key)) {
      throw new Error(`persistence key ${key} is not persisted`);
    }
    assertNoPersistedSecret(nested);
  }
}

interface NativeRenderer {
  root: { add(renderable: unknown): unknown };
}

/** Native OpenTUI entry point; callers own the renderer lifecycle. */
export async function mountOpenTui(renderer: NativeRenderer, state: TuiState, width = 80, height = 24): Promise<{ destroy(): void }> {
  const coreModule = "@opentui/core";
  const { TextRenderable } = await import(coreModule);
  const text = new TextRenderable(renderer as never, { id: "inboxd-screen", content: renderScreen(state, { width, height }) });
  renderer.root.add(text);
  return text;
}

/** Construction-safe smoke helper: uses OpenTUI's native test renderer and never enters an interactive loop. */
export async function createNativeScreen(width: number, height: number): Promise<{ content: string; destroy(): void }> {
  const testingModule = "@opentui/core/testing";
  const coreModule = "@opentui/core";
  const { createTestRenderer } = await import(testingModule);
  const { TextRenderable } = await import(coreModule);
  const harness = await createTestRenderer({ width, height });
  const content = renderScreen(createInitialState(), { width, height });
  const text = new TextRenderable(harness.renderer as never, { id: "inboxd-smoke", content });
  harness.renderer.root.add(text);
  await harness.renderOnce();
  return { content, destroy: () => { text.destroy(); harness.renderer.destroy(); } };
}

export interface TuiProtocolClient {
  start(topics: readonly ProtocolEventMethod[]): Promise<void>;
  stop(): void;
  request(method: ProtocolMethod, params: JsonObject): Promise<JsonObject>;
}

export interface ChatRef {
  readonly platform: string;
  readonly account: string;
  readonly chat_id: string;
}

export interface TuiSearchInput {
  readonly chat: ChatRef;
  readonly interval: { readonly from_ts: number; readonly to_ts: number };
  /** Search text is process-memory-only and is never persisted. */
  readonly query: string;
}

interface PendingApproval {
  readonly actor: string;
  readonly scope: ChatRef;
}

export interface TuiControllerOptions {
  readonly client: TuiProtocolClient;
  readonly initialState?: TuiState;
  /** Non-secret identity bound to every proposal created from this local TUI. */
  readonly actor?: string;
  readonly onStateChange?: (state: TuiState) => void;
}

const tuiTopics: readonly ProtocolEventMethod[] = ["message.upserted", "coverage.changed", "safety.intent.changed"];

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.flatMap((item) => {
    const itemRecord = record(item);
    return itemRecord === undefined ? [] : [itemRecord];
  }) : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function chatRef(value: unknown): ChatRef | undefined {
  const item = record(value);
  const platform = stringValue(item?.platform);
  const account = stringValue(item?.account);
  const chatId = stringValue(item?.chat_id);
  return platform === undefined || account === undefined || chatId === undefined ? undefined : { platform, account, chat_id: chatId };
}

function messageRows(value: unknown): Row[] {
  return records(value).flatMap((item) => {
    const id = stringValue(item.msg_id) ?? stringValue(item.id);
    if (id === undefined) return [];
    return [{
      id,
      author: stringValue(item.author_id) ?? stringValue(item.author),
      ts: stringValue(item.ts) ?? (numberValue(item.ts) === undefined ? undefined : String(numberValue(item.ts))),
      body: stringValue(item.body),
      edited: item.edited_at !== undefined || item.edited === true,
      deleted: item.deleted_at !== undefined || item.deleted === true,
    }];
  });
}

function chatRows(value: unknown): Row[] {
  return records(value).flatMap((item) => {
    const ref = chatRef(item);
    if (ref === undefined) return [];
    return [{
      id: `${ref.platform}:${ref.account}:${ref.chat_id}`,
      chat: ref,
      author: stringValue(item.display_name) ?? ref.chat_id,
      destination: `${ref.platform}:${ref.account}`,
    }];
  });
}

function coverage(value: unknown): Coverage | undefined {
  const item = record(value);
  if (item === undefined) return undefined;
  const legacyFreshness = item.freshness;
  if (legacyFreshness === "fresh" || legacyFreshness === "partial" || legacyFreshness === "unknown" || legacyFreshness === "stale") {
    const chats = numberValue(item.chats);
    const gaps = numberValue(item.gaps);
    const limits = numberValue(item.limits);
    return {
      freshness: legacyFreshness,
      ...(chats === undefined ? {} : { chats }),
      ...(gaps === undefined ? {} : { gaps }),
      ...(limits === undefined ? {} : { limits }),
    };
  }
  const covered = Array.isArray(item.covered) ? item.covered : [];
  const gaps = Array.isArray(item.gaps) ? item.gaps : [];
  const freshnessEntries = Array.isArray(item.freshness) ? item.freshness : [];
  const limits = Array.isArray(item.limits) ? item.limits : [];
  const target = record(item.target);
  const targetChat = chatRef(target?.chat);
  const freshness: Coverage["freshness"] = gaps.length > 0
    ? "partial"
    : freshnessEntries.length > 0 || covered.length > 0
      ? "fresh"
      : "unknown";
  return {
    freshness,
    chats: targetChat === undefined ? 0 : 1,
    gaps: gaps.length,
    limits: limits.length,
  };
}

/**
 * Protocol-only controller: it owns no database, adapter, daemon lifecycle, or
 * persisted content. The runtime supplies a protocol client and forwards its
 * subscribed events here.
 */
export class TuiController {
  private current: TuiState;
  private generation = 0;
  private activeChat: ChatRef | undefined;
  private search: TuiSearchInput | undefined;
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly approvalCodes = new Map<string, string>();
  private readonly inFlightPages = new Set<string>();
  private readonly listeners = new Set<(state: TuiState) => void>();

  constructor(private readonly options: TuiControllerOptions) {
    this.current = options.initialState ?? createInitialState();
  }

  get state(): TuiState { return this.current; }

  currentApprovalCode(): string | undefined {
    const row = this.current.views.approvals.data[this.current.selected.approvals];
    return row === undefined ? undefined : this.approvalCodes.get(row.id);
  }

  subscribe(listener: (state: TuiState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.options.onStateChange?.(this.current);
    for (const listener of this.listeners) listener(this.current);
  }

  private update(action: TuiAction): void {
    this.current = reduce(this.current, action);
    this.notify();
  }

  private replace(next: TuiState): void {
    this.current = next;
    this.notify();
  }

  async start(): Promise<void> {
    const generation = ++this.generation;
    this.update({ type: "connected", generation });
    try {
      await this.options.client.start(tuiTopics);
      if (generation !== this.generation) return;
      this.update({ type: "subscribed", generation });
      await this.refresh();
    } catch (error) {
      if (generation === this.generation) {
        this.update({ type: "disconnected", generation, degraded: true });
        this.replace({ ...this.current, notice: `connection failed — ${error instanceof Error ? error.message : "retry when daemon is available"}` });
      }
    }
  }

  stop(): void {
    this.generation++;
    this.options.client.stop();
    this.approvals.clear();
    this.approvalCodes.clear();
    this.inFlightPages.clear();
    this.replace({ ...this.current, draft: "", searchQuery: "", searchActive: false, composeActive: false, codeBuffer: "", approvalPrompt: false });
  }

  disconnected(degraded = false): void {
    this.update({ type: "disconnected", generation: this.generation, degraded });
    this.approvals.clear();
    this.approvalCodes.clear();
    this.inFlightPages.clear();
  }

  /** Called by the runtime's ReconnectingProtocolClient event callback. */
  async receiveEvent(method: ProtocolEventMethod): Promise<void> {
    const generation = this.generation;
    this.update({ type: "event", generation, method });
    await this.refresh();
  }

  setActiveChat(chat: ChatRef | undefined): void { this.activeChat = chat; }
  setSearch(input: TuiSearchInput | undefined): void { this.search = input; }

  async dispatchKey(key: string): Promise<void> {
    const before = this.current;
    const code = before.codeBuffer;
    const query = before.searchQuery;
    const draft = before.draft;
    const inputActive = before.approvalPrompt || before.searchActive || before.composeActive;
    const nextCursor = before.views[before.screen].nextCursor;
    this.update({ type: "key", key });
    if (key === "q" && !inputActive) {
      this.stop();
      return;
    }
    if (key === "Enter" && before.searchActive && query.trim().length > 0) await this.submitSearch(query);
    if (key === "Enter" && before.composeActive && draft.trim().length > 0) await this.propose(draft);
    if (key === "Enter" && before.approvalPrompt && code.length >= 4) await this.approve(code);
    if (key === "b" && before.connection.status === "connected" && !inputActive) await this.backfill();
    if (key === "n" && before.connection.status === "connected" && !inputActive && nextCursor !== undefined) await this.loadMore(before.screen, nextCursor);
    if (key === "Enter" && before.screen === "inbox" && before.detailOpen) await this.openFocusedChat();
  }

  async refresh(): Promise<void> {
    const generation = this.generation;
    if (this.current.connection.status !== "connected") return;
    // Every request is explicitly mapped to the daemon protocol. No storage or
    // platform import is permitted in this package.
    if (this.current.requery.includes("inbox")) await this.refreshInbox(generation);
    if (this.current.requery.includes("search")) {
      if (this.search !== undefined) await this.refreshSearch(generation);
      else this.update({ type: "querySkipped", generation, screen: "search" });
    }
    if (this.current.requery.includes("chat")) {
      if (this.activeChat !== undefined) await this.refreshChat(generation);
      else this.update({ type: "querySkipped", generation, screen: "chat" });
    }
    if (this.current.requery.includes("approvals")) await this.refreshApprovals(generation);
    if (this.current.requery.includes("doctor")) await this.refreshDoctor(generation);
  }

  private async loadMore(screen: Screen, cursor: string): Promise<void> {
    const generation = this.generation;
    const requestKey = `${generation}\u0000${screen}\u0000${cursor}`;
    if (this.inFlightPages.has(requestKey)) return;
    this.inFlightPages.add(requestKey);
    try {
      if (screen === "inbox") await this.refreshInbox(generation, cursor, true);
      if (screen === "search") await this.refreshSearch(generation, cursor, true);
      if (screen === "chat") await this.refreshChat(generation, cursor, true);
    } finally {
      this.inFlightPages.delete(requestKey);
    }
  }

  private async call(screen: Screen, generation: number, method: ProtocolMethod, params: JsonObject): Promise<JsonObject | undefined> {
    this.update({ type: "queryLoading", generation, screen });
    try {
      const result = await this.options.client.request(method, params);
      if (generation !== this.generation) return undefined;
      return result;
    } catch (error) {
      if (generation === this.generation) this.update({ type: "queryFailed", generation, screen, error: error instanceof Error ? error.message : "daemon query failed" });
      return undefined;
    }
  }

  private async refreshInbox(generation: number, cursor?: string, append = false): Promise<void> {
    const result = await this.call("inbox", generation, "chat.list", cursor === undefined ? {} : { cursor });
    if (result !== undefined) this.update({ type: "querySucceeded", generation, screen: "inbox", data: chatRows(result.chats), coverage: coverage(result.coverage), nextCursor: stringValue(result.next_cursor), append });
  }

  private async refreshSearch(generation: number, cursor?: string, append = false): Promise<void> {
    const input = this.search;
    if (input === undefined) return;
    const params = { ...input, ...(cursor === undefined ? {} : { cursor }) } as unknown as JsonObject;
    const result = await this.call("search", generation, "message.search", params);
    if (result !== undefined) this.update({ type: "querySucceeded", generation, screen: "search", data: messageRows(result.messages), coverage: coverage(result.coverage), nextCursor: stringValue(result.next_cursor), append });
  }

  private intervalForActiveChat(): { from_ts: number; to_ts: number } {
    if (this.search !== undefined && this.activeChat !== undefined
      && this.search.chat.platform === this.activeChat.platform
      && this.search.chat.account === this.activeChat.account
      && this.search.chat.chat_id === this.activeChat.chat_id) return this.search.interval;
    const period = /^(\d+)(h|d)$/.exec(this.current.period ?? "24h");
    const seconds = period === null ? 86_400 : Number(period[1]) * (period[2] === "d" ? 86_400 : 3_600);
    const to_ts = Math.floor(Date.now() / 1_000);
    return { from_ts: to_ts - seconds, to_ts };
  }

  private async submitSearch(query: string): Promise<void> {
    const chat = this.search?.chat ?? this.activeChat;
    if (chat === undefined) {
      this.replace({ ...this.current, notice: "search unavailable — open a chat first" });
      return;
    }
    this.search = { chat, interval: this.search?.interval ?? this.intervalForActiveChat(), query };
    await this.refreshSearch(this.generation);
    if (this.current.views.search.status !== "error") {
      this.replace({ ...this.current, notice: "search submitted — query remains memory-only" });
    }
  }

  private async backfill(): Promise<void> {
    const chat = this.activeChat;
    if (chat === undefined) {
      this.replace({ ...this.current, notice: "backfill unavailable — open a chat first" });
      return;
    }
    const interval = this.intervalForActiveChat();
    try {
      await this.options.client.request("sync.backfill", { ...chat, ...interval });
      this.replace({ ...this.current, notice: "backfill requested — no action retried after disconnect" });
    } catch (error) {
      this.replace({ ...this.current, notice: `backfill failed — ${error instanceof Error ? error.message : "check daemon and retry"}` });
    }
  }

  private async propose(body: string): Promise<void> {
    const scope = this.activeChat;
    if (scope === undefined) {
      this.replace({ ...this.current, notice: "proposal unavailable — open a chat first" });
      return;
    }
    try {
      await this.options.client.request("safety.intent.create", { actor: this.options.actor ?? "tui:local", scope, body });
      this.update({ type: "event", generation: this.generation, method: "safety.intent.changed" });
      await this.refresh();
      this.replace({ ...this.current, notice: "proposal created — approve from Approvals with a code" });
    } catch (error) {
      this.replace({ ...this.current, notice: `proposal failed — ${error instanceof Error ? error.message : "check daemon and retry"}` });
    }
  }

  private async refreshChat(generation: number, cursor?: string, append = false): Promise<void> {
    const chat = this.activeChat;
    if (chat === undefined) return;
    const result = await this.call("chat", generation, "message.inbox", { chat, ...(cursor === undefined ? {} : { cursor }) });
    if (result !== undefined) this.update({ type: "querySucceeded", generation, screen: "chat", data: messageRows(result.messages), coverage: coverage(result.coverage), nextCursor: stringValue(result.next_cursor), append });
  }

  private async refreshApprovals(generation: number): Promise<void> {
    const result = await this.call("approvals", generation, "safety.intent.listPending", {});
    if (result === undefined) return;
    this.approvals.clear();
    this.approvalCodes.clear();
    const rows = records(result.intents).flatMap((intent) => {
      const id = stringValue(intent.intent_id);
      const actor = stringValue(intent.actor);
      const scope = chatRef(intent.scope);
      if (id === undefined || actor === undefined || scope === undefined) return [];
      this.approvals.set(id, { actor, scope });
      const code = stringValue(intent.approval_code);
      if (code !== undefined) this.approvalCodes.set(id, code);
      // The code stays outside serializable TuiState in a controller-private map.
      return [{ id, state: stringValue(intent.state), destination: `${scope.platform}:${scope.account}:${scope.chat_id}`, expires: String(intent.expires_at ?? "?"), body: stringValue(intent.body), codeRequired: true }];
    });
    this.update({ type: "querySucceeded", generation, screen: "approvals", data: rows });
  }

  private async refreshDoctor(generation: number): Promise<void> {
    const status = await this.call("doctor", generation, "system.status", {});
    if (status === undefined) return;
    const sync = await this.options.client.request("sync.status", {}).catch(() => ({ state: "unknown" }));
    const auth = await this.options.client.request("auth.status", {}).catch(() => ({ authenticated: false }));
    if (generation !== this.generation) return;
    this.update({ type: "querySucceeded", generation, screen: "doctor", data: [
      { id: "encryption", state: stringValue(status.encryption) ?? "unknown" },
      { id: "authentication", state: auth.authenticated === true ? "healthy" : "unknown" },
      { id: "sync", state: stringValue(sync.state) ?? "unknown" },
    ] });
  }

  private async openFocusedChat(): Promise<void> {
    const row = this.current.views.inbox.data[this.current.focus];
    if (row?.chat === undefined) return;
    this.activeChat = row.chat;
    this.update({ type: "switchScreen", screen: "chat" });
    this.update({ type: "event", generation: this.generation, method: "message.upserted" });
    await this.refresh();
  }

  private async approve(code: string): Promise<void> {
    const row = this.current.views.approvals.data[this.current.selected.approvals];
    const pending = row === undefined ? undefined : this.approvals.get(row.id);
    if (row === undefined || pending === undefined) {
      this.replace({ ...this.current, notice: "approval unavailable — refresh pending approvals" });
      return;
    }
    try {
      await this.options.client.request("safety.intent.approve", { intent_id: row.id, code, actor: pending.actor, scope: pending.scope });
      this.replace({ ...this.current, notice: "approval submitted; code cleared from memory" });
      this.update({ type: "event", generation: this.generation, method: "safety.intent.changed" });
      await this.refresh();
    } catch (error) {
      this.replace({ ...this.current, notice: `approval failed — ${error instanceof Error ? error.message : "refresh and retry"}` });
    }
  }
}

export function createTuiController(options: TuiControllerOptions): TuiController {
  return new TuiController(options);
}

export type TuiRole = Extract<ClientRole, "reader" | "approver">;

export * from "./runtime.ts";
export * from "./transport.ts";
