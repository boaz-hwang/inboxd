# 03 — Proposal: inboxd

## 핵심 철학

**서버를 믿지 않는다. 쓰기를 믿지 않는다. "결과 없음"과 "모름"을 구분한다.**

- 읽기의 진실원인 = 로컬 인덱스. 검색·인박스는 인덱스 위에서만.
- 쓰기는 승인 없이는 제안. 기본 deny. 승인은 아웃오브밴드 채널로.
- 어댑터는 교체품. 깨지는 걸 전제로 얇게 만들고, 진단(doctor)이 복구보다 먼저.
- 부분 인덱스에서 "결과 없음"은 거짓 응답이다. 모든 검색 응답에 coverage를 동봉한다.

## 핵심 기능 5개

1. **sync** — 어댑터(poll/WS/DB-watch) → 정규화 이벤트 → 로컬 저장. `lastLogId/cursor` 백필 포함.
2. **search** — SQLite FTS5 기반 통합 검색. `query + platforms + since` 단일 API. 서버 검색 유무와 무관.
3. **inbox** — 전 플랫폼 unread/mention 요약 한 화면. 인덱스 위에서.
4. **safe-send** — propose→approve 2단계, allowlist, quota, dry-run, outbox 멱등. non-TTY 무인 전송 거부하되 승인 자체는 아웃오브밴드로.
5. **doctor/probe** — auth 상태, DB 복호화, AX 셀렉터, endpoint 진단. Day-1 커맨드.

`send`는 기능이 아니라 4번을 통과한 결과물. TUI/MCP/CLI는 인터페이스일 뿐 핵심이 아니다.

## 아키텍처

```text
platform adapters (thin)
  slack / discord / telegram / kakao ...
  → raw event
        ↓
  normalize → UnifiedMessage v2 (아래 스키마)
        ↓
  store (SQLite: messages FTS5 + chats + sync_state + read_cursors
         + identities + sync_coverage + outbox)
        ↓
  ┌─────┴─────┐
  search     inbox
  FTS 쿼리   unread/mention 집계 (coverage 동봉)
        ↓
  safe-send (propose→approve[OOB]→send→receipt)
```

## 설계 원칙

1. **어댑터는 얇게.** 인증+원시 이벤트 수집만. 파싱·검색·정책은 어댑터에 안 둔다.
2. **Gateway는 core + ext.** core 고정: `listChats / fetchHistorical / send / watch`.
   `fetchHistorical`은 백필 시드용 수집 API이며 제품 검색 진입점이 아니다.
   제품 검색은 index에만 둔다 ("검색은 어댑터에 안 둔다"와 모순 없도록).
   플랫폼 고유 기능은 Nexus 실측처럼 ext trait로 분리한다.
3. **쓰기는 전부 outbox 경유.** `intents`(TTL 15분) → `approvals`(code) → `sends`(멱등키+receipt). 직접 send 경로를 코드에 안 남긴다.

## 데이터 모델 (v2 — inbox를 뒷받침하는 최소 집합)

```text
UnifiedMessage {
  id, platform, chat_id, author_id, ts,
  body,
  parent_id?,        // thread/reply/quote 부모
  edited_at?,        // 수정 시 FTS 재인덱싱 트리거
  deleted_at?,       // tombstone. 삭제 행을 지우지 않는다
  attachments[]?,    // 메타만 (파일명·mime·size). 본문 저장은 phase 2
}
read_cursors { platform, chat_id, last_read_id, updated_at }
identities   { platform, self_id }   // mention 탐지의 "나"
sync_state   { platform, chat_id, cursor/lastLogId }
sync_coverage{ platform, chat_id, from_ts, to_ts, complete }
```

- unread 집계 = `read_cursors` vs 수신 max. mention 탐지 = `identities` 대조.
- 수정/삭제 지원 플랫폼(Slack 등)은 `edited_at`/`deleted_at`으로 FTS를 갱신한다. 인덱스가 조용히 썩는 것을 스키마로 막는다.

## safe-send (MCP와 양립하는 정의)

openkakao `safe_send`를 가져오되 non-TTY 거부 조항은 버린다. MCP 서버는 정의상
non-TTY이므로, 그대로 이식하면 MCP는 영원히 전송 불가다.

- **승인 채널은 아웃오브밴드.** 같은 세션 내 approve가 아니라 별도 CLI/TUI/알림 채널
  + approval code + TTL 15분. 세션 경계를 넘어야 형식이 아니라 실질이 된다.
- **receipt는 2단계.** `Verified`(플랫폼이 메시지 id 반환) / `Uncertain`(AX 전송 등
  id 없음. 전송 후 composer 비움+재관측으로 판정, openkakao 방식).
- **멱등은 best-effort.** 시간창 + 내용 해시 키. 카카오 등 id 없는 경로는 "보장"이라 쓰지 않는다.
- 그 외 유지: allowlist(허용 채팅), quota(채팅당/전체 rate limit), `--dry-run`, 기본 deny.

## coverage 계약 (Day-1)

- `sync_coverage`에 플랫폼·채팅별 구간과 완전 여부를 기록한다.
- **모든 search/inbox 응답에 coverage를 동봉한다.** 완전 구간과 불완전 구간을 구분 표기.
- 초기 백필량·레이트리밋·보존 기간은 어댑터별 manifest에 명시한다. 숫자가 없으면 "전체 검색"이라 주장하지 않는다.

## privacy (로컬 인덱스는 평문 허니팟이다)

- **저장 암호화.** 인덱스 DB는 암호화 저장(SQLite 암호화). 평문 파일 하나로 두지 않는다.
- **읽기 스코프.** 허용 채팅 allowlist 밖 메시지는 수집하지 않는다. 에이전트가 DM 비밀을
  읽어 유출하는 읽기 측 위험을 수집 단계에서 차단한다.
- **접근 audit log.** 무엇이 언제 읽고 보냈는지 기록. 읽기에도 발송과 같은 수준의 추적을 둔다.
- beeptui가 토큰 저장을 경계한 것과 같은 이유다. 본문 저장을 선택한 이상 이 섹션은 선택이 아니다.

## 구현 언어: TypeScript (Bun)

- 어댑터 코드 재사용(Agent Messenger/beeptui 자산)이 Rust 이식보다 싸다.
- TUI가 OpenTUI 계열로 이어진다.
- safe_send 이식은 언어 종속이 아니라 로직 이식이다.

## 패키지 분리

`core`(타입+ports) / `index`(sync+search) / `safety` / `platform-*` / `cli`.
테스트 2층: ① fake transport 단위테스트(CI) ② fixture 캡처 재생 + 어댑터별 라이브
스모크(수동/별도 잡). **CI 녹색 ≠ 실제 동작.** SQLCipher 키 유도·AX 셀렉터는
fake transport가 못 보므로 ② 없이 "검증됨"이라 쓰지 않는다.

## ToS·법적 위험 (공학이 아니라 소유권 문제)

- 데스크톱 토큰 추출·Discord 유저 토큰 사용은 계정 정지 사유다.
- 추출 방식 어댑터는 `contrib/`로 격리하고, 개인 사용 전제 면책을 명시한다.
- "남이 의존하는 런타임"을 표방하는 순간 이 위험의 소유자와 대응책을 정해야 한다.
  MVP 단계에서는 표현을 낮추고(개인용), 격리+면책으로 충분하다.

## 차용元

- `ports` — Nexus `core-domain/ports.rs` 실측 기반
- `Gateway`+capability 게이팅 — beeptui `tui/runtime.ts` 기반
- `safe_send`+`[safety]`+`doctor/probe` — openkakao-cli 기반 (non-TTY 조항 제외)
