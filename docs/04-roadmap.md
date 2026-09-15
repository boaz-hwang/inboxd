# 04 — Roadmap

## 순서 (설계가 스파이크보다 먼저다)

아래 0~2가 정리되기 전에는 로드맵 1단계에 착수하지 않는다. 스파이크 결과가
설계 변경으로 무효화되기 때문이다.

- **0. MCP 승인 채널 설계** — safe-send 정의를 바꾸므로 1순위. OOB 채널(별도 CLI/TUI/알림)
  + approval code + TTL. 같은 세션 approve 금지.
- **1. 역할 분리** — `Gateway.fetchHistorical`(백필 시드) vs 제품 검색(index 전용).
  `search`라는 이름이 두 층에 걸치지 않도록.
- **2. inbox 스키마 v2** — `read_cursors`, `identities`, `edited_at/deleted_at`,
  `sync_coverage` 테이블. 이 없이는 inbox 쿼리가 안 나온다.
- **3. privacy** — 저장 암호화 + 읽기 스코프 + audit log.

## 스파이크 (0~2 이후)

- **Spike A — 아키텍처 증명 (Slack).** ports→normalize→FTS→search 단일 반환.
  가장 안정적인 어댑터로 구조를 증명한다.
- **Spike B — 리스크 측정 (카카오 DB 읽기).** 아키텍처 증명이 목적이 아니다.
  SQLCipher 해독·DB 스키마·AX 셀렉터 생존율을 측정하고 manifest 숫자(백필 속도·파손 조건)를 뽑는다.
- **Teams는 phase 2.** 토큰 만료(60~90분) 대응(sync 중단 시 coverage 표기+재추출 흐름)이
  선행 과제이며 MVP 완료 기준에 포함하지 않는다.

## MVP 완료 기준 (숫자)

- [ ] 백필: Spike A 기준 10만 메시지 수집 + 재개(cursor 이어받기) 동작
- [ ] 검색: `query+platforms+since` 단일 API, p95 300ms (로컬 기준, 측정 후 조정)
- [ ] coverage: 모든 search/inbox 응답에 coverage 동봉 100%
- [ ] safe-send: propose→OOB approve→send→receipt(Verified/Uncertain) 전 경로 동작
- [ ] doctor: auth·DB·endpoint 진단 커맨드 동작
- [ ] 테스트: fake transport CI 통과 + 어댑터별 라이브 스모크 1회 이상 기록

## Non-goals (MVP에서 제외)

- 통합 TUI 완성형 (showcase 수준만)
- thread/presence/편집·삭제·전달 (스키마 자리만 확보)
- Beeper 호환 전체면 (Gateway 구현체 1개로 시작)
- Windows/Linux 카카오 (macOS 전제 유지)
