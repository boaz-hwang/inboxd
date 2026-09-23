import type { Row, TuiState } from "./index.ts";
import type { ResourceRefV1 } from "../../protocol/src/schema.ts";

export const platformNames: Record<string, string> = { slack: "Slack", telegram: "Telegram", kakao: "KakaoTalk" };
export const platformMarks: Record<string, string> = { slack: "SL", telegram: "TG", kakao: "KK" };
export function resourceOf(row: Row): ResourceRefV1 | undefined {
  return row.resource ?? (row.chat ? { v: 1, kind: "chat", ...row.chat } : undefined);
}
export function sameResource(a: ResourceRefV1 | undefined, b: ResourceRefV1 | undefined): boolean {
  return !!a && !!b && a.platform === b.platform && a.account === b.account && a.kind === b.kind
    && (a.kind === "chat" && b.kind === "chat" ? a.chat_id === b.chat_id : a.kind === "destination" && b.kind === "destination" && a.destination_id === b.destination_id);
}
export function isRegisteredResource(state: TuiState, resource: ResourceRefV1 | undefined): boolean {
  return state.capabilities.data.some(item => sameResource(item.resource, resource));
}
export function isArchivedResource(state: TuiState, resource: ResourceRefV1 | undefined): boolean {
  return !!resource && !state.requeryCapabilities && (state.capabilities.status === "ready" || state.capabilities.status === "empty") && !isRegisteredResource(state, resource);
}
export function clean(value: string): string {
  return value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2060\u2066-\u2069]/g, "").replace(/\t/g, "    ");
}
export function platformOptions(state: TuiState): string[] {
  return ["all", ...new Set([...state.capabilities.data.map(c => c.resource.platform), ...(state.directory ?? []).flatMap(row => resourceOf(row)?.platform ?? []), ...state.views.inbox.data.flatMap(row => resourceOf(row)?.platform ?? [])])].sort((a, b) => a === "all" ? -1 : b === "all" ? 1 : a.localeCompare(b));
}
export function filteredMessages(state: TuiState, screen: "inbox" | "search"): Row[] {
  return state.views[screen].data.filter(row => !row.evidenceOnly && (!state.platform || resourceOf(row)?.platform === state.platform));
}
export interface Conversation { resource: ResourceRefV1; title: string; preview: string; ts?: string; unread?: number; unreadStatus?: string; suggestionStatus?: string; }
export function conversationRows(state: TuiState, applyFilter = true): Conversation[] {
  const resources: ResourceRefV1[] = [];
  for (const resource of [...(state.directory ?? []).map(resourceOf), ...state.capabilities.data.map(c => c.resource), ...state.views.inbox.data.map(resourceOf)]) {
    if (resource && !resources.some(item => sameResource(item, resource))) resources.push(resource);
  }
  // Break equal-time ties in favor of current accounts. Do not merge by chat ID:
  // the account is part of the send authority. Activity remains the primary sort.
  resources.sort((a, b) => Number(isRegisteredResource(state, b)) - Number(isRegisteredResource(state, a)));
  const rooms = resources.map((resource, index) => {
    const directory = state.directory?.find(row => sameResource(resourceOf(row), resource));
    const messages = state.views.inbox.data.filter(row => sameResource(resourceOf(row), resource));
    const latest = [...messages].filter(row => !row.evidenceOnly).sort((a, b) => timestamp(b.ts) - timestamp(a.ts))[0];
    const rawId = resource.kind === "chat" ? resource.chat_id : resource.destination_id;
    const title = directory?.title || latest?.title || (/^[\p{L}][\p{L}\p{N} _-]{0,28}$/u.test(rawId) && !/^[CDUG][A-Z0-9]{7,}$/.test(rawId) ? rawId : `대화 ${index + 1}`);
    const evidence = directory?.unreadEvidence;
    const unread = /^Unread: (\d+) /.exec(messages[0]?.unread ?? "");
    return { resource, title: clean(title), preview: clean(directory && timestamp(directory.ts) >= timestamp(latest?.ts) ? directory.body ?? "불러온 메시지 없음" : latest?.deleted ? "삭제된 메시지" : latest?.body ?? directory?.body ?? "불러온 메시지 없음"), ts: directory && timestamp(directory.ts) >= timestamp(latest?.ts) ? directory.ts : latest?.ts ?? directory?.ts, unread: evidence?.count ?? (unread ? Number(unread[1]) : undefined), unreadStatus: evidence?.status, suggestionStatus: directory?.suggestionStatus };
  });
  rooms.sort((a,b) => timestamp(b.ts)-timestamp(a.ts) || (state.accountMode ? resourceSortKey(a.resource).localeCompare(resourceSortKey(b.resource)) : 0));
  if (!applyFilter) return rooms;
  const query = (state.finderQuery ?? "").normalize("NFC").toLocaleLowerCase().trim();
  return rooms.filter(room => (!state.platform || room.resource.platform === state.platform) && (!query || `${room.title} ${platformNames[room.resource.platform] ?? room.resource.platform}`.normalize("NFC").toLocaleLowerCase().includes(query)));
}
export function conversationTitle(state: TuiState, resource: ResourceRefV1 | undefined): string {
  return conversationRows(state, false).find(room => sameResource(room.resource, resource))?.title ?? "대화";
}
export function timestamp(ts: string | undefined): number {
  if (!ts) return 0;
  const n = Number(ts);
  return Number.isFinite(n) ? n * (n < 1e12 ? 1000 : 1) : Date.parse(ts) || 0;
}
export function timeLabel(ts: string | undefined): string {
  if (ts && /^\d{2}:\d{2}$/.test(ts)) return ts;
  const value = timestamp(ts);
  if (!value) return "";
  const d = new Date(value);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
export function authorLabel(row: Row, state?: TuiState): string {
  if (row.authorName) return clean(row.authorName);
  const resource = resourceOf(row);
  const identity = state?.views.inbox.evidence?.identities.find(item => item.platform === resource?.platform && item.account === resource?.account);
  const self = identity?.status === "known" && typeof identity.self_id === "string" ? identity.self_id : undefined;
  if (self && row.author && (row.author === self || row.author.endsWith(`:user:${self}`))) return "나";
  // Opaque provider identifiers belong in the inspector, not in every message.
  return clean(row.author && !/^(?:\d+|[UW][A-Z0-9]{7,}|(?:telegram|slack|kakao):.*)$/.test(row.author) ? row.author : "보낸 사람");
}

function resourceSortKey(resource: ResourceRefV1): string { return JSON.stringify([resource.platform, resource.account, resource.kind, resource.kind === "chat" ? resource.chat_id : resource.destination_id]); }
