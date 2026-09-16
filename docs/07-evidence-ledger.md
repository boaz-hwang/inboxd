# 07 — Evidence Ledger

이 문서는 설계·합성 회귀·과거 live 관측·새 live 관측을 분리한다. CI 통과는 live 제품 증거를 대체하지 않는다.

## 상태 분류

- `SYNTHETIC`: 익명 fixture 또는 fake transport에서 재현됨.
- `HISTORICAL_LIVE`: 과거 실제 실행을 sanitize한 기록이며 현재 재실행·완전성을 보장하지 않음.
- `NEW_LIVE_REQUIRED`: 제품 수락 전에 제한된 실제 계정·채팅에서 새로 관측해야 함.
- `BLOCKED`: 필요한 사용자 provenance, 인증, 권한 또는 환경이 없음.

## 증거표 (2026-09-16)

| 주장 | 상태 | 근거 | 제품 판정 |
|---|---|---|---|
| Slack 제한 채팅 읽기 | HISTORICAL_LIVE | `spike-a` commit `8b52756`: 두 승인 식별자, 89 unique rows, 본문·식별자 redacted | 재현·완전성 미증명 |
| Slack wrapper complete history | BLOCKED | wrapper가 pagination metadata/cursor를 버림 | 항상 incomplete coverage |
| 중단 후 재개 | SYNTHETIC | between-wrapper-call 4/4, gaps/extra 없음 | page 내부 재개 미증명 |
| 100k 검색 p95 ≤300ms | SYNTHETIC | production-shaped SQL/materialization/serialization PASS | 암호화 제품 경로 미증명 |
| 한국어/영어 검색 25개 | SYNTHETIC | hybrid 25/25 | 실질문 품질 미증명 |
| 실질문 10개 | BLOCKED | anonymous candidate trace뿐, 사용자 확인 provenance 없음 | MVP blocker |
| Slack send-as-user | NEW_LIVE_REQUIRED | 문서/코드 capability만 확인, live send 없음 | 미검증 |
| KakaoTalk wrapper 정규화 | SYNTHETIC | `spike-b-kakao-telegram` commit `3a32990` | live auth/read 없음 |
| Telegram wrapper 정규화 | SYNTHETIC | 같은 commit, stable canonical chat-id 회귀 | live auth/read 없음; MVP 밖 |
| 원래 Kakao Spike B DB/KDF/schema/AX | BLOCKED | wrapper 확장은 해당 측정을 수행하지 않음 | W13 전 미수행 |
| SQLCipher 파일/WAL 재개방 | BLOCKED | Spike 0 없음, SQLCipher 미설치 | 실제 메시지 제품 저장 금지 |
| daemon/protocol/CLI/TUI/MCP/safety | NEW_LIVE_REQUIRED | 현재는 목표 설계만 존재 | 구현·fixture·live gate 필요 |

## 유지해야 할 판정 경계

1. Slack Spike A의 commit 품질은 PASS지만 전체 Spike A와 MVP는 BLOCK이다.
2. KakaoTalk·Telegram wrapper 확장의 commit 품질은 PASS지만 live/product/MVP 증거는 아니다.
3. `coverage.complete=false`는 실패 은폐가 아니라 wrapper의 관측 한계를 보존하는 계약이다.
4. 원본 메시지, private chat identifiers, exact live timestamps, credential 값은 Git에 남기지 않는다.
5. full MVP는 Slack TUI 마일스톤과 별개이며 Kakao 읽기 제품 통합과 사용자 확인 실질문 10개가 필요하다.

## 다음 관측 게이트

- Spike 0: SQLCipher dylib, correct/wrong/no-key reopen, ordinary SQLite denial, FTS, WAL.
- Slack: 승인된 안정 chat ID, cursor/page/rate-limit 관측, controlled safe-send receipt.
- Kakao: 사용자 소유 macOS 환경에서 DB/KDF/schema/AX 측정 후 read-only 제품 경로.
- Retrieval: 사용자가 실제 확인하려던 Slack·Kakao 질문 10개와 source-message 대조.
