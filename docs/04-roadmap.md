# 04 — Roadmap

## 소유 범위 결정 (게이트)

새 저장소를 만드는 것은 괜찮다. 다만 어댑터까지 직접 구현·이식하기 전에
기존 도구를 감싼 연결(wrapper-first)로 시작하고, 막히는 지점을 확인한 뒤
소유 범위를 넓힌다. 독창부는 연결 기술이 아니라 수집 메시지를 신뢰하고
안전하게 쓰는 방식에 있다.

| 대안 | inboxd가 책임질 부분 | 판단 기준 |
|---|---|---|
| 기존 CLI/SDK 위에 구축 | 인덱스·정규화·승인만 | 감싼 연결로 첫 검증이 되면 이대로 |
| Beeper + 카카오 별도 연결 | 위 + 수집경로 통합 | 직접연결이 막힐 때 (카카오 지원·독립실행·데이터 소유 요구 기준) |
| 플랫폼별 직접 연결 | 위 + 인증·프로토콜 유지보수 | wrapper가 실제 요구를 못 맞출 때만 |

Beeper를 선택적 Gateway로 허용하되, 사용 조건 판단 기준 없이 올리지 않는다.

## 설계 기본 결정 (06-architecture)

05-review의 6개 보완점은 06-architecture의 기본 결정과 검증 과제로 반영했다.
스파이크에서 반례가 확인되면 관련 계약과 완료 기준을 함께 수정한다.

- **런타임 모델.** 데몬 1개(DB write·sync·outbox 실행·발송 토큰·audit 독점) + UDS 클라이언트(CLI/TUI/MCP).
- **승인 채널.** propose 응답에 code 없음, code는 `role=approver`(TTY) 접속에만.
  바인딩 `bound_hash`(intent·계정·채팅·대상·본문·만료), 1회용. **MVP는 등급 (a)만 보호 주장.**
- **역할 분리.** `Gateway.fetchHistorical`(백필 시드) vs 제품 검색(`store` query 전용).
- **스키마 v2.** `read_cursors(source)`, `identities`, `edited_at/deleted_at`,
  `sync_coverage` **채팅당 구간 집합**(`kind`·`collected_at`·`mutations_verified_at`),
  미수집 사유는 `sync_limits`. 신규 백필과 과거 수정·삭제 재검증을 분리한다.
- **이벤트 적용 순서.** 식별 키 + 어댑터 `revision`, tombstone 우선, 낮은 revision 무시.
- **outbox 실행 계약.** 현재 allowlist·승인 재검사, quota 예약과 조건부 UPDATE 선점을
  한 트랜잭션에서 수행. 재시작 시 `Sending→Uncertain`, 자동 재전송 없음.
- **privacy.** SQLCipher + 파일 재개방 검증(Spike 0) + allowlist + audit.
- **TUI.** 재연결 시 구독 후 재조회, 조회 중 변경은 재조회로 해소. 초안은 메모리 전용.

## 빌드 순서 (Slack TUI가 첫 제품 마일스톤)

상세 표와 단계 번호는 06-architecture §7. 최소 실제 경로를 먼저 검증한 뒤 확장한다.
필수 계약은 다음 통합 전에 검증하되 독립적인 fixture·UI 작업을 순차 대기시키지 않는다.
아래는 **계획 순서**이며 완료 현황이 아니다.

```text
0 암호화 → 1 Slack 제한 채팅 → 암호화 store → daemon API → CLI 검색 (Spike A)
→ 2 읽기 계약·동기화·성능 확장 → 3 safety + CLI approve
→ 4 Slack TUI 마일스톤 → 5 MCP
B 카카오 측정 (1~2와 병행 가능) → 6 카카오 읽기 제품 통합
5·6 및 모든 완료 기준 통과 → 전체 MVP
```

읽기 경로(0~2)는 승인 구현(3)과 독립적으로 진행한다. TUI의 조회 화면은 검증된 API가
생기면 연결할 수 있고, Approvals의 실제 발송은 3의 검증 이후다. 4 완료에는 화면 5개와
Slack 읽기·쓰기·재연결 검증을 요구한다. 카카오와 MCP의 독립 작업은 병행 가능하다.
전체 MVP의 실질문 10개는 두 플랫폼을 포함하며, Slack만으로 마일스톤을 통과했다고
전체 MVP 완료로 보지 않는다.

