# inboxd

깨지는 플랫폼 위에서 안 깨지는 층. 멀티메신저 로컬-퍼스트 런타임.

- 읽기 진실원인 = 서버 API가 아니라 로컬 인덱스
- 쓰기는 승인 없이는 제안일 뿐 (기본 deny)
- 어댑터는 교체품, 진단이 복구보다 먼저

## 문서

- `docs/01-background.md` — 출발점과 문제 정의
- `docs/02-prior-art.md` — 선행 프로젝트 6종 소스코드 해부
- `docs/03-proposal.md` — 핵심 기능·아키텍처·패키지 설계
- `docs/04-roadmap.md` — 시작 순서와 MVP 범위

## 한눈에

```text
platform adapters (thin) → normalize → store (SQLite FTS5)
  → search / inbox → safe-send (propose→approve→send→receipt)
```

핵심 기능 5개: `sync`, `search`, `inbox`, `safe-send`, `doctor/probe`.
상세는 `docs/03-proposal.md`.
