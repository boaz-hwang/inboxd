# 07 — Evidence Ledger

이 문서는 설계·합성 회귀·과거 live 관측·새 live 관측을 분리한다. CI 통과는 live 제품 증거를 대체하지 않는다.

## 상태 분류

- `SYNTHETIC`: 익명 fixture 또는 fake transport에서 재현됨.
- `LOCAL_OBSERVED`: 현재 호스트의 제품 코드 경로에서 실행·재개방·통합 테스트로 관측됨.
- `HISTORICAL_LIVE`: 과거 실제 실행을 sanitize한 기록이며 현재 재실행·완전성을 보장하지 않음.
- `NEW_LIVE_OBSERVED`: 이번 검증에서 실제 계정 경로로 관측했으며 명시된 범위만 증명함.
- `NEW_LIVE_REQUIRED`: 제품 수락 전에 제한된 실제 계정·채팅에서 새로 관측해야 함.
- `BLOCKED`: 필요한 사용자 provenance, 인증, 권한 또는 환경이 없음.

## 증거표 (2026-09-16)

| 주장 | 상태 | 근거 | 제품 판정 |
|---|---|---|---|
| Slack 제한 채팅 읽기 | HISTORICAL_LIVE | `spike-a` commit `8b52756`: 두 승인 식별자, 89 unique rows, 본문·식별자 redacted | 재현·완전성 미증명 |
| Slack bounded cursor pagination | NEW_LIVE_OBSERVED | 승인된 30-day private scope에서 실제 2+2 cursor page, overlap 0, descending ordering | 해당 bounded cursor 동작만 PASS; complete history·429 recovery 미증명 |
| Slack wrapper complete history | BLOCKED | wrapper가 pagination metadata/cursor를 버림 | 항상 incomplete coverage |
| 중단 후 재개 | SYNTHETIC | between-wrapper-call 4/4, gaps/extra 없음 | page 내부 재개 미증명 |
| 100k 검색 p95 ≤300ms | SYNTHETIC | production-shaped SQL/materialization/serialization PASS | 암호화 제품 경로 미증명 |
| 한국어/영어 검색 25개 | SYNTHETIC | hybrid 25/25 | 실질문 품질 미증명 |
| 사용자 실질문 5개 | NEW_LIVE_OBSERVED | 사용자 원문 5개를 live MVP 경계에서 실행·분류: Q1·Q2·Q5 product gap, Q3 collection miss, Q4 Kakao retrieval 4건 | 표본 실행 5/5; retrieval 성공 1/5이며 나머지 gap은 숨기지 않음 |
| Slack send-as-user | NEW_LIVE_REQUIRED | 문서/코드 capability만 확인, live send 없음 | 미검증 |
| KakaoTalk wrapper 정규화 | SYNTHETIC | `spike-b-kakao-telegram` commit `3a32990` | live auth/read 없음 |
| KakaoTalk wrapper session resume 결함 | LOCAL_OBSERVED | 2.37.1에서 first full LOGINLIST 뒤 fresh client의 empty/partial delta를 재현; 기존 구현은 2→0 또는 2→1 | 근본원인 확정; live fix 검증은 별도 gate |
| KakaoTalk wrapper chat-list bootstrap 수정 | LOCAL_OBSERVED | `spikes/B/patches/agent-messenger-2.37.1-kakao-chat-bootstrap.patch`; RED→GREEN, client 151/151, targeted lint, typecheck, build | persisted checkpoint 세션의 첫 LCHATLIST만 `(0,0)`, 후속 cursor 보존 |
| KakaoTalk sequential-process live resume | NEW_LIVE_OBSERVED | 독립 process 2회가 각각 49 chats·49 unique·MemoChat 1 및 동일 privacy-safe digest 반환 | 현재 계정/run의 nonzero·stability gate PASS |
| Telegram wrapper 정규화 | SYNTHETIC | 같은 commit, stable canonical chat-id 회귀 | live auth/read 없음; MVP 밖 |
| 원래 Kakao Spike B DB/KDF/schema/AX | BLOCKED | privacy-safe harness는 구현됐으나 승인된 live 입력 없음 | local DB/AX route 활성화 금지; wrapper route와 별개 |
| SQLCipher 파일/WAL 재개방 | LOCAL_OBSERVED | SQLCipher 4.19.0, correct/wrong/no-key, 일반 SQLite 거부, FTS, WAL; production path/hash 검증 | 현재 macOS build만 PASS |
| daemon/store/protocol/CLI/safety | LOCAL_OBSERVED | 단일 owner, UDS 0600, bounded pagination, coverage, read audit, restart Uncertain, global/scope quota | live adapter/send는 별도 gate |
| OpenTUI 5화면 | NEW_LIVE_OBSERVED | 실제 Kakao data의 daemon에 연결해 5화면 controller 및 pseudo-TTY OpenTUI `q` 종료 code 0 관측 | live rendering/teardown PASS; 화면별 제품 gap은 별도 |
| MCP inbox/search/coverage read | NEW_LIVE_OBSERVED | 실제 Kakao data의 동일 UDS에서 inbox/search/coverage 응답 관측; agent에는 approve/code 없음 | live read smoke PASS; live propose는 이 행의 증거가 아님 |
| Kakao read-only 제품 adapter | NEW_LIVE_OBSERVED | stable↔transport exact binding, MemoChat bounded read, sync/store/daemon/CLI/TUI/MCP 경로 관측 | wrapper-transport 제품 경로 PASS; 원래 DB/KDF/AX route는 미증명 |
| Kakao controlled self-chat send | NEW_LIVE_OBSERVED | exact user-approved payload, trusted local TTY approval, transport call 1, idempotency key 1, Sent receipt와 exact-body read-back 일치 | 1회 PASS; ambiguous retry 없음; repository에는 live sender가 기본 구성되지 않음 |

## 유지해야 할 판정 경계

1. Slack Spike A의 commit 품질은 PASS지만 전체 Spike A와 MVP는 BLOCK이다.
2. KakaoTalk·Telegram wrapper 확장의 commit 품질은 PASS지만 live/product/MVP 증거는 아니다.
3. `coverage.complete=false`는 실패 은폐가 아니라 wrapper의 관측 한계를 보존하는 계약이다.
4. 원본 메시지, private chat identifiers, exact live timestamps, credential 값은 Git에 남기지 않는다.
5. 사용자 실질문 표본은 5개로 축소됐고 모두 분류됐지만 product gap 3개와 collection miss 1개는 해결되지 않았다.

## 다음 관측 게이트

- Independent code/security/verification review와 clean full repository gate.
- Slack authoritative history와 rate-limit recovery는 여전히 미증명이다.
- 원래 Kakao local DB/KDF/schema/AX route는 미측정이며 wrapper 제품 경로와 구분한다.
- Retrieval product gaps: cross-platform recent/summary, cross-platform latest, authoritative sender=self filter.
