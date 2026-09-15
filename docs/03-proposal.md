# 03 — Proposal: inboxd

## 핵심 철학

**서버를 믿지 않는다. 쓰기를 믿지 않는다. "결과 없음"과 "모름"을 구분한다.**

- 조회는 로컬 인덱스에서 수행하고, 원격 상태와의 차이는 coverage로 공개한다.
  (조회 경로 통일 ≠ 데이터 완전.)
- 쓰기는 승인 없이는 제안. 기본 deny. 승인은 아웃오브밴드 채널로.
- 어댑터는 교체품. 깨지는 걸 전제로 얇게 만들고, 진단(doctor)이 복구보다 먼저.
- 부분 인덱스에서 "결과 없음"은 거짓 응답이다. 모든 검색 응답에 coverage를 동봉한다.

## 첫 사용자 시나리오

> 여러 메신저에서 고객에게 약속한 내용을 근거 메시지와 함께 찾고,
> 확인한 답장만 전송한다.

검색→inbox→safe-send 순서의 근거다. 이 시나리오에 필요 없는 기능은 MVP에서 뺀다.

## 핵심 기능 5개

1. **sync** — 어댑터(poll/WS/DB-watch) → 정규화 이벤트 → 로컬 저장. `lastLogId/cursor` 백필 포함.
2. **search** — SQLite FTS5 기반 통합 검색. `query + platforms + since` 단일 API. 서버 검색 유무와 무관.
3. **inbox** — 전 플랫폼 unread/mention 요약 한 화면. 인덱스 위에서.
4. **safe-send** — propose→approve 2단계, allowlist, quota, dry-run, outbox 멱등.
   propose는 어디서나(MCP 포함), approve는 대화형 터미널에서만.
5. **doctor/probe** — auth 상태, DB 복호화, AX 셀렉터, endpoint 진단. Day-1 커맨드.

`send`는 기능이 아니라 4번을 통과한 결과물. TUI/MCP/CLI는 인터페이스일 뿐 핵심이 아니다.
사용자가 수정·삭제하는 기능은 MVP 제외. 단 원격 수정·삭제의 인덱스 반영은 포함한다
(인덱스가 조용히 썩는 것을 막는 쪽이다).

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

1. **어댑터 경계: 플랫폼 변경이 다른 부분으로 번지지 않는다.** "코드가 짧다"가 목표가
   아니다. 플랫폼별 파싱·정규화는 해당 플랫폼 모듈에 둔다. core에는 공통 이벤트
   의미+저장 규칙만 둔다. 읽기전용·실시간미지원 같은 차이는 capability로 선언한다.
   플랫폼 fixture 변경 시 수정이 해당 모듈 안에서 끝나야 한다.
2. **Gateway는 core + ext.** core 고정: `listChats / fetchHistorical / send / watch`.
   `fetchHistorical`은 백필 시드용 수집 API이며 제품 검색 진입점이 아니다.
   제품 검색은 index에만 둔다 ("검색은 어댑터에 안 둔다"와 모순 없도록).
   플랫폼 고유 기능은 Nexus 실측처럼 ext trait로 분리한다.
3. **쓰기는 전부 outbox 경유.** `intents`(TTL 15분) → `approvals`(code) → `sends`(멱등키+receipt). 직접 send 경로를 코드에 안 남긴다.

## 데이터 모델 (v2 — inbox를 뒷받침하는 최소 집합)

```text
UnifiedMessage {
  id, platform, account, chat_id, author_id, ts,
  body,
  parent_id?,        // thread/reply/quote 부모
  edited_at?,        // 수정 시 FTS 재인덱싱 트리거
  deleted_at?,       // tombstone. 삭제 행을 지우지 않는다
  attachments[]?,    // 메타만 (파일명·mime·size). 본문 저장은 phase 2
}
read_cursors { platform, account, chat_id, last_read_id, source, updated_at }
// source: synced(원본 동기화) / local(inboxd 기준) / unknown(모름)
identities   { platform, account, self_id }   // mention 탐지의 "나". 계정 범위 필수
sync_state   { platform, account, chat_id, cursor/lastLogId }
sync_coverage{ platform, account, chat_id, from_ts, to_ts, complete,
               last_verified_at, limits }
```

- unread 집계 = `read_cursors` vs 수신 max. `source=unknown`인 채팅은 0건이 아니라
  "모름"으로 표시한다. 0건 표기는 coverage 철학과 충돌한다.
- mention 탐지 MVP는 본문 매칭 + 단일계정. 정규화된 사용자·그룹 멘션 정보와
  멀티계정은 phase 2.
- 수정/삭제 지원 플랫폼(Slack 등)은 `edited_at`/`deleted_at`으로 FTS를 갱신한다.
- MVP는 단일계정으로 제한한다. 멀티계정·멀티워크스페이스는 범위 밖.

## safe-send (MCP와 양립하는 정의)

