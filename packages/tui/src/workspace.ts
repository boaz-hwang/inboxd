import type { Row, TuiState } from "./index.ts";
import { CURSOR_MARK, fit, wrapCells, truncateCells, displayWidth } from "./text.ts";
import { isArchivedResource, authorLabel, clean, conversationRows, conversationTitle, filteredMessages, platformMarks, platformNames, platformOptions, resourceOf, sameResource, timeLabel } from "./workspace-model.ts";

const labels = { inbox: "전체 메시지", search: "검색", chat: "대화", approvals: "전송 기록", doctor: "연결 관리" };
export function sidebarWidth(width: number): number { return width >= 100 ? 32 : 25; }
export function sidebarStart(state: TuiState, height: number): number {
  const active = state.screen === "chat" && state.pane !== "rooms" && !state.finderActive
    ? conversationRows(state).findIndex(room => sameResource(room.resource, state.activeResource)) : -1;
  const focus = active >= 0 ? active : state.roomFocus ?? 0;
  return Math.max(0, focus - Math.max(1, Math.floor((height - 3) / 3)) + 1);
}
function boxed(title: string, lines: string[], width: number): string[] {
  return [`╭─ ${title} ${"─".repeat(Math.max(0, width - displayWidth(title) - 5))}╮`, ...lines.map(line => `│ ${fit(line, width - 4)} │`), `╰${"─".repeat(width - 2)}╯`];
}
function pendingCount(state: TuiState): number { return state.views.approvals.data.filter(row => row.state === "Uncertain").length; }
function header(state: TuiState, width: number): string[] {
  const pending = pendingCount(state);
  const status = state.connection.status === "connected" ? "" : "  · 연결 끊김 — 다시 연결 중";
  return [fit(` inboxd  /  ${labels[state.screen]}${pending ? `   · 전송 기록 ${pending}` : ""}${status}`, width), fit(state.finderActive ? ` / 대화 찾기  ${state.finderQuery ?? ""}${CURSOR_MARK}   · ↑↓ 선택  Enter 열기  Ctrl+C 취소` : ` ${state.pane === "filters" ? "‹ " : ""}${platformOptions(state).map(p => `${(state.platform ?? "all") === p ? "●" : "○"} ${p === "all" ? "전체" : platformNames[p] ?? p}`).join("   ")}`, width), "─".repeat(width)];
}
function roomList(state: TuiState, width: number, height: number): string[] {
  const rooms = conversationRows(state), start = sidebarStart(state, height);
  const lines = [fit(` 대화 ${rooms.length}개${state.pane === "rooms" ? "  ‹" : ""}`, width), ""];
  if (!rooms.length) lines.push(state.finderQuery ? " 검색 결과 없음" : state.directoryRefreshing || state.accountMode === undefined ? " 대화 불러오는 중…" : " 연결된 대화 없음", state.finderQuery ? " 다른 이름으로 검색" : state.directoryRefreshing || state.accountMode === undefined ? "" : " 5 → C 계정 연결");
  for (let i = start; i < rooms.length && lines.length + 3 <= height; i++) {
    const room = rooms[i]!;
    const selected = sameResource(room.resource, state.activeResource);
    const pointer = i === (state.roomFocus ?? 0) && state.pane === "rooms" ? "›" : selected ? "●" : " ";
    lines.push(fit(`${pointer} [${platformMarks[room.resource.platform] ?? room.resource.platform}] ${isArchivedResource(state, room.resource) ? "[보관] " : ""}${room.title}${room.unread ? ` [${room.unread}${room.unreadStatus === "at_least" ? "+" : ""}]` : room.unreadStatus === "unknown" ? " [·]" : ""}${room.suggestionStatus === "ready" ? " ◇" : ""}`, width));
    lines.push(fit(`   ${timeLabel(room.ts)} ${room.preview.replace(/\n/g, " ")}`, width));
    lines.push("");
  }
  while (lines.length < height - 1) lines.push("");
  lines.push(fit(` ↑↓ 선택  Enter 열기${start ? "  ↑ 더 보기" : ""}`, width));
  return lines.slice(0, height);
}
function messageBlock(state: TuiState, row: Row, width: number, selected: boolean, unified: boolean): string[] {
  const resource = resourceOf(row);
  const context = unified ? `[${platformMarks[resource?.platform ?? ""] ?? "·"}] ${isArchivedResource(state, resource) ? "[보관] " : ""}${conversationTitle(state, resource)} · ` : "";
  const meta = `${selected ? "›" : " "} ${context}${row.previewOnly ? "" : authorLabel(row, state)}  ${timeLabel(row.ts)}${row.edited ? " · 수정됨" : ""}${!unified && row.id === state.response?.sourceIds[0] ? " · 안 읽은 메시지부터" : ""}`;
  const body = wrapCells(clean(row.deleted ? "삭제된 메시지" : row.body ?? "내용 없음"), width - 4);
  const visible = unified ? body.slice(0, 2) : body;
  if (unified && body.length > 2) visible[1] = truncateCells(visible[1]!, width - 6) + " …";
  return [truncateCells(meta, width), ...visible.map(line => `  ${line}`), ""];
}
function timeline(state: TuiState, width: number, height: number, slices?: VisibleMessageSlice[]): string[] {
  const unified = state.screen !== "chat";
  const screen = state.screen === "search" ? "search" : unified ? "inbox" : "chat";
  const rows = unified ? filteredMessages(state, screen as "inbox" | "search") : state.views.chat.data;
  const resource = state.activeResource;
  const title = unified ? state.screen === "search" ? `검색 결과 · ${state.searchQuery || "검색어 입력"} · ${rows.length}건` : state.accountMode ? "전체 메시지 · 대화별 최신" : `전체 메시지 · 최근 ${state.period ?? "24h"}` : conversationTitle(state, resource);
  const lines = [` ${title}`, ""];
  const view = state.views[screen];
  if (view.status === "error") {
    lines.push(...wrapCells(`불러오기 실패: ${clean(view.error ?? "다시 시도하세요")}`, width), " Shift+R 새로고침 · 5 연결 확인");
    if (!rows.length) return lines;
    lines.push(" 저장된 메시지 · 최신 내용은 연결 복구 후 표시됩니다.", "");
  }
  if (view.status === "loading" && !rows.length) return [...lines, " 메시지 불러오는 중…"];
  if (!rows.length) return [...lines, state.screen === "search" ? " 검색 결과가 없습니다." : " 아직 불러온 메시지가 없습니다.", unified ? " 왼쪽에서 대화를 선택하세요." : " Shift+R을 눌러 메시지를 불러오세요."];
  const index = Math.min(state.focus, rows.length - 1);
  const blocks = rows.map((row, i) => messageBlock(state, row, width, state.pane !== "rooms" && i === index, unified));
  if (!unified) {
    let position = 0;
    const total = blocks.reduce((sum, block) => sum + block.length, 0);
    const visible = Math.max(1, height - 2);
    const focusEnd = blocks.slice(0, index + 1).reduce((sum, block) => sum + block.length, 0);
    const top = Math.min(state.chatScrollOffset ?? Math.max(0, focusEnd - visible + state.detailOffset), Math.max(0, total - visible));
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]!;
      const start = Math.max(0, top - position);
      const count = Math.max(0, Math.min(block.length - start, height - lines.length));
      if (count) {
        slices?.push({ id: rows[i]!.id, start, end: start + count, total: block.length });
        lines.push(...block.slice(start, start + count));
      }
      position += block.length;
    }
    if (total > visible) {
      const thumbSize = Math.max(1, Math.floor(visible * visible / total));
      const thumbTop = Math.round(top / (total - visible) * (visible - thumbSize));
      for (let i = 0; i < visible; i++) lines[i + 2] = fit(lines[i + 2] ?? "", width - 1) + (i >= thumbTop && i < thumbTop + thumbSize ? "┃" : "│");
    }
    return lines;
  }
  // Focus is always visible. The active long message can be scrolled independently.
  let first = index;
  let used = Math.min(blocks[index]!.length, height - lines.length);
  while (first > 0 && used + blocks[first - 1]!.length <= height - lines.length) used += blocks[--first]!.length;
  for (let i = first; i < blocks.length && lines.length < height; i++) {
    const start = i === index && state.detailOffset ? Math.min(state.detailOffset, Math.max(0, blocks[i]!.length - (height - lines.length))) : 0;
    const count = Math.min(blocks[i]!.length - start, height - lines.length);
    if (!unified) slices?.push({ id: rows[i]!.id, start, end: start + count, total: blocks[i]!.length });
    lines.push(...blocks[i]!.slice(start, start + count));
  }

  return lines;
}
function delivery(state: TuiState): string | undefined {
  const send = state.lastSend;
  if (send && sameResource(send.resource, state.activeResource)) {
    if (send.state === "Verified") return "✓ Verified · 수신 확인됨";
    if (send.state === "Sent") return "✓ Sent · 전송 접수됨 (수신 확인 전)";
    if (send.state === "Sending") return "전송 중…";
    return `! ${send.state} · s 전송 상태 확인 · 자동 재전송하지 않습니다`;
  }
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
  if (state.accountMode && hint.startsWith("Enter")) hint += " · a/Ctrl+O 파일 첨부";
  if (state.attachmentPicking) return boxed("파일 첨부", ["파일 선택 중… · 최대 100 MiB"], width);
  if (state.attachment) return boxed("파일 첨부", [`${clean(state.attachment.name)} · ${(state.attachment.size / 1024).toFixed(1)} KiB`, "Enter 보내기 · Ctrl+C 취소"], width);
  const title = (state.composeMode === "reply" ? "인용 답장" : state.composeMode === "approved_template" ? "템플릿 메시지" : "메시지") + (state.response?.readSyncFailed ? " · 읽음 동기화 실패" : "");
  if (state.sendPending) return boxed(title, ["전송 중…"], width);
  if (state.responseFocus && state.response?.sendState && ["Failed", "Uncertain"].includes(state.response.sendState)) return boxed(title, ["전송 결과 확인 필요 · s 상태 확인 · Ctrl+C 새 작성"], width);
  if (!state.composeActive) return boxed(title, [hint + (state.responseFocus ? " · Tab 다음 안 읽은 방" : "")], width);
  if (state.composeMode === "approved_template") return boxed(title, [`Template ID: ${state.templateId}`, `Arguments JSON: ${state.templateArguments}`, `Preview: ${state.draft}${state.pane === "messages" ? "_" : ""}`, "Enter 다음 / 바로 전송 · Ctrl+C 취소"], width);
  if (ghostVisible(state)) return boxed(`${title} · 추천`, [...wrapCells(clean(state.response!.suggestion!.text), width - 4).slice(0, 3), "Tab 추천 수락 · 직접 입력 · PgUp/PgDn 확인 · Ctrl+C 나가기"], width);
  const responseHint = state.responseFocus ? state.draft
    ? "Tab 내용 유지 · Enter 보내기"
    : state.response?.status === "generating" || state.response?.status === "queued"
      ? "추천 생성 중 · 직접 입력 가능"
      : state.response?.status === "failed"
        ? "추천 생성 실패 · 직접 입력 가능"
        : state.response?.status === "abstained"
          ? state.response.error === "no_reply_target"
            ? "답장 대상 없음 · 직접 입력 가능"
            : "추천 없음 · Tab 다음 안 읽은 방 · 직접 입력"
          : "Tab 다음 안 읽은 방 · 직접 입력"
    : "Enter 보내기";
  const cursor = state.draftCursor ?? state.draft.length;
  const value = state.pane === "messages"
    ? clean(state.draft.slice(0, cursor)) + CURSOR_MARK + (clean(state.draft.slice(cursor)) || " ")
    : clean(state.draft);
  const wrapped = wrapCells(value, width - 4);
  const caretLine = Math.max(0, wrapped.findIndex(line => line.includes(CURSOR_MARK)));
  const start = Math.max(0, caretLine - 2);
  return boxed(title, [...wrapped.slice(start, start + 3), `${responseHint} · Shift+Enter 줄바꿈 · Ctrl+C 취소`], width);
}
function history(state: TuiState, width: number, height: number): string[] {
  const rows = state.views.approvals.data;
  const row = rows[state.selected.approvals];
  if (!row) return ["", " 과거 전송 기록이 없습니다.", " 3 대화로 돌아가기"];
  const resource = resourceOf(row);
  const lines = ["", ` ${platformNames[resource?.platform ?? ""] ?? ""} · ${conversationTitle(state, resource)}`, ` ${row.state ?? "확인 필요"}  · ${state.selected.approvals + 1} / ${rows.length}`, ""];
  const message = wrapCells(clean(row.body ?? "내용 없음"), width - 4);
  const available = Math.max(1, height - 12);
  const start = Math.min(state.detailOffset, Math.max(0, message.length - available));
  lines.push(...message.slice(start, start + available).map(line => `  ${line}`), "");
  if (start + available < message.length) lines.push(" PgDn 내용 더 보기");
  if (row.state === "Uncertain") lines.push(" ! 전송 결과 확인 필요 — 다시 보내지 마세요");
  else if (row.state === "Verified") lines.push(" ✓ 수신 확인됨");
  else if (row.state === "Sent") lines.push(" ✓ 전송 접수됨 · 수신 확인 전");
  if (rows.some(item => item.state === "Uncertain") && row.state !== "Uncertain") lines.push(" ! 결과 확인이 필요한 다른 전송이 있습니다. · ↑↓ 선택");
  if (state.connection.status !== "connected") lines.push(" 연결 끊김 · 전송할 수 없습니다.");
  if (row.state === "Proposed") lines.push(" 과거 승인 요청 · 조회 전용 · 새 메시지는 대화에서 작성하세요.");
  return lines;
}
function doctor(state: TuiState): string[] {
  return ["", " 연결된 메신저", "", ...platformOptions(state).filter(p => p !== "all").map(p => {
    const caps = state.capabilities.data.filter(c => c.resource.platform === p);
    return ` ${caps.length && caps.every(c => c.auth.state === "authenticated") ? "✓" : "!"} ${platformNames[p] ?? p}   ${caps.length && caps.every(c => c.auth.state === "authenticated") ? "연결됨" : "연결 확인 필요"}`;
  }), "", " C 계정 추가 / 다시 연결", ...state.views.doctor.status === "error" ? [" 상태를 불러오지 못했습니다."] : []];
}
export function usefulNotice(state: TuiState): string | undefined {
  if (!state.notice || /re-query|required$|selection activated|detail closed|memory|compose text|reply to|subscrib|fetching more/.test(state.notice)) return undefined;
  return clean(state.notice);
}
export function workspaceBodyHeight(state: TuiState, height: number): number {
  return height - 5 - (state.helpOpen ? 2 : 0) - (usefulNotice(state) ? 1 : 0);
}
/** Geometry shared by the text renderer and its selection color. */
export function selectionFrame(state: TuiState, width: number, height: number): { left: number; height: number; roomTop?: number } | undefined {
  if (state.screen !== "chat" || !state.activeResource || state.detailOpen || width < 80 || height < 24) return undefined;
  const bodyHeight = workspaceBodyHeight(state, height);
  const rooms = conversationRows(state);
  const index = rooms.findIndex(room => sameResource(room.resource, state.activeResource));
  const start = sidebarStart(state, bodyHeight);
  const top = 1 + (index - start) * 3;
  return { left: sidebarWidth(width), height: bodyHeight, ...(index >= start && top + 4 <= bodyHeight ? { roomTop: top } : {}) };
}
export function renderWorkspace(state: TuiState, size: { width: number; height: number }): string {
  const { width, height } = size;
  if (width < 80 || height < 24) return Array.from({ length: Math.max(1, height) }, (_, i) => fit(i === 0 ? "창을 80×24 이상으로 넓혀 주세요." : "", Math.max(1, width))).join("\n");
  const split = state.screen === "inbox" || state.screen === "chat";
  const frame = selectionFrame(state, width, height);
  const leftWidth = split ? sidebarWidth(width) : 0;
  const contentWidth = split ? width - leftWidth - 1 - (frame ? 1 : 0) : width;
  const input = composer(state, contentWidth);
  const notice = usefulNotice(state);
  const footer = state.composeActive && state.pane === "messages" ? " 작성 중  ·  Shift+Tab 이전 영역  ·  ⌥←→ 단어 이동  Ctrl+A/E 줄 처음·끝" : " / 검색  Ctrl+K 대화찾기  Shift+Tab 영역 이동  ←→ 필터 선택  ? 도움말";
  const exitHint = state.pane === "filters" || state.pane === "rooms" ? "Ctrl+C 종료" : "Ctrl+C 취소 · 두 번 종료";
  const help = state.helpOpen ? [" 1 전체 · 3 대화 · 4 전송 기록 · 5 연결 · ↑↓ 선택 · Enter 열기/답장", ` c 작성 · r 인용 · s 전송 상태 · Shift+R 불러오기 · ${exitHint}`] : [];
  const coverage = state.views[state.screen].coverage ?? state.coverage;
  const status = (state.screen === "chat" ? delivery(state) : undefined) ?? (coverage.freshness !== "fresh" && ["chat", "inbox", "search"].includes(state.screen) ? " 일부 기록만 표시 중 · Shift+R 불러오기" : "");
  const bodyHeight = workspaceBodyHeight(state, height);
  const rightHeight = bodyHeight - (frame ? 2 : 0);
  let right = state.screen === "doctor" ? doctor(state) : state.screen === "approvals" ? history(state, contentWidth, rightHeight) : timeline(state, contentWidth, rightHeight - input.length);
  right = right.slice(0, rightHeight - input.length);
  while (right.length < rightHeight - input.length) right.push("");
  right.push(...input);
  if (state.searchActive) right.splice(Math.max(0, right.length - 3), 3, ...boxed(state.accountMode ? "전체 메시지 검색 · Enter 검색 · Ctrl+C 취소" : "대화 내 검색", [`${state.searchQuery}${CURSOR_MARK}`], contentWidth));
  const left = split ? roomList(state, leftWidth, bodyHeight) : [];
  const body = Array.from({ length: bodyHeight }, (_, i) => {
    if (!split) return fit(right[i] ?? "", width);
    if (!frame) return `${fit(left[i] ?? "", leftWidth)}│${fit(right[i] ?? "", contentWidth)}`;
    let sidebar = fit(left[i] ?? "", leftWidth);
    let seam = i === 0 ? "╭" : i === bodyHeight - 1 ? "╰" : "│";
    if (frame.roomTop !== undefined) {
      if (i === frame.roomTop) { sidebar = `╭${"─".repeat(leftWidth - 1)}`; seam = "╯"; }
      else if (i === frame.roomTop + 3) { sidebar = `╰${"─".repeat(leftWidth - 1)}`; seam = i === bodyHeight - 1 ? "─" : "╮"; }
      else if (i > frame.roomTop && i < frame.roomTop + 3) { sidebar = `│${fit((left[i] ?? "").trimEnd(), leftWidth - 1)}`; seam = " "; }
    }
    const panel = i === 0 ? `${"─".repeat(contentWidth)}╮` : i === bodyHeight - 1 ? `${"─".repeat(contentWidth)}╯` : `${fit(right[i - 1] ?? "", contentWidth)}│`;
    return sidebar + seam + panel;
  });
  const lines = [...header(state, width), ...body, fit(status, width), ...(notice ? [fit(` ${notice}`, width)] : []), ...help.map(line => fit(line, width)), fit(footer, width)];
  return lines.slice(0, height).map(line => fit(line, width)).join("\n");
}

