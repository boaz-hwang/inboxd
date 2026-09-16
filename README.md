# inboxd

깨져도 진단되고 데이터는 남는 층. 멀티메신저 로컬-퍼스트 런타임.

- 읽기 진실원인 = 서버 API가 아니라 로컬 인덱스
- 쓰기는 승인 없이는 제안일 뿐 (기본 deny, 아웃오브밴드 승인)
- 어댑터는 교체품, 진단이 복구보다 먼저
- "결과 없음"과 "모름"을 구분한다 (모든 검색 응답에 coverage 동봉)

## 문서

- `docs/01-background.md` — 출발점과 문제 정의, 범위
- `docs/02-prior-art.md` — 선행 프로젝트 6종 소스코드 해부 (커밋 핀 포함)
- `docs/03-proposal.md` — 핵심 기능·아키텍처·스키마·프라이버시
- `docs/04-roadmap.md` — 순서와 MVP 완료 기준
- `docs/05-architecture-review.md` — 설계 비판 검토 (2026-09-16): 유지 항목과 보완할 계약·검증 과제
- `docs/06-architecture.md` — 검토 반영 설계: 데몬 런타임·패키지·store 계약·승인 경계·TUI·빌드 순서
- `docs/07-evidence-ledger.md` — 합성·과거 live·새 live 필요·blocked 증거와 MVP claim 경계

## 구현 아키텍처와 남은 live gate

```text
inboxd daemon (DB write · sync · outbox 실행 · 발송 토큰 · audit 독점)
  platform adapters (thin) → normalize → store (SQLCipher + FTS5)
    → search / inbox (coverage 동봉) → safe-send (propose→approve[OOB]→send→receipt)
  ▲ Unix domain socket
  cli (TTY, approve) · tui (TTY, approve) · mcp (agent, propose만)
```

핵심 기능 5개: `sync`, `search`, `inbox`, `safe-send`, `doctor/probe`.
인터페이스는 CLI → **Slack TUI(첫 제품 마일스톤)** → MCP 순.
먼저 Slack 제한 채팅의 수집부터 CLI 검색까지 검증하고 기능을 확장한다.
TypeScript MVP checkpoint는 카카오 wrapper 읽기 통합과 사용자가 확정한 Slack·카카오
실질문 5개 분류를 포함한다. 카카오 기본 send adapter는 여전히 범위 밖이며, 별도 승인된
self-chat controlled-send 1회는 safety 경계의 관측 증거로만 취급한다.
상세는 `docs/03-proposal.md`, 빌드 순서는 `docs/06-architecture.md` §7.

## 현재 관측 상태 (2026-09-16)

- Slack Spike A는 **PARTIAL**이다. 제한된 두 식별자에서 과거 89개 메시지를 읽은
  기록과 합성 fixture·성능 결과는 있으나, wrapper가 pagination metadata를 버려
  완전 이력·page 내부 중단 복구·authoritative coverage는 증명하지 못했다.
- KakaoTalk wrapper 경로는 bootstrap 수정 뒤 bounded live read와 exact-bound 제품 통합을
  관측했다. Telegram은 synthetic 상태다. 이 결과는 원래 Kakao Spike B의 DB KDF·schema·AX
  측정 증거가 아니다.
- SQLCipher store, 단일 daemon/UDS, coverage 동봉 search/inbox, protocol-only CLI,
  approval/outbox safety, 5화면 OpenTUI, MCP 도구는 로컬 통합 테스트로 구현·관측됐다.
  자동 테스트와 live evidence는 별도 증거 축으로 유지한다.
- Slack 제품 adapter는 wrapper 한계 때문에 degraded/incomplete coverage만 제공한다.
  Kakao 제품 adapter는 승인된 wrapper measurement와 exact stable binding이 없으면 I/O를
  거부한다. 원래 local DB/KDF/AX route 활성화는 계속 **BLOCKED**다.
- 10만 건·한국어 25개 fixture는 합성 검증이다. 사용자 원문 질문 5개는 live 경계에서
  모두 분류됐지만 retrieval PASS 1건, collection miss 1건, product gap 3건이다.

## 보호 범위 (정직하게)

MVP는 **MCP 도구만 쓰는 에이전트**의 오발송을 막는다. 승인 code는 TTY 승인 클라이언트에만
전달되고 발송 토큰은 데몬만 갖는다. 로컬 셸·파일 접근이 있는 에이전트는 승인 클라이언트로
접속하고 키체인을 읽을 수 있으므로 MVP는 그 경우를 보호한다고 주장하지 않는다.
DB 암호화는 파일 유출 대비이지 같은 사용자로 도는 프로세스를 막는 장치가 아니다.