### 관측된 진행 현황 (2026-09-16)

| 항목 | 상태 | 증거 경계 |
|---|---|---|
| Spike 0 암호화 | PASS_LOCAL | SQLCipher 4.19.0 dylib provenance, correct/wrong/no-key, 일반 SQLite 거부, FTS, WAL 재개방 통과 |
| Spike A Slack | PARTIAL | 과거 제한 live read 89개; 합성 재개·100k·한국어 fixture 통과; wrapper completeness/cursor 미증명 |
| Spike A 실질문 A5 | BLOCKED | anonymous synthetic trace뿐이며 사용자 확인 provenance 없음 |
| 원래 Spike B Kakao DB/AX | BLOCKED_SAFE_HARNESS | privacy-safe harness 구현; KDF·schema·AX selector·live backfill은 승인된 환경에서 미측정 |
| KakaoTalk·Telegram wrapper 확장 | IMPLEMENTED_SYNTHETIC / LIVE_BLOCKED | 계정 미설정; B 또는 제품 통합 단계 6을 대체하지 않음 |
| 단계 2–5 | IMPLEMENTED_LOCAL | encrypted store·daemon/UDS·bounded coverage reads·safe outbox·CLI·5화면 OpenTUI·MCP를 146개 테스트로 검증 |
| 단계 6 Kakao | IMPLEMENTED_SYNTHETIC / LIVE_BLOCKED | 측정 PASS 전 I/O를 거부하는 read-only adapter; live 제품 통합은 미완료 |

## 스파이크

- **Spike 0 — 암호화 검증 (실제 메시지 저장 전 필수).** `setCustomSQLite`+SQLCipher
  dylib로 FTS5와 암호화 동시 동작 확인. 파일 재개방 기준(올바른 키 복원 / 키 없음·틀린
  키·일반 SQLite 판독 불가 / WAL 포함). 산출물 `spikes/0-encryption/manifest.json`.
  실패 시 대안 엔진을 이 시점에 고른다.
- **Spike A — 아키텍처 증명 (Slack, wrapper-first).** ports→normalize→FTS→search
  단일 반환. 먼저 명시할 것: 사용할 인증 방식, 읽을 수 있는 대화 범위, 적용
  레이트리밋, 사용자 명의 발송 여부. 가장 안정적인 어댑터로 구조를 증명한다.
- **Spike B — 리스크 측정 (카카오 DB 읽기).** 아키텍처 증명이 목적이 아니다.
  SQLCipher 해독·DB 스키마·AX 셀렉터 생존율을 측정하고 manifest 숫자(백필 속도·파손 조건)를 뽑는다.
  그 뒤 읽기 어댑터를 sync·store·API·TUI에 연결하는 별도 제품 통합 단계가 있다.
  MVP 발송은 Slack만 검증하고 카카오는 `send: false`로 선언한다. 읽기가 불가능하면
  원인과 재검증 조건을 기록하고 전체 MVP는 미완료로 둔다.
- **Teams는 phase 2.** 토큰 만료(60~90분) 대응(sync 중단 시 coverage 표기+재추출 흐름)이
  선행 과제이며 MVP 완료 기준에 포함하지 않는다.

## MVP 완료 기준 (숫자)

읽기:

- [ ] 10만 건 fixture로 저장·검색 성능 검증 (규모 증명)
- [ ] 실제 Slack에서 권한·페이지네이션·중단 후 재개 검증 (연결 증명)
- [ ] 검색 p95 300ms (로컬 기준, 측정 후 조정)
- [ ] 모든 search/inbox 응답에 coverage 동봉 100%
- [ ] **실질문 10개 게이트.** 본인이 실제로 확인할 필요가 있었던 대화 질문 10개를
  Slack·카카오 제한 채팅에서 찾아 원문과 대조한다. 못 찾은 이유를 수집 범위 /
  검색 품질 / 접근 한계로 분류한다. 메시지 규모가 아니라 실제 질문이 기준이다.
- [ ] inbox 정확성: unread 정의(source별)와 "모름" 표기 검증
- [ ] 한국어 fixture 20~30개 최소 기준 통과 (조사·짧은 단어·띄어쓰기·영문 혼용)
- [ ] coverage 구간 fixture: 가운데 빈 두 구간 / verified_empty / 미수집 채팅 /
  백필 중단·재개에서 `gaps`·`limits`가 유지됨
