# 03 — Proposal: inboxd

## 핵심 철학

**서버를 믿지 않는다. 쓰기를 믿지 않는다.**

- 읽기의 진실원인 = 로컬 인덱스. 검색·인박스는 인덱스 위에서만.
- 쓰기는 승인 없이는 제안. 기본 deny.
- 어댑터는 교체품. 깨지는 걸 전제로 얇게 만들고, 진단(doctor)이 복구보다 먼저.

## 핵심 기능 5개

1. **sync** — 어댑터(poll/WS/DB-watch) → 정규화 이벤트 → 로컬 저장. `lastLogId/cursor` 백필 포함.
2. **search** — SQLite FTS5 기반 통합 검색. `query + platforms + since` 단일 API. 서버 검색 유무와 무관.
3. **inbox** — 전 플랫폼 unread/mention 요약 한 화면. 인덱스 위에서.
4. **safe-send** — propose→approve 2단계, allowlist, quota, dry-run, outbox 멱등. non-TTY 무인 전송 거부.
5. **doctor/probe** — auth 상태, DB 복호화, AX 셀렉터, endpoint 진단. Day-1 커맨드.

`send`는 기능이 아니라 4번을 통과한 결과물. TUI/MCP/CLI는 인터페이스일 뿐 핵심이 아니다.

## 아키텍처

```text
platform adapters (thin)
  slack / discord / telegram / kakao ...
  → raw event
        ↓
  normalize → UnifiedMessage(id, platform, chat, author, ts, body, reply_to)
        ↓
  store (SQLite: messages FTS5 + chats + sync_state)
        ↓
  ┌─────┴─────┐
  search     inbox
  FTS 쿼리   unread/mention 집계
        ↓
  safe-send (propose→approve→send→receipt)
```

## 설계 원칙

1. **어댑터는 얇게.** 인증+원시 이벤트만. 파싱·검색·정책은 어댑터에 안 둔다.
2. **Gateway 인터페이스 1개.** `list/search/send/watch` 고정. capability는 서버 보고 기준, 가정 금지. Beeper도 구현체 하나로 취급.
3. **저장 3 테이블.** `messages`(FTS) + `chats` + `sync_state(cursor/lastLogId)`. draft/view 캐시는 UI 몫.
4. **쓰기는 전부 outbox 경유.** `intents`(TTL 15분) → `approvals`(code) → `sends`(멱등키+receipt). 직접 send 경로를 코드에 안 남긴다.

## 패키지 분리

`core`(타입+ports) / `index`(sync+search) / `safety` / `platform-*` / `cli`.
테스트는 fake transport로 cred 없이. e2e 자격증명 의존 금지 (Agent Messenger 반면교사).

## 차용元

- `ports` — Nexus `core-domain/ports.rs` 실측 기반
- `Gateway`+capability 게이팅 — beeptui `tui/runtime.ts` 기반
- `safe_send`+`[safety]`+`doctor/probe` — openkakao-cli 기반