openkakao `safe_send`를 가져온다. TTY 게이트는 approve측에만 존재하므로
(`src/commands/safe_send.rs: require_approval_session`, 고정 커밋 e9d54e4에서 확인)
propose(MCP)→approve(터미널) 구조와 양립한다.

- **위협 모델 2등급.** (a) MCP 도구만 쓰는 에이전트 (b) 로컬 셸+파일 접근 가능 에이전트.
  (b)에게는 별도 CLI가 자기승인 통로가 되므로, 승인 자격증명·발송 토큰의 접근 분리가
  전제다. 강한 프로세스 격리는 등급 정의 이후에 검토한다.
- **승인 바인딩.** 승인은 계정·수신채팅·답장대상·정확 본문에 묶인다. 승인 후 내용이
  바뀌면 승인은 무효다.
- **승인 채널은 아웃오브밴드.** 같은 세션 내 approve가 아니라 별도 CLI/TUI/알림 채널
  + approval code + TTL 15분. 세션 경계를 넘어야 형식이 아니라 실질이 된다.
- **Uncertain 규칙.** 전송 여부 불명(프로세스 사망 등) 시 자동 재전송 금지. 재관측
  또는 사람 판단으로만 해소한다. 중복 발송보다 미발송+표기가 낫다.
- **receipt는 2단계.** `Verified`(플랫폼이 메시지 id 반환) / `Uncertain`(AX 전송 등
  id 없음. 전송 후 composer 비움+재관측으로 판정, openkakao 방식).
- **멱등은 best-effort.** 시간창 + 내용 해시 키. 카카오 등 id 없는 경로는 "보장"이라 쓰지 않는다.
- 그 외 유지: allowlist(허용 채팅), quota(채팅당/전체 rate limit), `--dry-run`, 기본 deny.

## coverage 계약 (Day-1)

- 응답마다 4가지를 구분한다: 검색 대상(계정·채팅·기간) / 수집 범위(백필 구간+중간 누락) /
  최신성(마지막 동기화·수정삭제 확인 시각) / 제한 사유(권한·보존기간·연결장애·미지원).
- **모든 search/inbox 응답에 coverage를 동봉한다.** 완전 구간과 불완전 구간을 구분 표기.
- **원자성.** 메시지 저장·cursor 전진·coverage 갱신을 한 트랜잭션으로 처리한다.
  저장 실패 후 cursor만 전진하는 상태를 금지한다 (데이터가 조용히 빠진다).
- 초기 백필량·레이트리밋·보존 기간은 어댑터별 manifest에 명시한다. 숫자가 없으면
  "전체 검색"이라 주장하지 않는다.

## 보존 정책 (OPEN — 제안 기본값만, 확정 보류)

| 상황 | 제안 기본값 | 상태 |
|---|---|---|
| 원본 메시지 삭제 | tombstone 유지, 본문은 보존기간 후 삭제 | OPEN |
| 채팅이 allowlist에서 제외 | 수집 중단, 기존 본문은 유지 | OPEN |
| 계정이 채팅 접근 권한 상실 | 수집 중단, 기존 본문은 유지 | OPEN |
| 계정 연결 해제 | 수집 중단, 기존 본문은 유지 | OPEN |

"원본의 현재 상태를 반영하는 인박스"와 "개인 대화 아카이브"는 원하는 동작이 다르다.
기본값을 정해야 하며, 암호화·audit log가 이 결정을 대신하지 못한다.

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

## 한국어 검색 (fixture-first)

- FTS5 기본 토큰 검색은 한국어 기대치를 못 맞춘다 ("견적서를 보내주세요" 실측:
  기본 FTS5는 `견적`·`견적서` 미검색, trigram은 `견적서` 검색·`견적` 미검색,
  3글자 미만 전문 검색 제한).
- 처음부터 복잡한 검색 엔진을 만들지 않는다. 실제 사용할 검색어 20~30개와 찾아야 할
  메시지 예시를 먼저 만들고, 조사·짧은 단어·띄어쓰기·영문 혼용 최소 기준을 정한다.
- 엔진 고도화는 fixture 통과율로 판단한다. 기준 없이 튜닝하지 않는다.

## ToS·법적 위험 (공학이 아니라 소유권 문제)

- 데스크톱 토큰 추출·Discord 유저 토큰 사용은 계정 정지 사유다.
- 추출 방식 어댑터는 `contrib/`로 격리하고, 개인 사용 전제 면책을 명시한다.
- "남이 의존하는 런타임"을 표방하는 순간 이 위험의 소유자와 대응책을 정해야 한다.
  MVP 단계에서는 표현을 낮추고(개인용), 격리+면책으로 충분하다.

## 차용元

- `ports` — Nexus `core-domain/ports.rs` 실측 기반
- `Gateway`+capability 게이팅 — beeptui `tui/runtime.ts` 기반
- `safe_send`+`[safety]`+`doctor/probe` — openkakao-cli 기반
  (TTY 게이트는 approve측 — "MCP 전송 불가"가 아니라 "MCP propose + 터미널 approve")
