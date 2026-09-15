# 02 — Prior Art (소스코드 해부, 2026-09-15)

분석용 클론: `/tmp/msg-research/` (각 repo `--depth 1`).

## 1. Agent Messenger (`agent-messenger/agent-messenger`, v2.37.1)

- 규모: `src` 비-테스트 약 60,235 LOC. Bun+TS, `commander`. `packages/` 없는 단일 패키지.
- 구조: `src/cli.ts`(93 LOC 디스패처) + `src/platforms/` 18개 + `src/shared/`(chromium 복호화·sqlite·출력) + `src/tui/` + `src/vendor/`.
- 플랫폼 = 9 user + 9 bot 변형, 완전 분리. 예: slack client 1030 / discord 669 / teams 965 / kakaotalk 1916(최대) LOC.
- **공통 추상화 사실상 없음.** 유일한 공통 타입 `src/tui/adapters/types.ts`(46 LOC, `UnifiedChannel/UnifiedMessage`)는 플랫폼 코드에서 import 0건.
- Auth: 데스크톱 토큰 추출(slack 1189 LOC 등) / QR(slack·discord·whatsapp) / 폰코드(telegram·line) / 로컬 DB 읽기(imessage) / 봇토큰 붙여넣기. 방식이 플랫폼마다 다른 플래그·파일로 파편화.
- 커버리지(전부 실구현, stubs 없음, 차이는 유무): `snapshot` 8/18곳, 서버사이드 `search` 5곳(Slack/Discord/Teams/ChannelTalk+bot), `listen` 11곳.
- TUI: `src/tui/` 17파일·약 2,800 LOC·`blessed` 기반. README 스스로 "showcase of what's possible"로 정의. 봇 변형 6종은 TUI 미지원.
- SDK: 별도 패키지 아님. `exports` 서브패스에 `./telegram`(user)·`./line`·`./imessage`·`./kakaotalk` 등 누락.
- 갭: 공통 Message/Channel 타입 부재, snapshot/search 비대칭, 이벤트 스키마 미정규화, 헤드리스용 표준 auth 없음, e2e가 자격증명 의존이라 CI 재현 불가.

## 2. beeptui (`mitchmalone/beeptui`, v0.4.1)

- 규모: `apps/cli/src` 132파일·약 17.7k LOC(테스트 포함, 소스만 8~9k). Bun+TS, TUI는 `@opentui/core`+`@opentui/react`+React 19.
- 4계층 단방향: `beeper/`(SDK import 허용 유일) → `state/`(순수 reducer 739 LOC) → `store/`(SQLite 3테이블: `drafts/view_state/chat_cache`, **메시지 본문 저장 안 함** 명시) → `tui/`.
- Beeper 의존: 기본 `http://127.0.0.1:23373`. `BeeperAdapter` 뒤에 `Gateway` 인터페이스(`tui/runtime.ts:26-40`). WS는 `/v1/ws`+`chatIDs:['*']` 구독, 지수백오프 재연결.
- Auth: 구방식(keychain 읽기전용) + 신방식 OAuth PKCE 병존. config 파일에 토큰 저장 금지.
- 기능: inbox ✅, chat fuzzy ✅(자체), message search ✅(Beeper 위임+메모리 폴백, `"partial"` 라벨), reply ✅, reaction ◐(추가만), thread ❌, 첨부 ◐(외부 열기, 인라인 렌더 미배선), edit/삭제/전달 ❌.
- 원칙: Beeper가 account·sync·encryption 경계. capability는 서버 보고 기준 게이트, 실패는 degraded 상태로 정직 노출.
- 갭: 서버 검색 종속(+scope 불신), 쓰기 천장, thread/presence 부재, Beeper Desktop 상주 전제(없으면 전부 무력화).

## 3. Nexus (`santoshakil/nexus`, Rust workspace, ~8,888 LOC/26파일)

- 구조: `crates/app-mcp/`(MCP stdio 서버+tool 정의) + `core-domain/`(`ports.rs` 287 LOC, `MessagingPort` 실재) + `mod-messaging/`(`AgentService` 레지스트리) + `infra-tdlib/google/slack/discord/whatsapp`.
- `MessagingPort`: `platform/get_profile/list_channels/read_messages/send_message/search` (`async_trait`). 확장 trait `TelegramExt`(17)·`GmailExt`(13)·`SlackExt`(10)·`DiscordExt`(10)·`WhatsAppExt`(1).
- 인증: Telegram=user session(API_ID/HASH+`nexus auth telegram`), Gmail=App Password(IMAP/SMTP), WhatsApp=Business token, Slack/Discord=bot token. **bot 중심이라 Agent Messenger "as you"와 정반대.**
- Tools: 코드상 64개 vs README 48개 불일치. WhatsApp은 send-only(`list/read/search` 전부 `not_implemented`). Discord 전역 search는 guild-scoped 중심.
- 의존성: TDLib은 `ffi.rs` 17행 `#[link(name="tdjson")]` + 외부 `libtdjson.so` 필수. "single binary ~4MB" 주장과 충돌.
- TUI 없음. 실시간 구독 없음(전부 폴링 read).
- 갭: WhatsApp 수신 공백, 실시간성 없음, TDLib 족쇄, Gmail App Password 고정, tool 목록이 환경변수에 따라 흔들림(비결정적).

## 4. 카카오 3종

| | kakaocli (Swift 6, SPM) | openkakao-cli (Rust, v1.8.1) | kakao-terminal (Python) |
|---|---|---|---|
| 읽기 | 로컬 DB 주력(SQLCipher readonly+PBKDF2 키유도) | 4-track: LOCO/DB/AX/REST + notif DB | AX 스크랩 100% |
| 보내기 | AX 10단계 자동화 | AX+LOCO 이원화 | AX+AppleScript |
| 감지 | DB 폴링 2s+webhook | LOCO/AX/notif 3채널+서명 webhook | 수동 session watch |
| 안전장치 | 문서 문구뿐 | **유일 실존**: propose→approve, outbox SQLite, TTL 15분, rate limit, 기본 deny, non-TTY 거부 | 없음 |
| harness | `--json` 우수, 단일 SKILL.md | `--json`+AGENTS.md+외부 skills+hook 디스패치 | session형 JSON, 레거시 skill 14개와 현행 불일치 |
| 관측 | 단편적 | `doctor/probe/schema` 완비 | 단편적 |

- 공통 취약점: macOS+카톡앱 종속, DB KDF/스키마 변경시 파손, AX 셀렉터 붕괴, 읽음오염/오발송.
- 공통 갭: safety 게이트 표준 부재(openkakao 제외), 실시간 내구성 공백(백필 표준 없음), skill 파편화, 관측 도구 비대칭.

## 종합 — 새 repo가 먹을 자리

어느 프로젝트도 갖지 못한 3층: **로컬 통합 인덱스(search)**, **정규화 이벤트 버스(backfill 포함)**, **승인 경계(safe-send)**.
TUI 단독·bot-token MCP·카카오 AX 래퍼 4번째는 만들지 않는다.
