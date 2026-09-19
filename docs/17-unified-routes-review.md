> 후속 결정: 전송 통합은 승인되어 구현·검증을 마쳤다. 현재 계약은
> [account workspace](12-account-workspace.md#direct-sends)를 따른다.
> 아래 현재 구조 비교는 변경 전 검토이며, scoped grant 제안은 이번 구현에 포함하지 않았다.
> 이번 권한 모델은 비공개 handshake 토큰을 사용하는 공통 로컬 owner 권한이다.
> 검색 통합·최신화는 계속 논의 중이며 변경하지 않았다.

# 검색·전송 경로 통일 검토

2026-09-19. **제안이며 구현 완료 문서가 아니다.** 현재 작업 트리의 코드를 읽어 검토했다. 별도 에이전트가 진행 중인 저장소 비동기화·소유자 전송 영속화·계약 타입 강화와 구분한다. 실계정 조회·전송·성능 측정은 수행하지 않았다.

## 결론

- 검색의 저장·권한·결과 기반을 공유하는 방향에 찬성한다. 로컬 검색과 원격 확인의 목적은 구분하며, `message.search` 하나의 명시적 모드로 표현할지 별도 메서드로 둘지는 최신성 논의 후 결정한다. 특히 Kakao의 같은 이력 반복 조회를 줄이고 TUI·MCP가 같은 데이터·범위 근거를 보게 할 수 있다. 단, **전체 계정 검색 지원과 암호화 수집 경로를 먼저 만들고 전환**해야 한다. 현재 메서드 이름만 바꾸면 검색 가능한 방과 과거 기록이 줄어든다.
- 전송을 인증된 사용자 권한의 직접 전송으로 통일하는 것도 가능하다. 별도 승인 코드를 제품 요구로 유지할 기술적 필요는 없다. 사용자는 MCP/에이전트에도 인증된 사용자 권한을 위임하여 요청별 승인 없이 전송하도록 선택했다. 이 선택을 주안으로 하여, 위임한 클라이언트 인증을 추가하고 공통 전송 실행기를 이용하는 것을 권한다.
- 승인 단계 제거와 전송 기록·중복 방지·불확실성 표현 제거는 별개다. 후자의 보장은 유지해야 한다.

## 현재 코드로 확인한 차이

| 항목 | 로컬 메시지 경로 | 계정 워크스페이스 경로 |
| --- | --- | --- |
| 검색 범위 | `message.search`: 단일 chat + 명시적 interval 필수 | `account.search`: 계정 전체 검색 가능, TUI가 계정별 병렬 조회 |
| 검색 데이터 | SQLCipher에 이미 수집된 메시지 | Slack·Telegram 검색 API, Kakao 서버 보존 이력 순회 |
| 검색 의미 | 3자 이상 FTS5 trigram phrase, 1~2자 escaped LIKE; 시간 오름차순 | 프로바이더 검색 의미 또는 Kakao 본문 매칭; 동일 결과 보장 없음 |
| 범위 설명 | coverage / gaps / limits | 원격 페이지·continuation 중심 |
| 전송 진입점 | MCP `send_propose` → intent → 승인 → coordinator | owner TUI `account.send` → 계정 backend |
| 전송 권한 | agent는 제안 가능, approver가 승인 | 토큰으로 인증된 approver만 직접 실행 |
| 전송 확인 | 지원 adapter에서 독립 readback 후 Verified | 서버 ACK는 Sent; 독립 검증은 없음 |

근거: [server.rs](../crates/inboxd-daemon/src/server.rs), [store.rs](../crates/inboxd-core/src/store.rs), [MCP](../packages/mcp/src/index.ts), [accounts.rs](../crates/inboxd-daemon/src/accounts.rs), [coordinator.rs](../crates/inboxd-daemon/src/coordinator.rs), [protocol](../crates/inboxd-protocol/src/lib.rs).

## 검색: 권장 설계

검색의 목적은 로컬 기록 검색과 원격 확인으로 구분한다. 공개 메서드를 하나로 둘지,
명시적인 두 메서드로 둘지는 논의 중이며, 로컬 전용 검색으로 대체하기로 확정한
상태가 아니다. 사용자는 로컬 결과를 먼저 보여주고 원격으로 보충하는 안을 선택한
뒤 최신성 저하 가능성을 질문했다. 로컬에 결과가 있다는 이유로 원격 확인을
생략하면 최신 관련 메시지를 놓칠 수 있으므로, 로컬 결과 유무를 최신성 판단의
기준으로 사용하지 않는다.

공통 진입점으로 표현한다면 `local`(저장된 기록), `remote`(원격 확인),
`refresh`(로컬 결과 즉시 반환 후 원격 확인도 실행)처럼 호출 목적을 명시할 수
있다. 이름과 기본값은 설계 후보다. 어느 표현을 택하든 권한·저장·중복 제거의
기반을 공유하고, 원격으로 얻은 메시지는 SQLCipher에 반영한다. 원격 검색 결과와
로컬 부분 문자열 검색은 의미가 달라질 수 있으므로 출처와 적용한 검색 방식을
표시해야 한다. 원격 검색 성공도 전체 이력·수정·삭제의 동기화 완료를 증명하지
않는다. 네트워크 수집은 공통 sync 작업으로 관리하고, 커밋 후 알림으로 UI가
재조회한다. 최신 확인을 기다리는 호출에는 시간 제한을 둔다.

1. **검색 범위를 확장한다.** 기존 단일 chat 입력을 호환하면서, 선택한 계정 전체 또는 chats 집합을 지원한다. 권한으로 허용된 범위를 서버가 확정하고 정렬·커서를 그 범위에 바인딩한다. 여러 방을 검색할 때 coverage도 방별로 반환한다. 모든 방에 개별 RPC를 보내는 임시 구현보다 저장소에서 전체 검색을 수행하는 편이 전역 정렬·페이지 정확성에 유리하다.
2. **디렉터리를 영속 등록한다.** 검색에 아직 메시지가 없는 방도 존재해야 한다. 접근 가능한 방 목록, 수집 대상 여부, 접근 상실을 별도로 기록한다. 현재 `sync.backfill`은 exact configured binding만 대상으로 하므로 account에서 발견한 방을 바로 수집할 수 없다. account worker의 검증된 이력 결과를 공통 저장소 batch로 연결하는 경로가 필요하다. 방마다 별도 세션을 만드는 방식은 피한다.
3. **이미 읽은 원본 페이지부터 저장한다.** 방 열기·디렉터리에서 얻은 최신 메시지·이력 페이지·전송 ACK를 SQLCipher로 합친다. API 화면용 메시지와 저장소 event는 현재 동일 모델이 아니다. reply, attachment, revision, source, 관측 시각을 보존하도록 정규화 계약을 보강한다.
4. **최근 구간 우선 + 과거 backfill을 별도 작업으로 실행한다.** 열린 방/활성 방을 우선하고, 나머지 대상 방은 예산 내에서 순회한다. 첫 검색은 미수집 구간을 명시해야 한다. 최초 전체 과거 수집을 검색 한 번의 응답에 묶지 않는다. 첫 설치 비용과 이후 증분 비용은 별도로 측정한다.
5. **수정·삭제를 별도로 동기화한다.** 새 메시지 cursor만 따라가는 방식으로는 충분하지 않다. 연결 중 events와 재연결 후 겹치는 구간 재검증을 조합한다. 정해진 최근 구간 재조회만으로 아주 오래된 메시지 수정까지 보장하지는 못하므로, 보장 범위를 표현하고 필요시 전체/선택 구간 재검증을 제공한다.

권장 최신화 응답은 `last_successful_sync_at`, `sync_state`, `coverage`, `limits`, mutation 검증 시각이다. 필드명은 설계 후보다. 단순 `last_refreshed_at` 하나로 계정 전체·과거 이력·수정/삭제까지 최신이라고 표시하지 않는다. 현재 `sync.status`는 `{state:"idle"}` 고정이어서 실제 작업 상태·진행률·실패·재개 지점 구현도 필요하다.

정상 연결에서의 지연 목표는 event 전파와 커밋 시간을 기준으로 잡을 수 있다. polling은 주기 + 대기열 + 실제 요청 시간만큼 지연되며, rate limit·인증 만료·오프라인 상황에는 상한을 보장할 수 없다. 구체적인 초 단위 목표는 실측 전에는 결정하지 않는다.

### 최초 검색의 과거 기록을 얼마나 유지할 것인가

| 선택 | 장점 | 대가 |
| --- | --- | --- |
| 로컬 검색만 제공, 수집 안 된 범위 표시 | 구현·검색 의미가 가장 일관됨 | 최초 수집 전에는 과거 결과 감소 |
| `message.search` 아래서 원격 검색을 수집 보조로 사용 | Slack·Telegram의 과거 검색 도달 범위를 빨리 보완 | 원격/로컬 검색 의미가 달라 완전성 보장은 여전히 불가 |
| 전환 전에 지정 과거 구간 backfill 완료 | 해당 구간은 안정적인 로컬 검색 가능 | 처음부터 네트워크·저장 공간·시간 비용 발생 |

현재 논의는 둘째 안의 빠른 로컬 결과와 원격 확인을 조합하되, 최신 확인이 필요한
호출은 원격 확인을 생략하지 않는 방향이다. 공개 검색 API가 하나여도 내부 수집
수단은 여러 개일 수 있다. **검색어에 맞는 원격 hit만 저장해서 그 시간 구간 전체를
covered라고 표시하면 안 된다.** 검색 결과가 0건이라는 사실도 이력 전체에 대한
verified-empty 근거가 아니다. 프로바이더 검색 문법을 계속 지원하려면 로컬 공통
검색 문법과 명시적으로 구분해야 한다.

### 최신화의 실제 결손

- Telegram 기존 bound worker는 메시지 ID를 revision으로 만든다([worker-core.ts](../platforms/telegram/src/worker-core.ts), `messageEvent`). 저장소는 같은 revision의 갱신을 무시한다([store.rs](../crates/inboxd-core/src/store.rs), `compare_revision` / `apply_event`). 따라서 같은 ID의 수정 내용을 다시 받아도 기존 본문에 반영되지 않을 수 있다. 안정적 ID와 변경 revision을 분리해야 한다.
- 기존 worker들은 tombstone을 빈 배열로 반환하는 경로가 있다. 저장소에 delete 이벤트 처리가 있다고 실제 원격 삭제가 수집되는 것은 아니다. 완전성을 증명하지 못한 페이지의 누락을 삭제로 추정해서도 안 된다.
- Telegram terminal page가 `mutations_verified_at`을 기록하는 것과 실제 수정·삭제 반영 가능성은 별도 검증이 필요하다. 기존 coverage 필드를 그대로 신뢰해 새 통합 경로의 보장으로 승격하면 안 된다.
- 계정 메시지 변환은 표시용이라 revision/edit/delete 및 일부 원본 구조를 보존하지 않는다. account DTO를 저장소 DTO로 단순 복사하면 결손이 이어진다.
- 1~2자 검색은 LIKE fallback이므로 전체 계정으로 확장할 때 한국어 짧은 질의의 비용을 별도 측정해야 한다. 로컬 부분 문자열과 서버 검색은 동일하지 않다. [SQLite trigram 문서](https://www.sqlite.org/fts5.html#the_trigram_tokenizer)

Telegram은 TDLib update 수신 경로를 공통 수집으로 연결하는 방향이 자연스럽다. 공식 문서는 새 메시지·내용 변경·메타데이터 변경 update와 순서대로 처리할 필요를 설명한다. [TDLib 가이드](https://core.telegram.org/tdlib/getting-started)

Slack history 수집량·권한·rate limit은 사용 토큰/배포 조건에 따라 확인해야 한다. 공식 앱의 제한을 현재 개인 세션 API에 그대로 대입하지 않는다. [Slack history 문서](https://docs.slack.dev/reference/methods/conversations.history/)

Kakao는 저장소의 API 감사 기록에 있는 listener와 증분 이력을 후보로 삼되, 새 메시지 외 수정·삭제·연결 끊김 복구 보장은 SDK 코드 및 후속 계약 테스트로 검증해야 한다. 현재 실시간 수집이 이미 구현된 것으로 간주하지 않는다. [API 감사](14-api-call-audit.md)

## 전송: 권장 설계와 선택 사항

공통 전송 명령은 예를 들어 `message.send({chat, body, parent_id?, request_id})`로 만들 수 있다. 기존 `account.send`는 한동안 동일 handler를 호출하는 호환 alias로 둔다. 이름 변경보다 **단일 권한 검사·단일 영속 전송 ledger·단일 provider 실행**이 핵심이다.

사용자 결정: **MCP/에이전트도 위임된 사용자 권한으로 직접 전송하며, 매 메시지 승인은 없다.** `send_propose` 대신 direct send 도구를 제공하고 TUI·CLI와 같은 실행기를 호출한다.

연결 설정에서 인증된 principal과 send 권한을 한 번 부여하고, 필요할 때 해제할 수 있게 한다. grant는 로컬 인증 주체, 허용 계정/범위, 부여 시각, 폐기 여부 정도로 시작할 수 있다. 범위를 전체 연결 계정으로 할지 특정 계정으로 할지는 사용자 설정이며, 작은 앱에 복잡한 승인 UI를 추가할 필요는 없다. 철회하면 이후 새 dispatch가 거절되어야 한다. 이미 provider로 나간 전송은 취소된다고 보장할 수 없다.

프로바이더 세션이 로그인되어 있다는 사실과 이 로컬 호출자가 그 세션으로 전송할 권한이 있다는 사실은 구분한다. approver 토큰을 tool 입력으로 받거나 모든 agent role을 자동 승격하기보다, 프로세스 연결 자격증명을 handshake에서 검증하고 본문의 `actor` 문자열 대신 검증된 주체를 감사 기록에 남긴다. 현재 MCP requester는 agent role 고정이고 서버는 `account.send`를 approver 전용으로 제한하므로 두 곳 모두 변경해야 한다. 이는 매 전송 승인을 되살리는 것이 아니다.

TUI·CLI·MCP는 같은 ledger의 request ID 규칙을 사용한다. request ID와 불변 payload에 대한 기존 receipt를 반환할 때도 호출 주체의 조회 권한을 확인한다. 새 MCP 도구에는 request_id를 제공/재사용할 방법이 필요하고, 연결 재시도에서 매번 새 ID를 만들어서는 안 된다.

계속 유지할 동작:

- provider 호출 **전** 영속 reservation, 같은 request ID + 같은 내용은 기존 결과 반환, 다른 내용은 충돌.
- 응답 손실·중단·재시작 시 `Uncertain`; 자동 재전송 없음. RPC 재연결도 요청을 새 ID로 재생성하지 않음. 서로 다른 ID를 새로 만들면 중복 방지 보장은 적용되지 않음.
- ACK는 `Sent`, 독립 읽기 검증이 있을 때만 `Verified`. 검증 실패를 재전송 사유로 사용하지 않음. 현재 owner ledger에는 Verified가 없으므로 통합 후 필요하면 상태/증거 모델을 확장.
- 계정/방 권한 검증과 전송 결과 감사 기록. provider ACK 메시지를 로컬 검색 저장소에도 반영하되 저장소 후처리 오류로 이미 확인한 전송을 재시도하지 않음.

폐기/이관 여부를 명시할 기존 기능:

- 제안 만료·승인 코드·승인 거절·pending 목록은 직접 전송 제품에서는 제거 가능.
- 기존 intent 전송의 quota, reply/thread, 독립 readback, 감사 기록은 승인과 독립적인 기능이다. 단순히 account.send로 바꾸면 이 중 일부가 사라진다. owner 경로의 Telegram은 현재 reply를 null로 보낸다.
- legacy Kakao template/resource 전송까지 포함할지 결정해야 한다. account.send는 개인 계정 chat 전송만 다루므로 단순 치환으로 모든 기존 resource 종류를 커버하지 않는다.
- 기존 Pending/Approved intent는 전환 시 자동 전송하지 않는다. 보관/취소/만료로 처리하고 기존 Sent·Uncertain 기록과 조회 가능성은 유지한다.

## 권장 진행 순서와 검증

1. 진행 중인 네 가지 리팩토링은 그대로 완료한다. 공통 storage/scheduler/typed contract/영속 전송은 통일에도 재사용된다.
2. 검색 범위·최초 수집 기간·위임 권한의 계정 범위·legacy 전송 기능 유지 범위를 결정한다. MCP 직접 전송 자체는 이미 사용자 결정이다.
3. 디렉터리 및 계정 원본 이력을 공통 암호화 store에 넣고, revision/delete·실제 sync 상태를 구현한다.
4. TUI를 확장된 message.search로 전환한다. 미수집 상태·갱신 중·부분 실패를 표시하고 실측한 범위에서 결과 집합을 대조한다. account.search는 호환 기간 후 제거한다.
5. 공통 direct send 실행기로 TUI/CLI 및 선택한 MCP 정책을 연결한다. 승인 경로를 제거하되 기존 데이터는 비파괴적으로 마이그레이션한다.

핵심 검증은 새 계정의 미수집 검색, 여러 방 전역 페이지, 검색 중 새 수집, 짧은 한글 검색, 같은 ID의 수정, 삭제·권한 상실, 재연결 누락, 부분 페이지와 coverage, 전송 ACK 직전/직후 중단, 같은 요청 재호출, 서로 다른 본문 충돌, MCP 권한 여부, Sent/Verified 구분이다. 전체 히스토리 동등성을 주장하려면 실제로 대조한 시간·방·보존 범위를 함께 남겨야 한다.
