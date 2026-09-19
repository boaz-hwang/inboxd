import { pickAttachment } from "../../host/src/attachments.ts";
import type { LocalAttachment } from "../../protocol/src/schema.ts";
import { displayWidth, truncateCells, wrapCells, fit } from "./text.ts";
export { displayWidth, truncateCells, wrapCells } from "./text.ts";
import { renderWorkspace } from "./workspace.ts";
import { conversationRows, filteredMessages, sameResource, platformOptions, isArchivedResource } from "./workspace-model.ts";
import type {
  ClientRole,
  JsonObject,
  ProtocolEventMethod,
  ProtocolMethod,
  ResourceCapabilityV1,
  ResourceRefV1,
} from "../../protocol/src/schema.ts";
import { parseResourceCapabilities, parseResourceRef } from "../../protocol/src/schema.ts";
import type { CliRenderer } from "@opentui/core";

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
  /** Exact versioned capability identity for this row. */
  resource?: ResourceRefV1;
  /** Protocol identity; display IDs are never parsed to recover a chat scope. */
  chat?: ChatRef;
  title?: string;
  canSend?: boolean;
  previewOnly?: boolean;
  authorName?: string;
  author?: string;
  ts?: string;
  body?: string;
  edited?: boolean;
  deleted?: boolean;
  state?: string;
  destination?: string;
  expires?: string;
  evidenceOnly?: boolean;
  unread?: string;
  evidenceLines?: string[];
}

interface RetrievalEvidence {
  coverage: JsonObject[];
  unread: JsonObject[];
  identities: JsonObject[];
}

interface View {
  status: ViewStatus;
  data: Row[];
  error?: string;
  /** Opaque daemon continuation token retained only for this in-memory view. */
  nextCursor?: string;
  coverage?: Coverage;
  evidence?: RetrievalEvidence;
}

interface CapabilityView {
  status: ViewStatus;
  data: ResourceCapabilityV1[];
  error?: string;
}

export interface TuiState {
  screen: Screen;
  /** Workspace navigation is separate from message selection. */
  pane?: "filters" | "rooms" | "messages";
  accountMode?: boolean;
  sendPending?: boolean;
  attachment?: LocalAttachment;
  attachmentPicking?: boolean;
  lastSend?: { requestId: string; resource: ResourceRefV1; state: string };
  roomFocus?: number;
  directory?: Row[];
  directoryRefreshing?: boolean;
  draftCursor?: number;
  focus: number;
  selected: Record<Screen, number>;
  views: Record<Screen, View>;
  capabilities: CapabilityView;
  coverage: Coverage;
  connection: { status: ConnectionStatus; generation: number; subscribedGeneration: number; stale: boolean };
  requery: Screen[];
  requeryCapabilities: boolean;
  helpOpen: boolean;
  /** Narrow terminals replace the list with the activated row's detail. */
  detailOpen: boolean;
  detailOffset: number;
  detailRow?: Row;
  finderActive?: boolean;
  finderQuery?: string;
  searchActive: boolean;
  /** Search text is process-memory-only and is cleared on cancel or exit. */
  searchQuery: string;
  /** Compose is available only for an open Chat and is cleared on cancel or exit. */
  composeActive: boolean;
  composeMode?: "text" | "reply" | "approved_template";
  replyTo?: string;
  templateStep?: "template_id" | "arguments" | "preview";
  templateId: string;
  templateArguments: string;
  /** Compose content never leaves memory and is cleared when the operator exits. */
  draft: string;
  notice?: string;
  platform?: string;
  period?: string;
  quitRequested: boolean;
  activeChat?: ChatRef;
  activeResource?: ResourceRefV1;
}

export type TuiAction =
  | { type: "key"; key: string }
  | { type: "switchScreen"; screen: Screen }
  | { type: "connected"; generation: number }
  | { type: "subscribed"; generation: number }
  | { type: "disconnected"; generation: number; degraded?: boolean }
  | { type: "queryLoading"; generation: number; screen: Screen }
  | { type: "querySucceeded"; generation: number; screen: Screen; data: Row[]; coverage?: Coverage; evidence?: RetrievalEvidence; nextCursor?: string; append?: boolean }
  | { type: "queryFailed"; generation: number; screen: Screen; error: string; coverage?: Coverage }
  | { type: "querySkipped"; generation: number; screen: Screen }
  | { type: "capabilityLoading"; generation: number }
  | { type: "capabilitySucceeded"; generation: number; data: ResourceCapabilityV1[] }
  | { type: "capabilityFailed"; generation: number; error: string }
  | { type: "coverage"; coverage: Coverage }
  | { type: "event"; generation: number; method: ProtocolEventMethod };

const screenLabels: Record<Screen, string> = {
  inbox: "INBOX",
  search: "SEARCH",
  chat: "CHAT",
  approvals: "HISTORY",
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
    pane: "rooms",
    roomFocus: 0,
    directory: [],
    focus: 0,
    selected: { inbox: 0, search: 0, chat: 0, approvals: 0, doctor: 0 },
    views: views(),
    capabilities: { status: "idle", data: [] },
    coverage: { freshness: "unknown" },
    connection: { status: "reconnecting", generation: 0, subscribedGeneration: 0, stale: false },
    requery: [],
    requeryCapabilities: false,
    helpOpen: false,
    detailOpen: false,
    detailOffset: 0,
    searchActive: false,
    searchQuery: "",
    composeActive: false,
    templateId: "",
    templateArguments: "",
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
  if (method === "safety.intent.changed") return ["approvals", "doctor"];
  return ["inbox", "search", "chat", "doctor"];
}

function maxFocus(state: TuiState): number {
  return Math.max(0, visibleRows(state, state.screen).length - 1);
}

function templateArgumentsObject(value: string): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : undefined;
  } catch {
    return undefined;
  }
}

const nonTextKeys = new Set(["Enter", "Escape", "Backspace", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", "Tab", "ArrowLeft", "ArrowRight", "Delete", "ShiftEnter", "Find", "MessageSearch"]);

function printableInput(key: string): string | undefined {
  return key.length > 0 && !nonTextKeys.has(key) && !/[\u0000-\u001f\u007f-\u009f]/u.test(key) ? key : undefined;
}

function removeLastGrapheme(value: string): string {
  if (value.length === 0) return value;
  const segments = typeof Intl.Segmenter === "function"
    ? Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value), part => part.segment)
    : Array.from(value);
  segments.pop();
  return segments.join("");
}

