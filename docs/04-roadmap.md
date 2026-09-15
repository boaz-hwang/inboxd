# 04 — Roadmap

## 순서 (껍데기부터 만들지 않는다)

1. **msg-index 스파이크** — `ports`+`Gateway` 초안 + FTS 스키마 → Slack(서버검색 있음) + Kakao(DB 읽기) 2어댑터로 `search_messages` 단일 반환 증명.
2. **safety 모듈** — openkakao `safe_send` 이식 + `[safety]` 표준 + `--dry-run` + outbox 멱등키.
3. **얇은 CLI/TUI** — 1~2 위에. `inbox/search/doctor` 먼저, `send`는 2번 경유만.

## MVP 범위

- [ ] `sync` (poll 기반 2 어댑터 + 백필)
- [ ] `search` (FTS, `query+platforms+since`)
- [ ] `safe-send` (propose→approve, allowlist, quota)
- [ ] `doctor` (auth·DB·endpoint 진단)
- [ ] fake transport 테스트 (cred 없이 CI 통과)

## Non-goals (MVP에서 제외)

- 통합 TUI 완성형 (showcase 수준만)
- thread/presence/편집·삭제·전달
- Beeper 없이 도는 Beeper 호환 전체면 (Gateway 구현체 1개로 시작)
- Windows/Linux 카카오 (macOS 전제 유지)