export interface VisibleMessageSlice { id: string; start: number; end: number; total: number; }
export function ghostVisible(state: TuiState): boolean {
  const capability = state.capabilities.data.find(c => sameResource(c.resource, state.activeResource));
  return !!(capability?.auth.state === "authenticated" && capability.write.mode === "send" && !state.requeryCapabilities && state.connection.status === "connected" && state.responseFocus && state.composeActive && !state.draft && !state.response?.hidden && state.response?.status === "ready" && state.response.suggestion && !state.sendPending && !state.detailOpen);
}
/** Uses exactly the timeline geometry used by renderWorkspace. */
export function renderedObservation(state: TuiState, size: { width: number; height: number }): { slices: VisibleMessageSlice[]; suggestionVisible: boolean } {
  const slices: VisibleMessageSlice[] = [];
  if (size.width < 80 || size.height < 24 || state.screen !== "chat" || state.detailOpen || state.searchActive) return { slices, suggestionVisible: false };
  const frame = selectionFrame(state, size.width, size.height);
  const width = size.width - sidebarWidth(size.width) - 1 - (frame ? 1 : 0);
  const height = workspaceBodyHeight(state, size.height) - (frame ? 2 : 0) - composer(state, width).length;
  timeline(state, width, height, slices);
  return { slices, suggestionVisible: ghostVisible(state) };
}

/** Shared geometry for line scrolling and loading history without moving the viewport. */
export function chatScrollMetrics(state: TuiState, size: { width: number; height: number }) {
  const frame = selectionFrame(state, size.width, size.height);
  const width = size.width - (size.width >= 80 ? sidebarWidth(size.width) + 1 : 0) - (frame ? 1 : 0);
  const visible = Math.max(1, workspaceBodyHeight(state, size.height) - (frame ? 2 : 0) - composer(state, width).length - 2);
  const blocks = state.views.chat.data.map(row => messageBlock(state, row, width, false, false).length);
  const total = blocks.reduce((a, b) => a + b, 0);
  const focusEnd = blocks.slice(0, state.focus + 1).reduce((a, b) => a + b, 0);
  const top = state.chatScrollOffset ?? Math.max(0, focusEnd - visible + state.detailOffset);
  return { total, visible, top: Math.min(top, Math.max(0, total - visible)), blocks };
}