/** Pure state reducer. A generation must subscribe before its responses or events are trusted. */
export function reduce(state: TuiState, action: TuiAction): TuiState {
  if (action.type === "switchScreen") return { ...state, pane: action.screen === "inbox" || (action.screen === "chat" && !state.activeResource) ? "rooms" : "messages", screen: action.screen, focus: state.selected[action.screen], helpOpen: false, detailOpen: false, detailOffset: 0 };
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
      requeryCapabilities: true,
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
      capabilities: state.capabilities.status === "ready" || state.capabilities.status === "empty"
        ? { ...state.capabilities, status: "stale" }
        : state.capabilities,
      connection: { ...state.connection, status: action.degraded ? "degraded" : "reconnecting", subscribedGeneration: 0, stale: true },
      requeryCapabilities: false,
      detailOpen: false,
      searchActive: false,
      finderActive: false,
      finderQuery: "",
      searchQuery: "",
      composeActive: false,
      composeMode: undefined,
      replyTo: undefined,
      templateStep: undefined,
      templateId: "",
      templateArguments: "",
      draft: "",
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
      coverage: action.coverage,
      evidence: action.evidence,
    });
    const last = Math.max(0, data.length - 1);
    return {
      ...next,
      focus: action.screen === next.screen ? Math.min(next.focus, last) : next.focus,
      selected: { ...next.selected, [action.screen]: Math.min(next.selected[action.screen], last) },
      coverage: action.coverage ?? next.coverage,
      ...settleRequery(next, action.screen),
    };
  }
  if (action.type === "queryFailed") {
    if (!accepted(state, action.generation)) return state;
    const next = withView(state, action.screen, { ...state.views[action.screen], status: "error", data: action.screen === "inbox" ? [] : state.views[action.screen].data, error: action.error, nextCursor: undefined, coverage: action.coverage ?? state.views[action.screen].coverage });
    return { ...next, ...settleRequery(next, action.screen) };
  }
  if (action.type === "querySkipped") {
    if (!accepted(state, action.generation)) return state;
    return { ...state, ...settleRequery(state, action.screen) };
  }
  if (action.type === "capabilityLoading") {
    if (!accepted(state, action.generation)) return state;
    return { ...state, capabilities: { ...state.capabilities, status: "loading", error: undefined } };
  }
  if (action.type === "capabilitySucceeded") {
    if (!accepted(state, action.generation)) return state;
    const focusedRoom = conversationRows(state)[state.roomFocus ?? 0]?.resource;
    const next: TuiState = { ...state, requeryCapabilities: false, capabilities: { status: action.data.length === 0 ? "empty" : "ready", data: action.data } };
    const index = conversationRows(next).findIndex(room => sameResource(room.resource, focusedRoom));
    return { ...next, roomFocus: Math.max(0, index) };
  }
  if (action.type === "capabilityFailed") {
    if (!accepted(state, action.generation)) return state;
    return { ...state, requeryCapabilities: false, capabilities: { status: "error", data: [], error: action.error } };
  }
  if (action.type === "coverage") return { ...state, coverage: action.coverage };
  if (action.type === "event") {
    if (!accepted(state, action.generation)) return state;
    return {
      ...state,
      requery: [...new Set([...state.requery, ...eventScreens(action.method)])],
      requeryCapabilities: state.requeryCapabilities || action.method === "capability.changed",
      notice: "update received — re-query required",
    };
  }

  if (action.key === "Escape") {
    if (state.finderActive || state.finderQuery) return { ...state, finderActive: false, finderQuery: "", roomFocus: 0, notice: undefined };
    if (state.searchActive) return { ...state, searchActive: false, searchQuery: "", notice: "search query cleared from memory" };
    if (state.composeActive) return { ...state, composeActive: false, composeMode: undefined, replyTo: undefined, templateStep: undefined, templateId: "", templateArguments: "", draft: "", notice: "compose draft cleared from memory" };
    if (state.helpOpen) return { ...state, helpOpen: false };
    if (state.detailOpen) return { ...state, detailOpen: false, notice: "detail closed" };
    return state;
  }
  if (state.finderActive) {
    if (action.key === "ArrowDown" || action.key === "ArrowUp") return { ...state, roomFocus: Math.max(0, Math.min(conversationRows(state).length - 1, (state.roomFocus ?? 0) + (action.key === "ArrowDown" ? 1 : -1))) };
    if (action.key === "Backspace") return { ...state, finderQuery: removeLastGrapheme(state.finderQuery ?? ""), roomFocus: 0 };
    if (action.key === "Enter") return { ...state, finderActive: false };
    const input = printableInput(action.key);
    if (input !== undefined) return { ...state, finderQuery: (state.finderQuery ?? "") + input, roomFocus: 0 };
    return state;
  }
  if (state.searchActive) {
    if (action.key === "Enter") {
      if (state.searchQuery.trim().length === 0) return { ...state, notice: "search query required" };
      return { ...state, searchActive: false, notice: "search submitted — query remains memory-only" };
    }
    if (action.key === "Backspace") return { ...state, searchQuery: removeLastGrapheme(state.searchQuery) };
    const input = printableInput(action.key);
    if (input !== undefined) return { ...state, searchQuery: state.searchQuery + input };
    return state;
  }
  if (state.composeActive) {
    if (state.composeMode !== "approved_template") {
      const cursor = Math.min(state.draftCursor ?? state.draft.length, state.draft.length);
      const left = state.draft.slice(0, cursor), right = state.draft.slice(cursor);
      const previous = removeLastGrapheme(left).length;
      const next = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(right)[Symbol.iterator]().next().value?.segment.length ?? 0;
      if (action.key === "ArrowLeft") return { ...state, draftCursor: previous };
      if (action.key === "ArrowRight") return { ...state, draftCursor: cursor + next };
      if (action.key === "Home") return { ...state, draftCursor: 0 };
      if (action.key === "End") return { ...state, draftCursor: state.draft.length };
      if (action.key === "Backspace") return { ...state, draft: left.slice(0, previous) + right, draftCursor: previous };
      if (action.key === "Delete") return { ...state, draft: left + right.slice(next), draftCursor: cursor };
      const insertion = action.key === "ShiftEnter" ? "\n" : printableInput(action.key);
      if (insertion !== undefined) return { ...state, draft: left + insertion + right, draftCursor: cursor + insertion.length };
    }
    if (state.composeMode === "approved_template") {
      if (action.key === "Enter") {
        if (state.templateStep === "template_id") {
          if (state.templateId.trim().length === 0) return { ...state, notice: "template ID required" };
          return { ...state, templateStep: "arguments", notice: "enter template arguments as a JSON object" };
        }
        if (state.templateStep === "arguments") {
          if (templateArgumentsObject(state.templateArguments) === undefined) return { ...state, notice: "template arguments must be a JSON object" };
          return { ...state, templateStep: "preview", notice: "enter the exact approved-template preview" };
        }
        if (state.draft.trim().length === 0) return { ...state, notice: "template preview required" };
        return { ...state, composeActive: false, composeMode: undefined, templateStep: undefined, templateId: "", templateArguments: "", draft: "", notice: "template send submitting; inputs cleared from memory" };
      }
      if (action.key === "Backspace") {
        if (state.templateStep === "template_id") return { ...state, templateId: removeLastGrapheme(state.templateId) };
        if (state.templateStep === "arguments") return { ...state, templateArguments: removeLastGrapheme(state.templateArguments) };
        return { ...state, draft: removeLastGrapheme(state.draft) };
      }
      const input = printableInput(action.key);
      if (input !== undefined) {
        if (state.templateStep === "template_id") return { ...state, templateId: state.templateId + input };
        if (state.templateStep === "arguments") return { ...state, templateArguments: state.templateArguments + input };
        return { ...state, draft: state.draft + input };
      }
      return state;
    }
    if (action.key === "Enter") {
      if (state.draft.trim().length === 0) return { ...state, notice: "compose body required" };
      return { ...state, composeActive: false, composeMode: undefined, replyTo: undefined, draft: "", notice: "send submitting; draft cleared from memory" };
    }
    if (action.key === "Backspace") return { ...state, draft: removeLastGrapheme(state.draft) };
    const input = printableInput(action.key);
    if (input !== undefined) return { ...state, draft: state.draft + input };
    return state;
  }
  if ((state.screen === "inbox" || state.screen === "chat") && !state.detailOpen) {
    if (action.key === "Tab") return { ...state, pane: state.pane === "filters" ? "rooms" : state.pane === "rooms" ? "messages" : "filters", notice: undefined };
    if (action.key === "[" || action.key === "]" || (state.pane === "filters" && (action.key === "ArrowLeft" || action.key === "ArrowRight"))) {
      const options = platformOptions(state);
      const current = options.indexOf(state.platform ?? "all");
      const platform = options[(current + (action.key === "]" || action.key === "ArrowRight" ? 1 : options.length - 1)) % options.length];
      return { ...state, platform: platform === "all" ? undefined : platform, roomFocus: 0, focus: 0, selected: { ...state.selected, inbox: 0 }, pane: state.pane === "filters" ? "filters" : "rooms", notice: undefined };
    }
    if (state.pane === "rooms" && ["j", "k", "ArrowDown", "ArrowUp"].includes(action.key)) {
      const delta = action.key === "j" || action.key === "ArrowDown" ? 1 : -1;
      return { ...state, roomFocus: Math.max(0, Math.min(conversationRows(state).length - 1, (state.roomFocus ?? 0) + delta)) };
    }
  }
  if (action.key === "PageDown") return { ...state, detailOffset: state.detailOffset + 8 };
  if (action.key === "PageUp") return { ...state, detailOffset: Math.max(0, state.detailOffset - 8) };
  if (action.key === "Home") return { ...state, detailOffset: 0 };
  if (action.key >= "1" && action.key <= "5") return reduce(state, { type: "switchScreen", screen: screens[Number(action.key) - 1]! });
  if (action.key === "?") return { ...state, helpOpen: !state.helpOpen };
  if (action.key === "Find") return { ...state, screen: "inbox", finderActive: true, finderQuery: "", platform: undefined, pane: "rooms", roomFocus: 0, notice: undefined };
  if (action.key === "/" || action.key === "MessageSearch") return { ...state, screen: "search", platform: state.accountMode ? state.platform : undefined, searchActive: true, searchQuery: "", helpOpen: false, notice: "search input is memory-only" };
  if (action.key === "q") return { ...state, quitRequested: true, detailOpen: false, draft: "", searchQuery: "", composeActive: false, composeMode: undefined, replyTo: undefined, templateStep: undefined, templateId: "", templateArguments: "", notice: "memory drafts cleared on exit" };
  if (action.key === "j" || action.key === "ArrowDown") { const focus = Math.min(maxFocus(state), state.focus + 1); return { ...state, focus, detailOffset: 0, selected: state.screen === "approvals" ? { ...state.selected, approvals: focus } : state.selected }; }
  if (action.key === "k" || action.key === "ArrowUp") { const focus = Math.max(0, state.focus - 1); return { ...state, focus, detailOffset: 0, selected: state.screen === "approvals" ? { ...state.selected, approvals: focus } : state.selected }; }
  if (action.key === "d") {
    return { ...state, selected: { ...state.selected, [state.screen]: state.focus }, detailOpen: true, detailRow: undefined, detailOffset: 0, notice: `${screenLabels[state.screen].toLowerCase()} detail opened` };
  }
  if (action.key === "Enter") {
    return { ...state, selected: { ...state.selected, [state.screen]: state.focus }, detailOpen: false, detailOffset: 0, notice: `${screenLabels[state.screen].toLowerCase()} selection activated` };
  }
  if (action.key === "b") {
    if (state.connection.status !== "connected") return { ...state, notice: "backfill disabled while disconnected" };
    if (!capabilityClaimsCurrent(state)) return { ...state, notice: capabilityRefreshNotice("backfill", state) };
    const resource = selectedResource(state);
    const capability = selectedCapability(state);
    if (resource?.kind !== "chat" || capability === undefined) return { ...state, notice: "backfill disabled — exact resource capability unavailable" };
    if (capability.auth.state !== "authenticated") return { ...state, notice: `backfill disabled — AUTH ${capability.auth.state} reason=${capability.auth.reason}` };
    if (capability.read.mode === "none") return { ...state, notice: "backfill disabled — exact resource is not readable" };
    return { ...state, notice: "backfill requested — no action retried after disconnect" };
  }
  if (action.key === "n") {
    if (state.connection.status !== "connected") return { ...state, notice: "more results disabled while disconnected" };
    if (state.views[state.screen].nextCursor === undefined) return { ...state, notice: "no more results" };
    return { ...state, notice: "fetching more results" };
  }
  if (action.key === "c") {
    if (state.sendPending) return { ...state, notice: "전송 중입니다." };
    if (state.screen !== "chat") return { ...state, notice: "compose is only available in Chat" };
    if (state.connection.status !== "connected") return { ...state, notice: "compose disabled while disconnected" };
    if (!capabilityClaimsCurrent(state)) return { ...state, composeActive: false, draft: "", notice: capabilityRefreshNotice("compose", state) };
    const capability = selectedCapability(state);
    if (capability === undefined) return { ...state, composeActive: false, draft: "", notice: isArchivedResource(state, selectedResource(state)) ? "보관 기록은 읽기 전용입니다. / 로 현재 연결된 대화를 선택하세요." : "compose disabled — exact resource capability unavailable" };
    if (capability.auth.state !== "authenticated") return { ...state, composeActive: false, draft: "", notice: `compose disabled — AUTH ${capability.auth.state} reason=${capability.auth.reason}` };
    if (capability.write.mode !== "send") return { ...state, composeActive: false, draft: "", notice: "compose disabled — exact resource is read-only" };
    if (capability.write.content_mode === "approved_template") return {
      ...state,
      composeActive: true,
      composeMode: "approved_template",
      templateStep: "template_id",
      templateId: "",
      templateArguments: "",
      draft: "",
      notice: "compose approved template — inputs remain memory-only",
    };
    if (capability.write.content_mode !== "text") return { ...state, composeActive: false, draft: "", notice: "compose disabled — text capability unavailable" };
    return { ...state, composeActive: true, composeMode: "text", replyTo: undefined, draft: "", draftCursor: 0, notice: "compose text — draft remains memory-only" };
  }
  if (action.key === "r") {
    if (state.screen !== "chat") return { ...state, notice: "reply is only available in Chat" };
    if (state.connection.status !== "connected") return { ...state, notice: "reply disabled while disconnected" };
    if (!capabilityClaimsCurrent(state)) return { ...state, composeActive: false, draft: "", notice: capabilityRefreshNotice("reply", state) };
    const capability = selectedCapability(state);
    if (capability?.auth.state !== "authenticated" || capability.write.mode !== "send" || capability.write.content_mode !== "text" || !capability.write.reply) {
      return { ...state, composeActive: false, draft: "", notice: "reply capability unavailable for exact resource" };
    }
    const row = visibleRows(state, "chat")[state.focus];
    if (row === undefined) return { ...state, composeActive: false, draft: "", notice: "reply unavailable — select a message" };
    return { ...state, composeActive: true, composeMode: "reply", replyTo: row.id, draft: "", draftCursor: 0, notice: `reply to ${row.id} — draft remains memory-only` };
  }
  return state;
}