- [ ] 구간 병합 후 서로 다른 최신성 보존, 행 없는 제한 구간의 사유 표시,
  신규 백필만 성공했을 때 과거 수정·삭제 확인 시각을 갱신하지 않음
- [ ] 이벤트 적용 fixture 4종(동일 이벤트 반복·수정 뒤 오래된 백필·삭제 뒤 create 재생·
  create보다 먼저 온 delete)에서 messages와 FTS 일치
- [ ] 카카오 읽기 어댑터가 sync·store·API·TUI까지 연결되고 허용 채팅 수집·재개 및
  변경 미확인 상태를 표시함. 카카오 compose는 비활성화

쓰기·보호:

- [ ] safe-send: propose→OOB approve→send→receipt(Verified/Uncertain) 전 경로 동작
- [ ] 승인 우회 거부 테스트 — 범위는 **데몬 API를 통한 발송 시도**로 한정 기록
  (등급 (a) MCP 클라이언트가 code를 받지 못함을 포함)
- [ ] outbox 선점 테스트: 동일 승인 건 동시 claim → 원격 호출 1회 / claim 직후 종료·
  원격 성공 직후 종료 주입 → 재시작 후 자동 발송 없이 `Uncertain` 표시
- [ ] 승인 후 allowlist 제외 → 원격 호출 0회 / 서로 다른 intent의 quota 경쟁 →
  남은 quota 이내 호출 / 재시작 후 Uncertain의 quota 소비 유지
- [ ] 허용 범위 밖 수집 차단 테스트
- [ ] 암호화 저장 + 키 관리 동작 — Spike 0의 파일 재개방 검증을 증거로 삼음
  (선택이 아니라 완료 조건)

TUI (Slack 제품 마일스톤, 전체 MVP와 구분):

- [ ] 화면 5개(Inbox/Search/Chat/Approvals/Doctor) 동작, Inbox `unknown`이 0과 구분 표시
- [ ] Search 결과 상단에 `gaps` 고정 표시, Chat에 gap 구분선
- [ ] Approvals 화면에서 code 입력으로 실제 1건 발송(Verified) 및 Uncertain 1건 표시
- [ ] 데몬 끊김 시 `degraded` 표시 + 재연결 후 메시지·coverage·승인 상태가 데몬과 일치.
  구독/조회 사이의 변경과 이전 연결의 늦은 응답도 주입해 검증
- [ ] 초안·검색어·본문·승인 code·토큰이 `tui.json`에 저장되지 않고 종료 시 초안 유실 안내
- [ ] `tui`가 `store`·`platforms`를 import하지 않음(의존 방향 검사)

관측:

- [ ] doctor: auth·DB·암호화(cipher_version+파일 헤더)·endpoint 진단 + 등급 (b) 미보호 경고 출력
- [ ] 테스트: fake transport CI 통과 + 어댑터별 라이브 스모크 1회 이상 기록
- [ ] MCP가 기존 데몬 API를 사용하며 core·store·safety를 재작성하지 않음.
  API를 보완한 경우 CLI/TUI 호환성과 승인 경계 유지 검증

위 기준을 모두 통과해도 실질문 10개 게이트를 못 넘으면 MVP 미완료다.
Slack만 잘 되고 카카오 실질문이 안 풀리면 핵심 사용처 미검증으로 기록한다.

## Non-goals (MVP에서 제외)

- TUI 완성형. MVP TUI는 화면 5개·coverage 표기·승인 경로까지. thread 뷰·첨부 인라인·테마·멀티계정 전환 제외
- 등급 (b) 셸 에이전트 보호 (OS 사용자 분리·샌드박스). 현 구조가 이행을 막지 않음을 확인하는 선까지
- launchd 등록·비-macOS 암호화 (phase 2)
- 영속 TUI 초안·영속 이벤트 재생. 초안은 메모리, 재연결 복구는 구독 후 재조회
- thread/presence/사용자 측 편집·삭제 (원격 변경 반영은 포함)
- Beeper 호환 전체면 (Gateway 구현체 1개로 시작)
- Windows/Linux 카카오 (macOS 전제 유지)
- 멀티계정·정규화 멘션·검색 엔진 고도화 (phase 2)
