import type { Row, TuiState } from "./index.ts";
import { fit, wrapCells, truncateCells, displayWidth } from "./text.ts";
import { isArchivedResource, authorLabel, clean, conversationRows, conversationTitle, filteredMessages, platformMarks, platformNames, platformOptions, resourceOf, sameResource, timeLabel } from "./workspace-model.ts";

const labels = { inbox: "전체 메시지", search: "검색", chat: "대화", approvals: "전송 확인", doctor: "연결 관리" };
export function sidebarWidth(width: number): number { return width >= 100 ? 32 : 25; }
export function sidebarStart(state: TuiState, height: number): number {
  return Math.max(0, (state.roomFocus ?? 0) - Math.max(1, Math.floor((height - 3) / 3)) + 1);
}
function boxed(title: string, lines: string[], width: number): string[] {
  return [`╭─ ${title} ${"─".repeat(Math.max(0, width - displayWidth(title) - 5))}╮`, ...lines.map(line => `│ ${fit(line, width - 4)} │`), `╰${"─".repeat(width - 2)}╯`];
}
function pendingCount(state: TuiState): number { return state.views.approvals.data.filter(row => row.codeRequired).length; }
function header(state: TuiState, width: number): string[] {
  const pending = pendingCount(state);
  const status = state.connection.status === "connected" ? "" : "  · 연결 끊김 — 다시 연결 중";
  return [fit(` inboxd  /  ${labels[state.screen]}${pending ? `   · 전송 확인 ${pending}` : ""}${status}`, width), fit(state.finderActive ? ` / 대화 찾기  ${state.finderQuery ?? ""}▏   · ↑↓ 선택  Enter 열기  Esc 취소` : ` ${state.pane === "filters" ? "‹ " : ""}${platformOptions(state).map(p => `${(state.platform ?? "all") === p ? "●" : "○"} ${p === "all" ? "전체" : platformNames[p] ?? p}`).join("   ")}`, width), "─".repeat(width)];
}
function roomList(state: TuiState, width: number, height: number): string[] {
  const rooms = conversationRows(state), start = sidebarStart(state, height);
  const lines = [fit(` 대화 ${rooms.length}개${state.pane === "rooms" ? "  ‹" : ""}`, width), ""];
  if (!rooms.length) lines.push(state.finderQuery ? " 검색 결과 없음" : state.directoryRefreshing || state.accountMode === undefined ? " 대화 불러오는 중…" : " 연결된 대화 없음", state.finderQuery ? " 다른 이름으로 검색" : state.directoryRefreshing || state.accountMode === undefined ? "" : " 5 → C 계정 연결");
  for (let i = start; i < rooms.length && lines.length + 3 <= height; i++) {
    const room = rooms[i]!;
    const selected = sameResource(room.resource, state.activeResource);
    const pointer = i === (state.roomFocus ?? 0) && state.pane === "rooms" ? "›" : selected ? "●" : " ";
    lines.push(fit(`${pointer} [${platformMarks[room.resource.platform] ?? room.resource.platform}] ${isArchivedResource(state, room.resource) ? "[보관] " : ""}${room.title}${room.unread ? `  ${room.unread}` : ""}`, width));
    lines.push(fit(`   ${room.preview.replace(/\n/g, " ")}`, width));
    lines.push("");
  }
  while (lines.length < height - 1) lines.push("");
  lines.push(fit(` ↑↓ 선택  Enter 열기${start ? "  ↑ 더 보기" : ""}`, width));
  return lines.slice(0, height);
}
function messageBlock(state: TuiState, row: Row, width: number, selected: boolean, unified: boolean): string[] {
  const resource = resourceOf(row);
  const context = unified ? `[${platformMarks[resource?.platform ?? ""] ?? "·"}] ${isArchivedResource(state, resource) ? "[보관] " : ""}${conversationTitle(state, resource)} · ` : "";
  const meta = `${selected ? "›" : " "} ${context}${row.previewOnly ? "" : authorLabel(row, state)}  ${timeLabel(row.ts)}${row.edited ? " · 수정됨" : ""}`;
  const body = wrapCells(clean(row.deleted ? "삭제된 메시지" : row.body ?? "내용 없음"), width - 4);
  const visible = unified ? body.slice(0, 2) : body;
  if (unified && body.length > 2) visible[1] = truncateCells(visible[1]!, width - 6) + " …";
  return [truncateCells(meta, width), ...visible.map(line => `  ${line}`), ""];
}
function timeline(state: TuiState, width: number, height: number): string[] {
  const unified = state.screen !== "chat";
  const screen = state.screen === "search" ? "search" : unified ? "inbox" : "chat";
  const rows = unified ? filteredMessages(state, screen as "inbox" | "search") : state.views.chat.data;
  const resource = state.activeResource;
  const title = unified ? state.screen === "search" ? `검색 결과 · ${state.searchQuery || "검색어 입력"} · ${rows.length}건` : state.accountMode ? "전체 메시지 · 대화별 최신" : `전체 메시지 · 최근 ${state.period ?? "24h"}` : `[${platformMarks[resource?.platform ?? ""] ?? "·"}] ${conversationTitle(state, resource)}`;
  const lines = [` ${title}`, ""];
  const view = state.views[screen];
  if (view.status === "error") return [...lines, ...wrapCells(`불러오기 실패: ${clean(view.error ?? "다시 시도하세요")}`, width), " b 새로고침 · 5 연결 확인"];
  if (view.status === "loading" && !rows.length) return [...lines, " 메시지 불러오는 중…"];
  if (!rows.length) return [...lines, state.screen === "search" ? " 검색 결과가 없습니다." : " 아직 불러온 메시지가 없습니다.", unified ? " 왼쪽에서 대화를 선택하세요." : " b를 눌러 메시지를 불러오세요."];
  const index = Math.min(state.focus, rows.length - 1);
  const blocks = rows.map((row, i) => messageBlock(state, row, width, state.pane !== "rooms" && i === index, unified));
  // Focus is always visible. The active long message can be scrolled independently.
  let first = index;
  let used = Math.min(blocks[index]!.length, height - 2);
  while (first > 0 && used + blocks[first - 1]!.length <= height - 2) used += blocks[--first]!.length;
  for (let i = first; i < blocks.length && lines.length < height; i++) {
    const block = i === index && state.detailOffset ? blocks[i]!.slice(Math.min(state.detailOffset, Math.max(0, blocks[i]!.length - (height - lines.length)))) : blocks[i]!;
    lines.push(...block.slice(0, height - lines.length));
  }
  if (view.nextCursor) lines[Math.min(lines.length, height - 1)] = " n 다음 페이지";
  return lines;
}
function delivery(state: TuiState): string | undefined {
  const rows = state.views.approvals.data.filter(row => sameResource(resourceOf(row), state.activeResource));
  const row = rows.at(-1);
  if (row?.state === "Verified") return "✓ Verified · 수신 확인됨";
  if (row?.state === "Sent") return "✓ Sent · 전송 접수됨 (수신 확인 전)";
  if (row?.state === "Uncertain") return "! Uncertain · 전송 결과 확인 필요 — 다시 보내지 마세요";
  if (row?.state === "Sending") return "전송 중…";
  return undefined;
}
function composer(state: TuiState, width: number): string[] {
  if (state.screen !== "chat" || !state.activeResource) return [];
  const capability = state.capabilities.data.find(c => sameResource(c.resource, state.activeResource));
  let hint = "Enter 답장 작성 · r 인용 답장";
  if (state.connection.status !== "connected") hint = "연결이 복구되면 답장할 수 있습니다.";
  else if (state.requeryCapabilities || state.capabilities.status === "loading" || state.capabilities.status === "idle") hint = "연결 상태 확인 중…";
  else if (isArchivedResource(state, state.activeResource)) hint = "보관 기록 · 읽기 전용 · / 현재 대화 찾기";
  else if (state.capabilities.status === "error" || state.capabilities.status === "stale" || capability?.auth.state === "unknown") hint = "연결 상태 확인 필요 · 5 연결 관리";
  else if (capability?.auth.state !== "authenticated") hint = "계정 연결 확인 필요 · 5 연결 관리";
  else if (capability.write.mode !== "send") hint = "읽기 전용 대화";
  else if (!capability.write.reply) hint = "Enter 답장 작성";
  const title = state.composeMode === "reply" ? "인용 답장" : state.composeMode === "approved_template" ? "템플릿 메시지" : "메시지";
  if (state.sendPending) return boxed(title, ["전송 중…"], width);
  if (!state.composeActive) return boxed(title, [hint], width);
  if (state.composeMode === "approved_template") return boxed(title, [`Template ID: ${state.templateId}`, `Arguments JSON: ${state.templateArguments}`, `Preview: ${state.draft}_`, "Enter 다음 / 전송 확인 · Esc 취소"], width);
  const cursor = state.draftCursor ?? state.draft.length;
  const value = clean(state.draft.slice(0, cursor)) + "▏" + clean(state.draft.slice(cursor));
  const wrapped = wrapCells(value, width - 4);
  const caretLine = Math.max(0, wrapped.findIndex(line => line.includes("▏")));
  const start = Math.max(0, caretLine - 2);
  return boxed(title, [...wrapped.slice(start, start + 3), "Enter 보내기 · Shift+Enter 줄바꿈 · Esc 취소"], width);
}
function approvals(state: TuiState, width: number, height: number, code?: string): string[] {
  const rows = state.views.approvals.data;
  const row = rows[state.selected.approvals];
  if (!row) return ["", " 전송을 기다리는 메시지가 없습니다.", ...(state.views.approvals.nextCursor ? [" n 다음 페이지"] : []), " 3 대화로 돌아가기"];
  const resource = resourceOf(row);
  const lines = ["", ` ${platformNames[resource?.platform ?? ""] ?? ""} · ${conversationTitle(state, resource)}`, ` ${row.state ?? "확인 필요"}  · ${state.selected.approvals + 1} / ${rows.length}`, ""];
  const message = wrapCells(clean(row.body ?? "내용 없음"), width - 4);
  const available = Math.max(1, height - 12);
  const start = Math.min(state.detailOffset, Math.max(0, message.length - available));
  lines.push(...message.slice(start, start + available).map(line => `  ${line}`), "");
  if (start + available < message.length) lines.push(" PgDn 내용 더 보기 · d 상세");
  if (row.state === "Uncertain") lines.push(" ! 전송 결과 확인 필요 — 다시 보내지 마세요");
  else if (row.state === "Verified") lines.push(" ✓ 수신 확인됨");
  else if (row.state === "Sent") lines.push(" ✓ 전송 접수됨 · 수신 확인 전");
  if (rows.some(item => item.state === "Uncertain") && row.state !== "Uncertain") lines.push(" ! 결과 확인이 필요한 다른 전송이 있습니다. · ↑↓ 선택");
  if (state.connection.status !== "connected") lines.push(" 연결 끊김 · 전송할 수 없습니다.");
  if (row.codeRequired && code && state.connection.status === "connected") lines.push(` 확인 코드: ${code}`, " a 코드 입력 후 전송 · Esc 닫기");
  else if (["Proposed", "Code unavailable"].includes(row.state ?? "")) lines.push(" 확인 코드를 사용할 수 없습니다. 다시 작성하세요.");
  if (state.approvalPrompt) lines.push(...boxed("전송 확인 코드", ["•".repeat(state.codeBuffer.length) + "▏", "Enter 전송 · Esc 취소"], width));
  return lines;
}
function doctor(state: TuiState): string[] {
  return ["", " 연결된 메신저", "", ...platformOptions(state).filter(p => p !== "all").map(p => {
    const caps = state.capabilities.data.filter(c => c.resource.platform === p);
    return ` ${caps.length && caps.every(c => c.auth.state === "authenticated") ? "✓" : "!"} ${platformNames[p] ?? p}   ${caps.length && caps.every(c => c.auth.state === "authenticated") ? "연결됨" : "연결 확인 필요"}`;
  }), "", " C 계정 추가 / 다시 연결", "", " d 암호화·동기화·권한 상세", ...state.views.doctor.status === "error" ? [" 상태를 불러오지 못했습니다."] : []];
}
export function usefulNotice(state: TuiState): string | undefined {
  if (!state.notice || /re-query|required$|selection activated|detail closed|memory|compose text|reply to|subscrib|fetching more/.test(state.notice)) return undefined;
  return clean(state.notice);
}
export function workspaceBodyHeight(state: TuiState, height: number): number {
  return height - 5 - (state.helpOpen ? 2 : 0) - (usefulNotice(state) ? 1 : 0);
}
export function renderWorkspace(state: TuiState, size: { width: number; height: number }, ephemeral: { approvalCode?: string } = {}): string {
  const { width, height } = size;
  if (width < 80 || height < 24) return Array.from({ length: Math.max(1, height) }, (_, i) => fit(i === 0 ? "창을 80×24 이상으로 넓혀 주세요." : "", Math.max(1, width))).join("\n");
  const split = (state.screen === "inbox" || state.screen === "chat") && !(width < 100 && state.screen === "chat" && state.pane !== "rooms" && !state.finderActive);
  const leftWidth = split ? sidebarWidth(width) : 0;
  const contentWidth = split ? width - leftWidth - 1 : width;
  const input = composer(state, contentWidth);
  const notice = usefulNotice(state);
  const footer = state.composeActive ? " 작성 중  ·  ←→ 커서 이동  Home/End 처음·끝" : " / 검색  Ctrl+K 대화찾기  Tab 영역 이동  ←→ 필터 선택  ? 도움말";
  const help = state.helpOpen ? [" 1 전체 · 3 대화 · 4 전송 확인 · 5 연결 · ↑↓ 선택 · Enter 열기/답장", " c 작성 · r 인용 · b 불러오기 · n 다음 · d 상세 · Esc 뒤로 · q 종료"] : [];
  const coverage = state.views[state.screen].coverage ?? state.coverage;
  const status = (state.screen === "chat" ? delivery(state) : undefined) ?? (coverage.freshness !== "fresh" && ["chat", "inbox", "search"].includes(state.screen) ? " 일부 기록만 표시 중 · b 불러오기 · d 상세" : "");
  const bodyHeight = workspaceBodyHeight(state, height);
  let right = state.screen === "doctor" ? doctor(state) : state.screen === "approvals" ? approvals(state, contentWidth, bodyHeight, ephemeral.approvalCode) : timeline(state, contentWidth, bodyHeight - input.length);
  right = right.slice(0, bodyHeight - input.length);
  while (right.length < bodyHeight - input.length) right.push("");
  right.push(...input);
  if (state.searchActive) right.splice(Math.max(0, right.length - 3), 3, ...boxed(state.accountMode ? "전체 메시지 검색 · Enter 검색 · Esc 취소" : "대화 내 검색", [`${state.searchQuery}▏`], contentWidth));
  const left = split ? roomList(state, leftWidth, bodyHeight) : [];
  const body = Array.from({ length: bodyHeight }, (_, i) => split ? `${fit(left[i] ?? "", leftWidth)}│${fit(right[i] ?? "", contentWidth)}` : fit(right[i] ?? "", width));
  const lines = [...header(state, width), ...body, fit(status, width), ...(notice ? [fit(` ${notice}`, width)] : []), ...help.map(line => fit(line, width)), fit(footer, width)];
  return lines.slice(0, height).map(line => fit(line, width)).join("\n");
}