function count(value: number | undefined, label: string): string {
  return `${value === undefined ? "?" : value} ${label}`;
}

function coverageText(coverage: Coverage): string {
  const limits = coverage.limits === undefined ? "" : ` / ${count(coverage.limits, "limits")}`;
  return `${coverage.freshness} · ${count(coverage.chats, "chats")} / ${count(coverage.gaps, "gaps")}${limits}`;
}

function visibleRows(state: TuiState, screen: Screen): Row[] {
  if (screen === "chat" && state.activeResource === undefined) {
    return state.capabilities.data.map(capability => ({
      id: resourceKey(capability.resource),
      resource: capability.resource,
      chat: capability.resource.kind === "chat"
        ? { platform: capability.resource.platform, account: capability.resource.account, chat_id: capability.resource.chat_id }
        : undefined,
      author: resourcePath(capability.resource),
      body: `READ ${capability.read.mode} · WRITE ${capability.write.mode}/${capability.write.content_mode} · AUTH ${capability.auth.state}`,
    }));
  }
  return screen === "inbox" || screen === "search" ? filteredMessages(state, screen) : state.views[screen].data;
}

function exactChatResource(chat: ChatRef): ResourceRefV1 {
  return { v: 1, kind: "chat", platform: chat.platform, account: chat.account, chat_id: chat.chat_id };
}

function rowResource(row: Row | undefined): ResourceRefV1 | undefined {
  return row?.resource ?? (row?.chat === undefined ? undefined : exactChatResource(row.chat));
}

function resourceKey(resource: ResourceRefV1): string {
  return JSON.stringify(resource);
}

function resourcePath(resource: ResourceRefV1): string {
  const id = resource.kind === "chat" ? `chat:${resource.chat_id}` : `destination:${resource.destination_id}`;
  return `${resource.platform} › ${resource.account} › ${id}`;
}

function selectedResource(state: TuiState): ResourceRefV1 | undefined {
  if (state.detailOpen && state.detailRow) return rowResource(state.detailRow);
  if (!state.detailOpen && state.pane === "rooms" && (state.screen === "inbox" || state.screen === "chat")) return conversationRows(state)[state.roomFocus ?? 0]?.resource;
  if (state.screen === "chat") {
    return state.activeResource
      ?? rowResource(visibleRows(state, "chat")[state.selected.chat])
      ?? (state.activeChat === undefined ? undefined : exactChatResource(state.activeChat));
  }
  return rowResource(visibleRows(state, state.screen)[state.selected[state.screen]]);
}

function focusedResource(state: TuiState): ResourceRefV1 | undefined {
  return rowResource(visibleRows(state, state.screen)[state.focus]);
}

function selectedCapability(state: TuiState): ResourceCapabilityV1 | undefined {
  const resource = selectedResource(state);
  return resource === undefined ? undefined : state.capabilities.data.find(item => resourceKey(item.resource) === resourceKey(resource));
}

function capabilityClaimsCurrent(state: TuiState): boolean {
  return state.connection.status === "connected"
    && !state.connection.stale
    && !state.requeryCapabilities
    && state.capabilities.status === "ready";
}

function capabilityRefreshNotice(action: "compose" | "reply" | "backfill", state: TuiState): string {
  const reason = state.requeryCapabilities || state.capabilities.status === "loading"
    ? "capability refresh in progress"
    : "current capability unavailable";
  return `${action} disabled — ${reason}`;
}

function resourceContextLines(state: TuiState): string[] {
  const resource = selectedResource(state);
  const capability = selectedCapability(state);
  if (resource === undefined) return ["Resource: none", "READ unknown", "WRITE unknown", "RECEIPT unknown", "AUTH unknown reason=capability_unavailable"];
  if (capability === undefined) return [`Resource: ${resourcePath(resource)}`, "READ unknown", "WRITE unknown", "RECEIPT unknown", "AUTH unknown reason=capability_unavailable"];
  const limits = capability.read.limits;
  const read = limits === null
    ? `READ ${capability.read.mode}`
    : `READ ${capability.read.mode} max_page=${limits.max_page_size} pages=${limits.max_pages} cursor=${limits.cursor}`;
  return [
    `Resource: ${resourcePath(resource)}`,
    read,
    `WRITE ${capability.write.mode} content=${capability.write.content_mode} reply=${capability.write.reply ? "yes" : "no"}`,
    `RECEIPT ${capability.receipt.level}`,
    `AUTH ${capability.auth.state} reason=${capability.auth.reason ?? "none"} observed_at=${capability.auth.observed_at}`,
  ];
}

function dataLines(state: TuiState, screen: Screen, empty: string, height: number): string[] {
  const view = state.views[screen];
  if (view.status === "loading") return ["> Loading…"];
  if (view.status === "error") {
    if (view.error?.includes("100-chat limit")) return [`> ${view.error}`, "Recovery: configure at most 100 chats.", "Restart daemon and TUI to reload scope."];
    if (view.error?.includes("discovery")) return [`> ${view.error}`, "Recovery: fix connector pagination.", "Restart daemon and TUI to reload scope."];
    return [`> ${view.error} — retry query`];
  }
  const more = view.nextCursor === undefined ? [] : ["  more results [n] — fetch next page"];
  const rows = visibleRows(state, screen);
  if (view.status === "empty" || rows.length === 0) return [`> ${empty}`, ...more];
  const capacity = Math.max(1, height - (view.nextCursor === undefined ? 0 : 1));
  const start = Math.max(0, Math.min(state.focus - capacity + 1, rows.length - capacity));
  const data = rows.slice(start, start + capacity).map((row, offset) => {
    const index = start + offset;
    const focus = index === state.focus ? ">" : " ";
    const selected = index === state.selected[screen] ? "●" : "○";
    const revision = row.deleted ? " deleted" : row.edited ? " (edited)" : "";
    const identity = rowResource(row);
    return `${focus} ${selected} ${identity === undefined ? "" : resourcePath(identity)} ${row.author ?? row.state ?? "item"} ${row.unread ?? ""} ${row.ts ?? row.expires ?? ""} ${row.destination ?? ""} ${row.body ?? ""}${revision}`.replace(/\s+/g, " ").trimEnd();
  });
  return [...data, ...more];
}

function listContentLines(state: TuiState, height: number): string[] {
  const screen = state.screen;
  const view = state.views[screen];
  if (screen === "inbox") return ["Inbox", ...dataLines(state, screen, "No messages", height - 1)];
  if (screen === "search") {
    const query = state.searchQuery.length === 0 ? "(memory-only)" : `${state.searchQuery} [memory-only]`;
    const inputHint = state.searchActive ? " · Enter submit · Esc cancel" : "";
    return [`Search query: ${query}${inputHint}`, `Coverage: ${coverageText(state.coverage)}`, "", "Results", ...dataLines(state, screen, "No results", height - 4)];
  }
  if (screen === "chat") {
    const compose: string[] = [];
    if (state.activeResource === undefined) return ["Resources — Enter open", ...dataLines(state, screen, "No capability resources", height - 1)];
    const gap = `── coverage gap: ${state.coverage.gaps === undefined ? "?" : state.coverage.gaps} · ${state.coverage.freshness} ──`;
    const delivery = deliveryLines(state);
    return ["Chat", ...compose, gap, ...delivery, ...dataLines(state, screen, "No messages", height - 2 - compose.length - delivery.length)];
  }
  if (screen === "approvals") {
    const disabled = "Historical record [read-only]";
    const uncertain = visibleRows(state, screen).some((row) => row.state === "Uncertain") ? ["Queue: UNCERTAIN — do not resend automatically"] : [];
    const prompt: string[] = [];
    const delivery = deliveryLines(state);
    return ["History", ...delivery, ...dataLines(state, screen, "No historical records", height - 2 - delivery.length - uncertain.length - prompt.length), ...uncertain, disabled, ...prompt];
  }
  const stale = state.connection.stale ? "stale response retained" : "connected";
  const diagnostics = ["encryption", "authentication", "sync", "isolation"].flatMap((id, index) => {
    const row = view.data.find(item => item.id === id);
    const label = id[0]!.toUpperCase() + id.slice(1);
    return [`${state.focus === index ? ">" : " "} ${label}: ${row?.state ?? "unknown"}`, ...(row?.evidenceLines ?? []).map(line => `  ${line}`)];
  });
  return ["Doctor · C connect accounts", ...diagnostics, `  Daemon: ${stale}`, `  Connection: ${state.connection.status}`, `  Generation: ${state.connection.generation} / subscribed ${state.connection.subscribedGeneration}`];
}


function deliveryMeaning(state: string | undefined): string | undefined {
  if (state === "Sent") return "acknowledged; not verified";
  if (state === "Verified") return "destination read-back matched";
  if (state === "Uncertain") return "outcome unknown; do not resend";
  return undefined;
}

function deliveryLines(state: TuiState): string[] {
  const rows = state.views.approvals.data.filter(row => deliveryMeaning(row.state) !== undefined && (state.screen === "approvals" || sameChat(row.chat, state.activeChat)));
  return rows.length === 0 ? [] : ["Delivery: session observations", ...[...new Set(rows.map(row => `${row.state}: ${deliveryMeaning(row.state)}`))]];
}

function detailLines(state: TuiState, width: number, height: number): string[] {
  const screen = state.screen;
  const row = state.detailRow ?? visibleRows(state, screen)[state.selected[screen]];
  const title = `Detail — ${screenLabels[screen][0]}${screenLabels[screen].slice(1).toLowerCase()}`;
  if (row === undefined) return [title, ...(screen === "chat" ? deliveryLines(state) : []), "No selected item", "Back: Esc"];
  const details = [
    rowResource(row) === undefined ? undefined : `Resource: ${resourcePath(rowResource(row)!)}`,
    row.unread,
    ...(row.evidenceLines ?? []),
    row.author === undefined ? undefined : `Author: ${row.author}`,
    row.state === undefined ? undefined : `State: ${row.state}`,
    row.ts === undefined ? undefined : `Time: ${row.ts}`,
    row.destination === undefined ? undefined : `Destination: ${row.destination}`,
    row.expires === undefined ? undefined : `Expires: ${row.expires}`,
    row.body === undefined ? undefined : `Message: ${row.body}${row.deleted ? " deleted" : row.edited ? " (edited)" : ""}`,
    screen === "approvals" ? "Historical record [read-only]" : undefined,
  ].filter((line): line is string => line !== undefined);
  const warnings = [
    ...(screen === "chat" ? deliveryLines(state) : []),
    screen === "chat" ? `── coverage gap: ${state.coverage.gaps === undefined ? "?" : state.coverage.gaps} · ${state.coverage.freshness} ──` : undefined,
    screen === "approvals" && visibleRows(state, screen).some((item) => item.state === "Uncertain") ? `${row.state === "Uncertain" ? "Selected" : "Other intent"}: UNCERTAIN — do not resend automatically` : undefined,
  ].filter((line): line is string => line !== undefined);
  const header = [title, `Context: ${state.selected[screen] + 1} of ${visibleRows(state, screen).length} · ${coverageText(state.coverage)}`, ...warnings];
  const content = [`ID: ${row.id}`, ...details].flatMap(line => wrapCells(line, width));
  const capacity = Math.max(1, height - header.length - 1);
  const offset = Math.min(state.detailOffset, Math.max(0, content.length - capacity));
  return [...header, ...content.slice(offset, offset + capacity), `Back: Esc · PgUp/PgDn scroll · Home top (${offset + 1}–${Math.min(offset + capacity, content.length)}/${content.length})`];
}

function joinColumns(left: readonly string[], right: readonly string[], width: number): string[] {
  const leftWidth = Math.floor(width * 0.4);
  const rightWidth = width - leftWidth - 1;
  const rowCount = Math.max(left.length, right.length);
  return Array.from({ length: rowCount }, (_, index) => `${fit(left[index] ?? "", leftWidth)}│${fit(right[index] ?? "", rightWidth)}`);
}

function narrowBodyLines(state: TuiState, height: number, width: number): string[] {
  const prefix = ["DETAIL (in place)", `Evidence rail: ${coverageText(state.coverage)} · ${state.connection.status}${state.connection.stale ? " · stale" : ""}`];
  const content = state.detailOpen ? detailLines(state, width, height - prefix.length - (state.notice === undefined ? 0 : 1)) : listContentLines(state, height - prefix.length - (state.notice === undefined ? 0 : 1));
  return [...prefix, ...content];
}

function wideBodyLines(state: TuiState, width: number, height: number): string[] {
  const list = ["LIST 40%", `Evidence rail: ${coverageText(state.coverage)}`, `Status rail: ${state.connection.status}${state.connection.stale ? " · stale retained" : ""} · generation ${state.connection.generation}/${state.connection.subscribedGeneration}`, ...listContentLines(state, height - 3)];
  const detail = ["DETAIL 60%", `Context rail: ${screenLabels[state.screen]} · focus ${visibleRows(state, state.screen).length ? state.focus + 1 : 0}/${visibleRows(state, state.screen).length}`, ...detailLines(state, width - Math.floor(width * 0.4) - 1, height - 2)];
  return joinColumns(list, detail, width);
}

/** Deterministic fixed-size text renderer used for capture evidence. */
export function renderInspectorScreen(state: TuiState, size: { width: number; height: number }): string {
  state = { ...state, coverage: state.views[state.screen].coverage ?? state.coverage };
  if (size.width < 80 || size.height < 24) {
    return Array.from({ length: Math.max(1, size.height) }, (_, index) => fit(index === 0 ? "terminal too small — minimum 80×24" : "", Math.max(1, size.width))).join("\n");
  }
  const status = `INBOXD · ${state.connection.status}${state.connection.stale ? " · STALE" : ""} · ${state.platform ?? "account ?"}`;
  const tabs = screens.map((screen, index) => screen === state.screen ? `● ${screenLabels[screen]}` : `${index + 1} ${screenLabels[screen]}`).join(" | ");
  const wide = size.width >= 120;
  const resourceLines = resourceContextLines(state);
  const rowsForBody = size.height - 3 - resourceLines.length;
  const inputPanel = state.composeActive && state.composeMode === "approved_template"
      ? [
        `Template ID: ${state.templateId}${state.templateStep === "template_id" ? "_" : ""}`,
        `Arguments JSON: ${state.templateArguments}${state.templateStep === "arguments" ? "_" : ""}`,
        `Preview: ${state.draft}${state.templateStep === "preview" ? "_" : ""}`,
        "[memory-only] · Enter next/send · Esc cancel",
      ]
      : state.composeActive ? [`${state.composeMode === "reply" ? `Reply ${state.replyTo}` : "Compose text"}: ${state.draft || "_"} [memory-only]`, "[memory-only] · Enter send · Esc cancel"] : [];
  const contentHeight = rowsForBody - inputPanel.length - (state.notice === undefined ? 0 : 1) - (state.helpOpen ? 2 : 0);
  const body = wide ? wideBodyLines(state, size.width, contentHeight) : narrowBodyLines(state, contentHeight, size.width);
  if (state.notice) body.push(`! ${state.notice}`);
  if (state.helpOpen) body.push("Keys: 1–5 screens · j/k/↑↓ move · Enter open · / search · n more · b backfill", "      c compose · s send status · Esc cancel/back · ? help · q quit");
  const lines = [status, tabs, ...resourceLines, ...body.slice(0, rowsForBody - inputPanel.length)];
  while (inputPanel.length && lines.length < size.height - 1 - inputPanel.length) lines.push("");
  lines.push(...inputPanel);
  while (lines.length < size.height - 1) lines.push("");
  lines.push("1–5 j/k ↑↓ Enter-open d-detail / n-more b c r-reply s-status Esc ? q");
  return lines.slice(0, size.height).map((line) => fit(line, size.width)).join("\n");
}

/** The workspace is the default; raw evidence is an explicit detail action. */
export function renderScreen(state: TuiState, size: { width: number; height: number }): string {
  if (state.detailOpen) return renderInspectorScreen(state, size);
  return renderWorkspace(state, size);
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
    if (/(draft|query|body|code|token|secret|template|arguments|preview)/i.test(key)) {
      throw new Error(`persistence key ${key} is not persisted`);
    }
    assertNoPersistedSecret(nested);
  }
}

/** Native OpenTUI entry point; callers own the renderer lifecycle. */
export async function mountOpenTui(renderer: CliRenderer, state: TuiState, width = 80, height = 24): Promise<{ destroy(): void }> {
  const coreModule = "@opentui/core";
  const { TextRenderable } = await import(coreModule);
  const text = new TextRenderable(renderer, { id: "inboxd-screen", content: renderScreen(state, { width, height }) });
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
  const text = new TextRenderable(harness.renderer, { id: "inboxd-smoke", content });
  harness.renderer.root.add(text);
  await harness.renderOnce();
  return { content, destroy: () => { text.destroy(); harness.renderer.destroy(); } };
}

export interface TuiProtocolClient {
  /** Real protocol clients clear readiness before rejecting disconnected RPCs. */
  readonly ready?: boolean;
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


export interface TuiControllerOptions {
  readonly pickAttachment?: () => Promise<LocalAttachment | undefined>;
  readonly client: TuiProtocolClient;
  readonly initialState?: TuiState;
  readonly onStateChange?: (state: TuiState) => void;
}

const tuiTopics: readonly ProtocolEventMethod[] = ["account.changed", "message.upserted", "coverage.changed", "safety.intent.changed", "capability.changed"];

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

function resourceRef(value: unknown): ResourceRefV1 | undefined {
  try {
    return parseResourceRef(value);
  } catch {
    return undefined;
  }
}

function historicalResource(intent: Record<string, unknown>): ResourceRefV1 | undefined {
  const resource = resourceRef(record(intent.envelope)?.destination) ?? resourceRef(intent.resource);
  const scope = chatRef(intent.scope);
  return resource ?? (scope === undefined ? undefined : exactChatResource(scope));
}

function historicalBody(intent: Record<string, unknown>): string | undefined {
  const content = record(record(intent.envelope)?.content);
  return stringValue(intent.body) ?? stringValue(content?.body) ?? stringValue(content?.preview);
}

function messageRows(value: unknown, fallbackResource?: ResourceRefV1): Row[] {
  return records(value).flatMap((item) => {
    const id = stringValue(item.msg_id) ?? stringValue(item.id);
    if (id === undefined) return [];
    const chat = chatRef(item);
    const resource = chat === undefined ? fallbackResource : exactChatResource(chat);
    return [{
      id,
      resource,
      chat: chat ?? (resource?.kind === "chat" ? { platform: resource.platform, account: resource.account, chat_id: resource.chat_id } : undefined),
      authorName: stringValue(item.author_name),
      author: stringValue(item.author_id) ?? stringValue(item.author),
      ts: stringValue(item.ts) ?? (numberValue(item.ts) === undefined ? undefined : String(numberValue(item.ts))),
      body: stringValue(item.body),
      edited: item.edited_at != null || item.edited === true,
      deleted: item.deleted_at != null || item.deleted === true,
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
      title: stringValue(item.display_name),
      ts: numberValue(item.latest_ts) === undefined ? undefined : String(item.latest_ts),
      body: stringValue(item.preview),
      canSend: item.can_send === true,
      author: stringValue(item.display_name) ?? ref.chat_id,
      destination: `${ref.platform}:${ref.account}`,
    }];
  });
}

function coverage(value: unknown): Coverage | undefined {
  if (Array.isArray(value)) {
    const summaries = value.map(coverage).filter((item): item is Coverage => item !== undefined);
    return {
      chats: summaries.length,
      gaps: summaries.reduce((sum, item) => sum + (item.gaps ?? 0), 0),
      limits: summaries.reduce((sum, item) => sum + (item.limits ?? 0), 0),
      freshness: summaries.length === 0 ? "unknown" : summaries.some(item => item.freshness === "partial") ? "partial" : summaries.every(item => item.freshness === "fresh") ? "fresh" : "unknown",
    };
  }
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

function sameChat(left: ChatRef | undefined, right: ChatRef | undefined): boolean {
  return left !== undefined && right !== undefined && left.platform === right.platform && left.account === right.account && left.chat_id === right.chat_id;
}

function diagnosticSummary(value: unknown): string | undefined {
  const entries = record(value);
  if (entries === undefined || Object.keys(entries).length === 0) return undefined;
  return Object.entries(entries).map(([name, value]) => `${name}=${stringValue(value) ?? stringValue(record(value)?.state) ?? "unknown"}`).join("; ");
}

function evidenceRows(messages: Row[], evidence: RetrievalEvidence): Row[] {
  const rows = [...messages];
  for (const item of evidence.coverage) {
    const chat = chatRef(record(item.target)?.chat);
    if (chat !== undefined && !messages.some(row => sameChat(row.chat, chat))) {
      rows.push({ id: JSON.stringify(chat), chat, author: chat.chat_id, body: "No message in loaded pages", evidenceOnly: true });
    }
  }
  return rows.map(row => {
    if (row.chat === undefined) return row;
    const unread = evidence.unread.find(item => sameChat(chatRef(item.chat), row.chat));
    const knownCount = unread?.status === "known" ? numberValue(unread.count) : undefined;
    const source = stringValue(unread?.source) ?? "unknown";
    const chatCoverage = evidence.coverage.find(item => sameChat(chatRef(record(item.target)?.chat), row.chat));
    const identity = evidence.identities.find(item => item.platform === row.chat!.platform && item.account === row.chat!.account);
    return { ...row, unread: `Unread: ${knownCount ?? "?"} (${source})`, evidenceLines: [
      ...(stringValue(unread?.reason) === undefined ? [] : [`Unread reason: ${unread!.reason}`]),
      `Coverage: ${coverageText(coverage(chatCoverage) ?? { freshness: "unknown" })}`,
      ...(records(chatCoverage?.gaps).length === 0 ? [] : [`Gap reasons: ${records(chatCoverage?.gaps).map(gap => stringValue(gap.reason) ?? "unknown").join(", ")}`]),
      `Self: ${identity?.status === "known" ? stringValue(identity.self_id) ?? "?" : "?"} (${stringValue(identity?.source) ?? "unknown"})`,
    ] };
  });
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
  private activeResource: ResourceRefV1 | undefined;
  private inboxQuery: { chats: ChatRef[]; interval: { from_ts: number; to_ts: number } } | undefined;
  private search: TuiSearchInput | undefined;
  private readonly inFlightPages = new Set<string>();
  private readonly requests = new Map<Screen, number>();
  private capabilityRequest = 0;
  private accountDirectoryRequest = 0;
  private accountSearchCursors = new Map<string, string | undefined>();
  private accountSearchQuery = "";
  private accountSearchRequest = 0;
  private liveRefresh?: Promise<void>;
  private liveDirectoryDirty = false;
  private liveChatDirty = false;
  private directoryTimer?: ReturnType<typeof setTimeout>;
  private readonly listeners = new Set<(state: TuiState) => void>();

  constructor(private readonly options: TuiControllerOptions) {
    this.current = options.initialState ?? createInitialState();
    this.activeChat = this.current.activeChat;
    this.activeResource = this.current.activeResource
      ?? (this.current.activeChat === undefined ? undefined : exactChatResource(this.current.activeChat));
  }

  get state(): TuiState { return this.current; }


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
    clearTimeout(this.directoryTimer);
    this.liveRefresh = undefined; this.liveDirectoryDirty = false; this.liveChatDirty = false;
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
    clearTimeout(this.directoryTimer);
    this.generation++;
    this.options.client.stop();
    this.inFlightPages.clear();
    this.replace({ ...this.current, draft: "", searchQuery: "", searchActive: false, finderQuery: "", finderActive: false, composeActive: false, composeMode: undefined, replyTo: undefined, templateStep: undefined, templateId: "", templateArguments: "" });
  }

  disconnected(degraded = false): void {
    clearTimeout(this.directoryTimer);
    this.inFlightPages.clear();
    if (this.current.lastSend?.state === "Sending") this.replace({ ...this.current, lastSend: { ...this.current.lastSend, state: "Uncertain" } });
    this.update({ type: "disconnected", generation: this.generation, degraded });
  }

  /** Called by the runtime's ReconnectingProtocolClient event callback. */
  async receiveEvent(method: ProtocolEventMethod, params: JsonObject = {}): Promise<void> {
    if (method === "account.changed" && this.current.accountMode) {
      if (!this.current.accountMode || this.current.connection.status !== "connected" || params.phase === "refreshing") return;
      this.liveDirectoryDirty = true;
      this.liveChatDirty ||= !!this.activeChat && (!params.account || (params.account === this.activeChat.account && params.platform === this.activeChat.platform));
      if (!this.liveRefresh) {
        const generation = this.generation;
        const flight = (async () => {
          while (this.liveDirectoryDirty && generation === this.generation && accepted(this.current, generation)) {
            this.liveDirectoryDirty = false;
            const chat = this.activeChat;
            const reloadChat = this.liveChatDirty;
            this.liveChatDirty = false;
            await this.refreshAccountDirectory(generation);
            if (generation !== this.generation || !accepted(this.current, generation)) return;
            if (reloadChat && chat === this.activeChat) await this.refreshChat(generation, undefined, false, false, true);
            if (generation === this.generation && accepted(this.current, generation)) await this.refreshDoctor(generation);
          }
        })().finally(() => { if (this.liveRefresh === flight) this.liveRefresh = undefined; });
        this.liveRefresh = flight;
      }
      await this.liveRefresh;
      return;
    }
    const generation = this.generation;
    this.update({ type: "event", generation, method });
    if (this.current.accountMode === undefined) return;
    await this.refresh();
  }

  private invalidateView(screen: Screen): void {
    this.requests.set(screen, (this.requests.get(screen) ?? 0) + 1);
    this.replace({
      ...withView(this.current, screen, blankView()),
      focus: this.current.screen === screen ? 0 : this.current.focus,
      selected: { ...this.current.selected, [screen]: 0 },
      detailOpen: this.current.screen === screen ? false : this.current.detailOpen,
    });
  }

  setActiveChat(chat: ChatRef | undefined): void {
    this.setActiveResource(chat === undefined ? undefined : exactChatResource(chat));
  }

  setActiveResource(resource: ResourceRefV1 | undefined): void {
    this.activeResource = resource;
    this.activeChat = resource?.kind === "chat"
      ? { platform: resource.platform, account: resource.account, chat_id: resource.chat_id }
      : undefined;
    this.current = { ...this.current, activeChat: this.activeChat, activeResource: resource, attachment: undefined };
    this.invalidateView("chat");
  }

  setSearch(input: TuiSearchInput | undefined): void {
    this.search = input;
    this.invalidateView("search");
  }

  async selectConversation(index: number): Promise<void> {
    if (this.current.composeActive || this.current.searchActive) return;
    const room = conversationRows(this.current)[index];
    if (!room) return;
    this.setActiveResource(room.resource);
    this.update({ type: "switchScreen", screen: "chat" });
    this.replace({ ...this.current, pane: "messages", finderActive: false, roomFocus: index, notice: undefined });
    if (room.resource.kind === "chat" && this.current.connection.status === "connected") await this.refreshChat(this.generation);
  }

  focusMessages(): void { this.replace({ ...this.current, pane: "messages" }); }

  async dispatchPaste(text: string): Promise<void> {
    if (!this.current.composeActive && !this.current.searchActive && !this.current.finderActive) return;
    if (this.current.composeActive && this.current.composeMode !== "approved_template") {
      const normalized = text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
      if (/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(normalized)) return;
      const cursor = this.current.draftCursor ?? this.current.draft.length;
      this.replace({ ...this.current, draft: this.current.draft.slice(0, cursor) + normalized + this.current.draft.slice(cursor), draftCursor: cursor + normalized.length });
    } else if (printableInput(text) !== undefined) await this.dispatchKey(text);
  }

  async dispatchKey(key: string): Promise<void> {
    if (this.current.sendPending && key === "Enter") return;
    if (this.current.attachmentPicking) return;
    if (key === "Attach" || (key === "a" && this.current.screen === "chat" && !this.current.composeActive && !this.current.searchActive && !this.current.finderActive)) {
      await this.selectAttachment(); return;
    }
    if (this.current.attachment && key === "Escape") { this.replace({ ...this.current, attachment: undefined }); return; }
    if (this.current.attachment && key === "Enter") {
      const file = this.current.attachment, resource = this.activeResource;
      this.replace({ ...this.current, attachment: undefined });
      if (resource?.kind === "chat" && this.canAttach()) await this.sendMessage({ chat: { platform: resource.platform, account: resource.account, chat_id: resource.chat_id }, file: { ...file } }, resource, `[파일] ${file.name}`);
      return;
    }
    if (this.current.attachment && key !== "Quit") return;
    if (key === "Quit") { this.update({ type: "key", key: "Escape" }); this.update({ type: "key", key: "q" }); this.stop(); return; }
    if (key === "Enter" && this.current.finderActive) {
      const index = this.current.roomFocus ?? 0;
      const room = conversationRows(this.current)[index];
      if (room) {
        this.replace({ ...this.current, finderActive: false });
        await this.selectConversation(index);
        this.replace({ ...this.current, finderQuery: "", roomFocus: conversationRows({ ...this.current, finderQuery: "" }).findIndex(item => sameResource(item.resource, room.resource)) });
      }
      return;
    }
    const workspace = this.current;
    const editing = workspace.searchActive || workspace.composeActive || workspace.finderActive;
    if (!editing && !workspace.detailOpen && !workspace.helpOpen && (workspace.screen === "inbox" || workspace.screen === "chat")) {
      if (key === "d" && workspace.pane === "rooms") {
        const room = conversationRows(workspace)[workspace.roomFocus ?? 0];
        const row = room ? workspace.views.inbox.data.find(row => sameResource(rowResource(row), room.resource)) ?? { id: resourceKey(room.resource), resource: room.resource, body: room.preview } : undefined;
        this.replace({ ...workspace, detailOpen: true, detailOffset: 0, detailRow: row, notice: undefined });
        return;
      }
      if (key === "Enter" && workspace.pane === "rooms") {
        await this.selectConversation(workspace.roomFocus ?? 0);
        return;
      }
      if (key === "Enter" && workspace.pane === "messages" && workspace.screen === "chat" && workspace.activeResource) { this.update({ type: "key", key: "c" }); return; }
      if ((key === "c" || key === "r") && workspace.screen === "chat") this.replace({ ...this.current, pane: "messages" });
    }
    const before = this.current;
    const query = before.searchQuery;
    const draft = before.draft;
    const composeMode = before.composeMode;
    const replyTo = before.replyTo;
    const templateStep = before.templateStep;
    const templateId = before.templateId;
    const templateArguments = before.templateArguments;
    const displayedResource = selectedResource(before);
    const focused = focusedResource(before);
    const inputActive = before.searchActive || before.composeActive || before.finderActive;
    const nextCursor = before.views[before.screen].nextCursor;
    this.update({ type: "key", key });
    if (!inputActive && key === "1") this.replace({ ...this.current, platform: undefined, pane: "rooms", roomFocus: 0 });
    if (!inputActive && (key === "[" || key === "]" || before.pane === "filters" && ["ArrowLeft", "ArrowRight"].includes(key)) && this.current.platform && this.activeResource?.platform !== this.current.platform) {
      this.update({ type: "switchScreen", screen: "inbox" });
      if (before.pane === "filters") this.replace({ ...this.current, pane: "filters" });
    }
    if ((key === "MessageSearch" || key === "/") && !inputActive) this.invalidateView("search");
    if (key === "Escape" && before.screen === "search") { this.setSearch(undefined); this.accountSearchRequest++; }
    if (key === "q" && !inputActive) {
      this.stop();
      return;
    }
    if (key === "Enter" && before.searchActive && query.trim().length > 0) await this.submitSearch(query);
    if (key === "Enter" && before.composeActive && composeMode !== "approved_template" && draft.trim().length > 0) {
      await this.sendText(draft, composeMode === "reply" ? replyTo : undefined);
    }
    if (key === "Enter" && before.composeActive && composeMode === "approved_template" && templateStep === "preview" && draft.trim().length > 0) {
      const args = templateArgumentsObject(templateArguments);
      if (args !== undefined) await this.sendTemplate(templateId, args, draft);
    }
    if (key === "s" && !inputActive) await this.recoverSendStatus();
    if (key === "b" && before.connection.status === "connected" && !inputActive) {
      if (this.current.accountMode) { await this.refreshAccountDirectory(this.generation, true); if (this.activeChat) await this.refreshChat(this.generation, undefined, false, true); }
      else await this.backfill(displayedResource);
    }
    if (key === "n" && before.connection.status === "connected" && !inputActive && nextCursor !== undefined) await this.loadMore(before.screen, nextCursor);
    if (key === "Enter" && (before.screen === "inbox" || before.screen === "search") && !inputActive) await this.openFocusedChat();
    if (key === "Enter" && before.screen === "chat" && before.activeResource === undefined && focused !== undefined && !inputActive) {
      this.setActiveResource(focused);
      if (focused.kind === "chat" && this.current.connection.status === "connected") await this.refreshChat(this.generation);
    }
    if (key === "Escape" && before.screen === "chat" && before.activeResource !== undefined && !inputActive && !before.detailOpen && !before.helpOpen) {
      this.setActiveResource(undefined);
      this.update({ type: "switchScreen", screen: "inbox" });
    }
    if (key === "3" && !inputActive && this.activeChat !== undefined && this.current.connection.status === "connected") {
      await this.refreshChat(this.generation);
    }
    if (!inputActive && this.current.screen === "doctor" && (key === "5" || key === "Enter")) {
      await this.refreshDoctor(this.generation);
    }
  }

  async refresh(): Promise<void> {
    const generation = this.generation;
    if (this.current.connection.status !== "connected") return;
    if (this.current.accountMode === undefined) {
      try { const result = await this.options.client.request("account.list", { background: true }); if (generation !== this.generation) return;
        if (result.available === true) { this.replace({ ...this.current, accountMode: true }); await this.refreshAccountDirectory(generation, false, result); }
        else this.replace({ ...this.current, accountMode: false });
      } catch { if (generation !== this.generation || !accepted(this.current,generation)) return; this.replace({ ...this.current, accountMode: false }); }
    }
    if (generation !== this.generation || !accepted(this.current,generation)) return;
    if (this.current.accountMode) {
      if (this.current.requeryCapabilities) await this.refreshAccountDirectory(generation);
      if (generation !== this.generation || !accepted(this.current, generation)) return;
      if (this.current.requery.includes("inbox")) this.accountInbox(generation);
      if (this.current.requery.includes("chat") && this.activeChat) await this.refreshChat(generation);
      if (this.current.requery.includes("doctor")) await this.refreshDoctor(generation);
      this.replace({ ...this.current, requery: [], requeryCapabilities: false });
      return;
    }
    if (this.current.requeryCapabilities) await this.refreshCapabilities(generation);
    if (generation !== this.generation || !accepted(this.current, generation)) return;
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

  private async refreshAccountDirectory(generation: number, refresh = false, first?: JsonObject): Promise<void> {
    try { await this.loadAccountDirectory(generation, refresh, first); }
    catch {
      if (generation !== this.generation || !accepted(this.current, generation)) return;
      this.update({ type: "capabilityFailed", generation, error: "채팅 목록 조회 실패" });
      this.replace({ ...this.current, notice: "채팅 목록 조회 실패 · b로 다시 시도하세요." });
    }
  }

  private async loadAccountDirectory(generation: number, refresh = false, first?: JsonObject): Promise<void> {
    const request = ++this.accountDirectoryRequest;
    const rows: Row[] = []; let cursor: string | undefined; const seen = new Set<string>(); let errors: unknown[] = []; let refreshing = false;
    do {
      const result = first ?? await this.options.client.request("account.list", { ...(cursor ? { cursor } : {}), ...(!cursor ? { background: true, ...(refresh ? { refresh: true } : {}) } : {}) }); first = undefined;
      if (generation !== this.generation || request !== this.accountDirectoryRequest) return;
      refreshing ||= result.refreshing === true;
      rows.push(...chatRows(result.chats)); errors = Array.isArray(result.errors) ? result.errors : [];
      cursor = stringValue(result.next_cursor); if (cursor && seen.has(cursor)) throw new Error("목록 커서 반복"); if (cursor) seen.add(cursor);
    } while (cursor);
    const focused = conversationRows(this.current)[this.current.roomFocus ?? 0]?.resource;
    this.replace({ ...this.current, directory: rows, directoryRefreshing: refreshing, notice: errors.length ? "일부 계정의 채팅 목록을 가져오지 못했습니다. b로 다시 시도하세요." : undefined });
    const capabilities: ResourceCapabilityV1[] = rows.map(row => ({ v: 1, resource: rowResource(row)!,
      read: { mode: "bounded_history", limits: { max_page_size: 80, max_pages: 1, cursor: "opaque" } },
      write: { mode: row.canSend ? "send" : "none", content_mode: row.canSend ? "text" : "none", reply: false },
      receipt: { level: "ack_only" }, auth: { state: errors.some(e => record(e)?.account === row.chat?.account && record(e)?.platform === row.chat?.platform) ? "unknown" : "authenticated", reason: null, observed_at: Date.now()/1000 } }));
    this.update({ type: "capabilitySucceeded", generation, data: capabilities });
    if (focused) this.replace({ ...this.current, roomFocus: Math.max(0, conversationRows(this.current).findIndex(room => sameResource(room.resource, focused))) });
    this.accountInbox(generation);
    clearTimeout(this.directoryTimer);
    if (refreshing) this.directoryTimer = setTimeout(() => {
      if (generation === this.generation && this.current.connection.status === "connected") void this.refreshAccountDirectory(generation);
    }, 100);
  }

  private accountInbox(generation: number): void {
    const data = (this.current.directory ?? []).filter(row => row.body || Number(row.ts)>0).map(row => ({ ...row, previewOnly: true, id: `preview:${row.id}`, resource: rowResource(row) }));
    this.update({ type: "querySucceeded", generation, screen: "inbox", data, coverage: { freshness: "partial" } });
  }

  private canAttach(): boolean {
    const resource = this.activeResource;
    const capability = this.current.capabilities.data.find(item => sameResource(item.resource, resource));
    return this.current.accountMode === true && this.current.screen === "chat" && resource?.kind === "chat"
      && capabilityClaimsCurrent(this.current) && capability?.auth.state === "authenticated"
      && capability.write.mode === "send" && capability.write.content_mode === "text"
      && this.current.connection.status === "connected" && !this.current.sendPending;
  }

  private async selectAttachment(): Promise<void> {
    if (!this.canAttach()) { this.replace({ ...this.current, notice: "첨부 불가 — 대화의 전송 권한을 확인하세요." }); return; }
    if (this.current.draft || this.current.searchActive || this.current.finderActive) { this.replace({ ...this.current, notice: "작성 중인 내용을 보내거나 취소한 뒤 첨부하세요." }); return; }
    const resource = this.activeResource, generation = this.generation;
    this.replace({ ...this.current, attachmentPicking: true, composeActive: false, notice: undefined });
    try {
      const attachment = await (this.options.pickAttachment ?? pickAttachment)();
      if (generation === this.generation && sameResource(resource, this.activeResource)) this.replace({ ...this.current, attachment });
    } catch (error) {
      this.replace({ ...this.current, notice: error instanceof Error ? error.message : "파일을 선택하지 못했습니다." });
    } finally { this.replace({ ...this.current, attachmentPicking: false }); }
  }

  private async sendEnvelope(envelope: JsonObject, resource: ResourceRefV1, preview: string): Promise<void> {
    await this.sendMessage({ envelope }, resource, preview);
  }

  private async sendMessage(payload: JsonObject, resource: ResourceRefV1, preview: string): Promise<void> {
    if (this.current.sendPending) return;
    const requestId = crypto.randomUUID();
    const generation = this.generation;
    this.replace({ ...this.current, sendPending: true, lastSend: { requestId, resource, state: "Sending" }, notice: "전송 중…" });
    try {
      const result = await this.options.client.request("message.send", { request_id: requestId, ...payload });
      if (generation !== this.generation) return;
      const state = stringValue(result.state) ?? "Uncertain";
      this.replace({ ...this.current, lastSend: { requestId, resource, state }, notice: `${state} · ${state === "Sent" || state === "Verified" ? "보냈습니다." : "전송 결과 확인 필요 — 자동 재전송하지 않습니다."} · s 상태 확인` });
      if (state === "Sent" || state === "Verified") {
        if (this.current.accountMode) {
          this.replace({ ...this.current, directory: this.current.directory?.map(row => sameResource(rowResource(row), resource) ? { ...row, ts: String(Date.now()/1000), body: preview } : row) });
          this.accountInbox(generation);
        }
        if (sameResource(this.activeResource, resource)) {
          await this.refreshChat(generation);
          if (generation === this.generation && sameResource(this.activeResource, resource) && this.current.views.chat.status === "ready") {
            const last = Math.max(0, this.current.views.chat.data.length - 1);
            this.replace({ ...this.current, focus: last, selected: { ...this.current.selected, chat: last } });
          }
        }
      }
    } catch {
      if (this.current.lastSend?.requestId === requestId) this.replace({ ...this.current, lastSend: { requestId, resource, state: "Uncertain" }, notice: "Uncertain · 전송 결과 확인 필요 — 자동 재전송하지 않습니다. · s 상태 확인" });
    } finally { this.replace({ ...this.current, sendPending: false }); }
  }

  /** Read-only recovery; never calls message.send again. */
  private async recoverSendStatus(): Promise<void> {
    const send = this.current.lastSend;
    if (!send || this.current.sendPending || this.current.connection.status !== "connected") return;
    try {
      const result = await this.options.client.request("send.status", { id: send.requestId });
      if (this.current.lastSend?.requestId !== send.requestId) return;
      const state = stringValue(result.state) ?? "Uncertain";
      this.replace({ ...this.current, lastSend: { ...send, state }, notice: `${state} · 요청 ${send.requestId}${state === "Uncertain" ? " · 자동 재전송하지 않습니다." : ""}` });
    } catch {
      this.replace({ ...this.current, notice: `상태 확인 실패 · 요청 ${send.requestId} · 자동 재전송하지 않습니다.` });
    }
  }

  private async searchAccounts(query: string, append = false): Promise<void> {
    const generation = this.generation;
    const request = ++this.accountSearchRequest;
    const current = () => generation === this.generation && request === this.accountSearchRequest && !this.current.searchActive;
    this.accountSearchQuery = query;
    if (!append) this.accountSearchCursors.clear();
    this.update({ type: "queryLoading", generation, screen: "search" });
    const accounts = [...new Map((this.current.directory ?? [])
      .filter(row => !this.current.platform || row.chat?.platform === this.current.platform)
      .map(row => [JSON.stringify([row.chat!.platform, row.chat!.account]), row.chat!])).entries()];
    const rows = new Map<string, Row>();
    const identity = (row: Row) => JSON.stringify([row.chat?.platform, row.chat?.account, row.chat?.chat_id, row.id]);
    if (append) for (const row of this.current.views.search.data) rows.set(identity(row), row);
    let failed = false;
    const publish = () => {
      const selected = this.current.views.search.data[this.current.focus];
      const data = [...rows.values()].sort((a,b) => Number(b.ts ?? 0)-Number(a.ts ?? 0));
      this.update({ type: "querySucceeded", generation, screen: "search", data, coverage: { freshness: "partial" }, nextCursor: [...this.accountSearchCursors.values()].some(Boolean) ? "accounts-next" : undefined });
      if (selected) {
        const focus = data.findIndex(row => identity(row) === identity(selected));
        if (focus >= 0) this.replace({ ...this.current, focus, selected: { ...this.current.selected, search: focus } });
      }
    };
    await Promise.all(accounts.map(async ([key, chat]) => {
      if (!current()) return;
      if (append && this.accountSearchCursors.has(key) && !this.accountSearchCursors.get(key)) return;
      const seen = new Set<string>();
      try {
        for (let page = 0; page < 25; page++) {
          const cursor = this.accountSearchCursors.get(key);
          if (cursor && seen.has(cursor)) throw new Error("검색 커서 반복");
          if (cursor) seen.add(cursor);
          this.replace({ ...this.current, notice: "메시지 검색 중…" });
          const result = await this.options.client.request("account.search", { platform: chat.platform, account: chat.account, query, ...(cursor ? { cursor } : {}) });
          if (!current()) return;
          for (const row of messageRows(result.messages)) rows.set(identity(row), row);
          const next = stringValue(result.next_cursor);
          this.accountSearchCursors.set(key, next);
          publish();
          if (!next) break;
        }
      } catch { failed = true; }
    }));
    if (current()) {
      publish();
      this.replace({ ...this.current, notice: failed ? "일부 메신저의 검색이 실패했습니다. 검색 결과는 일부입니다." : [...this.accountSearchCursors.values()].some(Boolean) ? "검색 결과 더 있음 · n 계속 검색" : undefined });
    }
  }

  private async refreshCapabilities(generation: number): Promise<void> {
    if (generation !== this.generation || !accepted(this.current, generation)) return;
    const request = ++this.capabilityRequest;
    const isCurrent = () => generation === this.generation
      && accepted(this.current, generation)
      && this.capabilityRequest === request;
    this.update({ type: "capabilityLoading", generation });
    try {
      const result = await this.options.client.request("capability.list", { refresh: true });
      if (!isCurrent()) return;
      const directory = parseResourceCapabilities(result);
      this.update({ type: "capabilitySucceeded", generation, data: [...directory.resources] });
    } catch (error) {
      if (isCurrent()) this.update({
        type: "capabilityFailed",
        generation,
        error: error instanceof Error ? error.message : "capability query failed",
      });
    }
  }

  private async loadMore(screen: Screen, cursor: string): Promise<void> {
    const view = this.current.views[screen];
    if (view.status === "loading" || view.nextCursor !== cursor) return;
    const generation = this.generation;
    const requestKey = `${generation}\u0000${screen}\u0000${cursor}`;
    if (this.inFlightPages.has(requestKey)) return;
    this.inFlightPages.add(requestKey);
    try {
      if (this.current.accountMode && screen === "search") { await this.searchAccounts(this.accountSearchQuery, true); return; }
      if (screen === "inbox") await this.refreshInbox(generation, cursor, true);
      if (screen === "search") await this.refreshSearch(generation, cursor, true);
      if (screen === "chat") await this.refreshChat(generation, cursor, true);
      if (screen === "approvals") await this.refreshApprovals(generation, cursor, true);
    } finally {
      this.inFlightPages.delete(requestKey);
    }
  }

  private async call(screen: Screen, generation: number, method: ProtocolMethod, params: JsonObject): Promise<{ result: JsonObject; isCurrent(): boolean } | undefined> {
    if (generation !== this.generation || !accepted(this.current, generation)) return undefined;
    const request = (this.requests.get(screen) ?? 0) + 1;
    this.requests.set(screen, request);
    const isCurrent = () => generation === this.generation && accepted(this.current, generation) && this.requests.get(screen) === request;
    this.update({ type: "queryLoading", generation, screen });
    try {
      const result = await this.options.client.request(method, params);
      if (!isCurrent()) return undefined;
      return { result, isCurrent };
    } catch (error) {
      if (isCurrent()) this.update({ type: "queryFailed", generation, screen, error: error instanceof Error ? error.message : "daemon query failed" });
      return undefined;
    }
  }

  private async refreshInbox(generation: number, cursor?: string, append = false): Promise<void> {
    if (!append) {
      // A failed new discovery must never reuse an older scope or continuation.
      this.inboxQuery = undefined;
      this.update({ type: "queryLoading", generation, screen: "inbox" });
      const chats = new Map<string, ChatRef>();
      const directory = new Map<string, Row>();
      const seen = new Set<string>();
      let discoveryCursor: string | undefined;
      let discoveryPages = 0;
      do {
        const discovery = await this.call("inbox", generation, "chat.list", discoveryCursor === undefined ? {} : { cursor: discoveryCursor });
        if (discovery === undefined || !discovery.isCurrent()) return;
        for (const row of chatRows(discovery.result.chats)) {
          chats.set(JSON.stringify(row.chat), row.chat!);
          directory.set(JSON.stringify(row.chat), row);
        }
        discoveryCursor = stringValue(discovery.result.next_cursor);
        if (chats.size > 100 || (discoveryCursor !== undefined && seen.has(discoveryCursor))) {
          this.update({ type: "queryFailed", generation, screen: "inbox", error: chats.size > 100 ? "Partial: 100-chat limit exceeded; no query" : "Partial: discovery cursor repeated; no query", coverage: { freshness: "partial", chats: 0 } });
          return;
        }
        discoveryPages++;
        if (discoveryCursor !== undefined && discoveryPages >= 100) {
          this.update({ type: "queryFailed", generation, screen: "inbox", error: "Partial: discovery page limit; no query", coverage: { freshness: "partial", chats: 0 } });
          return;
        }
        if (discoveryCursor !== undefined) seen.add(discoveryCursor);
      } while (discoveryCursor !== undefined);
      this.replace({ ...this.current, directory: [...directory.values()] });
      this.inboxQuery = { chats: [...chats.values()], interval: this.intervalForActiveChat() };
      if (chats.size === 0) {
        this.update({ type: "querySucceeded", generation, screen: "inbox", data: [], coverage: { freshness: "unknown", chats: 0 } });
        return;
      }
    }
    const query = this.inboxQuery;
    if (query === undefined) return;
    const response = await this.call("inbox", generation, "message.recent", { ...query, ...(cursor === undefined ? {} : { cursor }) } as unknown as JsonObject);
    if (response === undefined || !response.isCurrent()) return;
    const { result } = response;
    const evidence: RetrievalEvidence = {
      coverage: records(result.coverage) as JsonObject[], unread: records(result.unread) as JsonObject[], identities: records(result.identities) as JsonObject[],
    };
    const messages = [...(append ? this.current.views.inbox.data.filter(row => !row.evidenceOnly) : []), ...messageRows(result.messages)];
    this.update({ type: "querySucceeded", generation, screen: "inbox", data: evidenceRows(messages, evidence), evidence, coverage: coverage(result.coverage), nextCursor: stringValue(result.next_cursor) });
  }

  private async refreshSearch(generation: number, cursor?: string, append = false): Promise<void> {
    const input = this.search;
    if (input === undefined || this.current.searchActive) return;
    const params = { ...input, ...(cursor === undefined ? {} : { cursor }) } as unknown as JsonObject;
    const response = await this.call("search", generation, "message.search", params);
    if (response === undefined || !response.isCurrent()) return;
    const { result } = response;
    this.update({ type: "querySucceeded", generation, screen: "search", data: messageRows(result.messages), coverage: coverage(result.coverage), nextCursor: stringValue(result.next_cursor), append });
  }

  private intervalForChat(chat: ChatRef | undefined): { from_ts: number; to_ts: number } {
    if (this.search !== undefined && chat !== undefined
      && this.search.chat.platform === chat.platform
      && this.search.chat.account === chat.account
      && this.search.chat.chat_id === chat.chat_id) return this.search.interval;
    const period = /^(\d+)(h|d)$/.exec(this.current.period ?? "24h");
    const seconds = period === null ? 86_400 : Number(period[1]) * (period[2] === "d" ? 86_400 : 3_600);
    const to_ts = Math.floor(Date.now() / 1_000);
    return { from_ts: to_ts - seconds, to_ts };
  }

  private intervalForActiveChat(): { from_ts: number; to_ts: number } {
    return this.intervalForChat(this.activeChat);
  }

  private async submitSearch(query: string): Promise<void> {
    if (this.current.accountMode) { await this.searchAccounts(query); return; }
    const chat = this.search?.chat ?? this.activeChat;
    if (chat === undefined) {
      this.replace({ ...this.current, notice: "search unavailable — open a chat first" });
      return;
    }
    const input = { chat, interval: this.search?.interval ?? this.intervalForActiveChat(), query };
    this.setSearch(input);
    await this.refreshSearch(this.generation);
    if (this.search === input && !this.current.searchActive && this.current.views.search.status === "ready") {
      this.replace({ ...this.current, notice: "search submitted — query remains memory-only" });
    }
  }

  private async backfill(resource: ResourceRefV1 | undefined): Promise<void> {
    const capability = resource === undefined
      ? undefined
      : this.current.capabilities.data.find(item => resourceKey(item.resource) === resourceKey(resource));
    if (!capabilityClaimsCurrent(this.current) || resource?.kind !== "chat" || capability === undefined) {
      this.replace({ ...this.current, notice: capabilityClaimsCurrent(this.current)
        ? "backfill disabled — exact resource capability unavailable"
        : capabilityRefreshNotice("backfill", this.current) });
      return;
    }
    if (capability.auth.state !== "authenticated" || capability.read.mode === "none") {
      this.replace({ ...this.current, notice: "backfill disabled — exact resource read capability unavailable" });
      return;
    }
    const chat = { platform: resource.platform, account: resource.account, chat_id: resource.chat_id };
    const interval = this.intervalForChat(chat);
    try {
      await this.options.client.request("sync.backfill", { ...chat, ...interval });
      this.replace({ ...this.current, notice: "backfill requested — no action retried after disconnect" });
    } catch (error) {
      this.replace({ ...this.current, notice: `backfill failed — ${error instanceof Error ? error.message : "check daemon and retry"}` });
    }
  }

  private async sendText(body: string, parentId?: string): Promise<void> {
    const resource = this.activeResource;
    const capability = resource === undefined ? undefined : this.current.capabilities.data.find(item => sameResource(item.resource, resource));
    if (resource?.kind !== "chat" || !capabilityClaimsCurrent(this.current) || capability?.auth.state !== "authenticated"
      || capability.write.mode !== "send" || capability.write.content_mode !== "text"
      || (parentId !== undefined && !capability.write.reply) || this.current.connection.status !== "connected") {
      this.replace({ ...this.current, composeActive: false, draft: "", notice: "전송 불가 — 대화의 전송 권한을 확인하세요." });
      return;
    }
    await this.sendEnvelope({ v: 2, destination: resource, content: { mode: "text", body }, ...(parentId === undefined ? {} : { reply: { parent_id: parentId } }) }, resource, body);
  }

  private async sendTemplate(templateId: string, args: JsonObject, preview: string): Promise<void> {
    const resource = this.activeResource;
    const capability = resource === undefined ? undefined : this.current.capabilities.data.find(item => sameResource(item.resource, resource));
    if (!capabilityClaimsCurrent(this.current) || resource?.kind !== "destination" || capability?.auth.state !== "authenticated"
      || capability.write.mode !== "send" || capability.write.content_mode !== "approved_template" || this.current.connection.status !== "connected") {
      this.replace({ ...this.current, composeActive: false, templateId: "", templateArguments: "", draft: "", notice: "전송 불가 — 템플릿 목적지 권한을 확인하세요." });
      return;
    }
    await this.sendEnvelope({ v: 2, destination: resource, content: { mode: "approved_template", template_id: templateId, arguments: args, preview } }, resource, preview);
  }

  private async refreshChat(generation: number, cursor?: string, append = false, force = false, live = false): Promise<void> {
    const chat = this.activeChat;
    if (chat === undefined) return;
    const previous = this.current.views.chat.data;
    const focusedIndex = this.current.screen === "chat" ? this.current.focus : this.current.selected.chat;
    const selectedId = previous[focusedIndex]?.id;
    const followTail = focusedIndex >= previous.length - 1;
    const response = await this.call("chat", generation, this.current.accountMode ? "account.messages" : "message.inbox", { ...(this.current.accountMode ? { ...chat, ...(force ? { refresh: true } : {}), ...(live && !followTail && selectedId ? { message_id: selectedId } : {}) } : { chat }), ...(cursor === undefined ? {} : { cursor }) });
    if (response === undefined || !response.isCurrent()) return;
    const { result } = response;
    const wasEmpty = this.current.views.chat.data.length === 0;
    let messages = messageRows(result.messages, this.activeResource);
    const priorFocus = this.current.views.chat.data[this.current.focus]?.id;
    if (this.current.accountMode && append) {
      messages = [...new Map([...this.current.views.chat.data, ...messages].map(row => [row.id,row])).values()].sort((a,b) => Number(a.ts)-Number(b.ts));
    }
    this.update({ type: "querySucceeded", generation, screen: "chat", data: messages, coverage: coverage(result.coverage), nextCursor: stringValue(result.next_cursor), append: append && !this.current.accountMode });
    if (this.current.accountMode && append && priorFocus) {
      const focus = Math.max(0,messages.findIndex(row => row.id === priorFocus));
      this.replace({ ...this.current, focus, selected: { ...this.current.selected, chat: focus } });
    }
    if (live && this.current.screen === "chat" && messages.length) {
      const focus = followTail ? messages.length - 1 : Math.max(0, messages.findIndex(row => row.id === selectedId));
      this.replace({ ...this.current, focus, selected: { ...this.current.selected, chat: focus } });
    }
    if (wasEmpty && !append && this.current.screen === "chat" && messages.length) {
      const last = messages.length - 1;
      this.replace({ ...this.current, focus: last, selected: { ...this.current.selected, chat: last } });
    }
  }

  private async refreshApprovals(generation: number, cursor?: string, append = false): Promise<void> {
    const response = await this.call("approvals", generation, "safety.intent.listPending", cursor === undefined ? {} : { cursor });
    if (response === undefined || !response.isCurrent()) return;
    const { result } = response;
    const rows: Row[] = [];
    for (const intent of records(result.intents)) {
      const id = stringValue(intent.intent_id);
      const resource = historicalResource(intent);
      if (id === undefined || resource === undefined) continue;
      const chat = resource.kind === "chat"
        ? { platform: resource.platform, account: resource.account, chat_id: resource.chat_id }
        : undefined;
      rows.push({
        id,
        resource,
        chat,
        state: stringValue(intent.state),
        destination: resourcePath(resource),
        expires: String(intent.expires_at ?? "?"),
        body: historicalBody(intent),
      });
    }
    const combined = new Map((append ? this.current.views.approvals.data : []).map(row => [row.id, row]));
    for (const row of rows) combined.set(row.id, row);
    this.update({ type: "querySucceeded", generation, screen: "approvals", data: [...combined.values()], nextCursor: stringValue(result.next_cursor) });
  }

  private async refreshDoctor(generation: number): Promise<void> {
    const response = await this.call("doctor", generation, "system.status", {});
    if (response === undefined || !response.isCurrent()) return;
    const { result: status } = response;
    const sync: JsonObject = await this.options.client.request("sync.status", {}).catch(() => ({ error: "probe unavailable" }));
    if (!response.isCurrent()) return;
    const auth: JsonObject = await this.options.client.request("auth.status", {}).catch(() => ({ error: "probe unavailable" }));
    if (!response.isCurrent()) return;
    const encryption = record(status.encryption);
    const isolation = record(status.isolation);
    this.update({ type: "querySucceeded", generation, screen: "doctor", data: [
      { id: "encryption", state: encryption === undefined ? stringValue(status.encryption) ?? "unknown" : `SQLCipher ready=${typeof encryption.ready === "boolean" ? encryption.ready : "unknown"}`,
        evidenceLines: encryption === undefined ? [] : [`Cipher: ${stringValue(encryption.cipher_version) ?? "unknown"}`, `Schema: ${numberValue(encryption.schema_version) ?? "unknown"}`] },
      { id: "authentication", state: auth.error !== undefined ? "unknown" : diagnosticSummary(status.auth) ?? (typeof auth.authenticated === "boolean" ? `authenticated=${auth.authenticated}` : "unknown"),
        evidenceLines: auth.error === undefined ? [] : [`auth.status: ${auth.error}`] },
      { id: "sync", state: sync.error !== undefined ? "unknown" : diagnosticSummary(status.sync) ?? stringValue(sync.state) ?? "unknown",
        evidenceLines: sync.error === undefined ? [] : [`sync.status: ${sync.error}`] },
      { id: "isolation", state: isolation === undefined ? "unknown" : `grade=${stringValue(isolation.grade) ?? "unknown"} protected=${typeof isolation.protected === "boolean" ? isolation.protected : "unknown"}`,
        evidenceLines: stringValue(isolation?.warning) === undefined ? [] : [stringValue(isolation?.warning)!] },
    ] });
  }

  private async openFocusedChat(): Promise<void> {
    const row = visibleRows(this.current, this.current.screen)[this.current.focus];
    if (row?.chat === undefined) return;
    const fromSearch = this.current.screen === "search";
    if (fromSearch) this.accountSearchRequest++;
    this.setActiveChat(row.chat);
    this.update({ type: "switchScreen", screen: "chat" });
    this.replace({ ...this.current, roomFocus: Math.max(0, conversationRows(this.current).findIndex(room => sameResource(room.resource, this.activeResource))) });
    if (this.current.accountMode) {
      const response = await this.call("chat", this.generation, "account.messages", { ...row.chat, ...(fromSearch ? { message_id: row.id } : {}) });
      if (response?.isCurrent()) {
        const data = messageRows(response.result.messages, this.activeResource);
        if (fromSearch && !data.some(item => item.id === row.id)) data.push(row);
        this.update({ type: "querySucceeded", generation: this.generation, screen: "chat", data, coverage: { freshness: "partial" }, nextCursor: stringValue(response.result.next_cursor) });
        const focus = fromSearch ? Math.max(0,data.findIndex(item => item.id === row.id)) : Math.max(0,data.length-1);
        this.replace({ ...this.current, focus, selected: { ...this.current.selected, chat: focus }, notice: undefined });
      }
      return;
    }
    this.update({ type: "event", generation: this.generation, method: "message.upserted" });
    await this.refresh();
    const found = this.current.views.chat.data.findIndex(item => item.id === row.id);
    if (found >= 0) this.replace({ ...this.current, focus: found, selected: { ...this.current.selected, chat: found } });
    else if (!row.evidenceOnly && !row.previewOnly) {
      const data = [...this.current.views.chat.data, row];
      this.replace({ ...withView(this.current, "chat", { ...this.current.views.chat, data }), focus: data.length - 1, selected: { ...this.current.selected, chat: data.length - 1 } });
    }
  }


}

export function createTuiController(options: TuiControllerOptions): TuiController {
  return new TuiController(options);
}

export type TuiRole = Extract<ClientRole, "reader" | "sender">;

export * from "./runtime.ts";
export * from "./transport.ts";
