# API 호출 최소화 검토

2026-09-19 구현 전 조사 기록. 이후 구현·검증 결과는 [최적화 결과](15-startup-optimization-results.md)를 참고한다.

범위: inboxd가 사용하는 Telegram·Slack·KakaoTalk의 개인 계정 경로, 연결/인증,
기존 제한된 채팅방 worker 경로, SDK 내부 호출 및 이를 대체할 관련 API.
메신저의 모든 관리·결제·파일 API를 열거하는 대신 현재 기능의 모든 호출 경로를 추적했다.
외부 쓰기·로그인 재인증·메시지 발송 테스트는 하지 않았다.

## 판단 기준

- 같은 데이터와 기능을 유지하며 중복 제거·일괄 조회·응답 재사용하는 것을 우선한다.
- 지연 실행은 최초 요청 수를 줄이지만 전체 요청 수 감소와 구분한다.
- 초기 전체 수집 비용과 정상 연결 중 변경분 수집 비용을 구분한다.
- 캐시는 수집하지 않은 기록이나 끊긴 동안의 변경을 만들어낼 수 없다.
- SDK 함수/로컬 RPC/TDLib 조회/실제 HTTP·LOCO 서버 요청을 별도로 센다.
- 한 페이지를 크게 받아 로컬에서 나눠 표시할 수 있지만 응답 크기 제한과
  유실 없는 커서 처리가 먼저다. 현재 account 응답은 60KB 상한이다.

## 확인된 수치

| 측정 | 결과 | 근거 수준 |
| --- | --- | --- |
| Slack 26개 방 전체 목록 | list 1 + history 26 + users.info 15 = 42회 | 실제 어댑터 HTTP 계측 |
| Slack users.list | 326ms, 사용자 15명, 다음 페이지 없음 | 현재 개인 세션 실제 조회 |
| Slack 사용자 ID 대조 | DM 상대 15명 중 14명만 users.list에 존재 | 실제 목록 ID 집합 비교; 개별 fallback 1회 필요 |
| Slack client.counts | 323ms, channels 11 + ims 9, 최신 시각·변경 필드 제공 | 현재 개인 세션 실제 조회 |
| Slack counts 범위 대조 | 26개 방 중 20개 포함, 누락 6개는 모두 비보관 DM | 실제 목록 ID 집합 비교 |
| Slack rtm.connect | 230ms, 성공 및 wss 주소 반환 | 실제 API 성공; WebSocket 수신/누락 복구 미검증 |
| Kakao 46개 방 전체 목록 | GETCONF 1 + CHECKIN 1 + LOGINLIST 1 + LCHATLIST 1 + CHATINFO 48 + GETMEM 2 = 54회 | 설치 SDK 2.37.1 소스에 계측 후 실제 조회 |
| Kakao 방 열기 | 최대 100개 이력 페이지 | 코드상 상한, 실사용 호출 수 아님 |
| Kakao 검색 한 번 | 최대 25 worker × 8 이력 페이지 = 200페이지 | 코드상 상한, 실사용 호출 수 아님 |

Kakao 첫 계측은 번들/소스 모듈이 달라 후킹되지 않았다. 위 수치는 소스 SDK client를
어댑터에 주입하고 같은 소스의 LOCO sendPacket을 계측한 재실행 결과다.
서버 요청 이름과 집계만 기록했으며 메시지·계정 ID·키·WebSocket URL은 기록하지 않았다.

## Slack: 호출별 판단

| API/경로 | 현재 목적·반복 | 최소화 방법 | 한계/판정 |
| --- | --- | --- | --- |
| conversations.list | 전체 방, 200개 단위 | 한 번 수집해 공유; 계정 수명주기 캐시 | 가입/탈퇴/보관 변경 반영 필요; 방을 빼서 줄이지 않음 |
| users.info | DM 제목과 메시지 작성자마다 | users.list 페이지 단위 사전 수집 + 누락 ID만 개별 조회 | 대형 워크스페이스는 전체 사용자 조회가 더 비쌀 수 있어 적응형 선택 |
| users.list (후보) | 이름 일괄 조회 | 현재 계정은 1페이지 15명 | 목록 밖 외부 사용자 fallback 필요; 이름 변경 갱신 |
| conversations.members | 그룹 DM 이름 구성 | 방별 멤버 캐시, 변경 시만 재조회 | 현재 첫 200명만 읽음; 완전성 해결과 함께 최적화 |
| conversations.history (목록) | 방마다 최신 메시지 1개 | 최초 1회 수집 후 변경 방만 조회 | 공개 history에는 다중 방 batch 인자가 없음 |
| client.counts (후보) | 최신 시각/변경 상태 일괄 조회 | 캐시와 비교해 history 대상 선정 | 개인 세션 API; 전체 방 포함 보장 없음, 누락 방 fallback |
| conversations.history (읽기) | 방 열기/검색 결과 열기/전송 후 재조회 | 최근 이력 캐시와 검색 문맥·전송 응답 재사용 | 오래된 캐시를 최신으로 표시하지 않음 |
| search.messages | 30개씩, TUI가 최대 25페이지 | 최대 100개씩 수집해 로컬 페이지로 분할; 사용자 이름 공유 | 같은 750개를 채운다면 이상적 25→8회, 결과/바이트 수에 따라 달라짐 |
| assistant.search.context (후보) | 검색과 주변 문맥 반환 | 문맥이 있으면 검색 결과 진입의 추가 읽기 절감 후보 | 최대 20개/페이지, 권한·검색 의미 차이; 일괄 대체는 오히려 호출 증가 가능 |
| chat.postMessage | 전송 1회 | 응답 message/ts를 화면에 반영 | 요청 자체는 유지; 불확실한 전송 자동 재시도 금지 |
| rtm.connect (후보) | 실시간 WebSocket 주소 | 연결 유지, message/edit/delete 및 메타데이터 이벤트 반영 | 현재 개인 세션 API 성공만 확인; 재연결·권한·실제 이벤트 검증 필요 |
| auth.test | 연결 시 계정 확인, 기존 worker 인증 | 세션/토큰별 검증 결과 공유 | 계정 바뀜·만료 시 무효화; 단순 삭제 금지 |
| conversations.open | 최초 나와의 대화 확보 | 기존 확인된 self DM ID 재사용 | 신규 self DM 확인은 필요; 목록 조회로 대체 시 비용 비교 |
| conversations.info | 연결 대상 검증, 기존 worker 읽기 후 상태 확인 | 검증된 동일 세션 목록 메타데이터 공유 | 대상 검증을 생략하지 않음 |
| conversations.replies | 기존 worker thread receipt 검증 | 검증 목적에 맞게 유지 | 일반 전송 ACK와 readback 증명은 다름 |

client.counts 실제 응답에 id, last_read, latest, updated, history_invalid,
mention_count, has_unreads가 있었다. **unread 여부만으로 변경을 판정하면 안 된다.**
다른 기기에서 읽은 새 메시지, 직접 보낸 메시지, 수정·삭제가 빠질 수 있다.
latest가 같아도 updated/history_invalid 또는 이벤트가 이력 무효화를 요구하면 다시 읽는다.
불명확한 상태와 응답 누락 방은 보수적으로 재검증한다.

현재 계정은 DM 상대 15명 중 1명이 users.list에 없다. 따라서 이름 조회는
15→2회(users.list 1 + 누락 users.info 1), 전체 목록은 **42→29회**가 목표다.
앞선 42→28회 추정은 일괄 목록의 이름 범위를 실제 DM ID와 대조하기 전의 값이며 정정한다.
client.counts에서 빠진 6개도 모두 비보관 DM이다. 보관된 방으로 간주하거나 제외하면 안 된다.
client.counts는 캐시 없는 최초 수집의 미리보기 본문을 대신하지 못한다.
정상 연결 중에는 목록/이름 캐시 + 이벤트로 조회를 줄이고,
재연결 시 counts 1회 + 바뀐/불명확한 방 K개 history + 필요한 목록/이름 갱신으로 계산한다.
이벤트 연결에도 heartbeat·재연결 비용이 있어 총 네트워크 요청이 영구히 0은 아니다.

## KakaoTalk: SDK 아래까지 포함한 호출별 판단

| API/명령 | 현재 목적·반복 | 최소화 방법 | 한계/판정 |
| --- | --- | --- | --- |
| GETCONF / CHECKIN / LOGINLIST | 새 세션마다 각 1회 | 계정별 세션 유지 | 현재 worker 요청마다 새 세션; 검색 25회면 이 3종만 최대 75회 |
| LCHATLIST | 전체 방 목록; 검색 worker마다 다시 사용 | 로그인/목록 스냅샷을 계정별 공유 | LOGINLIST가 증분이면 그것만으로 전체 목록 대체 불가 |
| CHATINFO (제목) | resolveTitles로 방마다 1회 | 사용자 지정 제목·displayMembers를 함께 캐시, 변경 시 갱신 | 처음 원래 이름을 얻는 호출을 임의 생략하면 요구 위반 |
| INFOLINK | 제목 없는 오픈채팅 fallback | SDK가 linkIds 배열 지원: 중복 제거 후 batch | 최대 batch 크기·부분 실패·응답 매핑 실측 필요 |
| MCHATLOGS | 방 하나의 다음 이력 페이지 | SDK가 chatIds/sinces 배열 지원: 여러 방 증분 batch | 현재 공개 고수준 getMessagePage는 방 하나; 다중 응답 완전성 검증 필요 |
| CHATINFO + SYNCMSG | MCHATLOGS가 비었을 때 watermark 확인과 보충 | 신뢰 가능한 최신 watermark 공유, 불필요한 재확인 감소 | 빈 결과만으로 완료 판단 불가; SDK fallback 유지 |
| MEMBER | 페이지 작성자 ID를 한 번에 조회 | 이미 받은 author_name/멤버 캐시 우선; 빠진 ID만 batch | 현재 batch는 구현됨. 방별 별명 구분 유지 |
| CHATINFO×2 + GETMEM×2 | getMembers의 안정된 멤버 스냅샷 | self 이름은 한 번 확보해 공유; 제목 조회 결과의 self 정보 재사용 검토 | 이중 읽기는 일관성 검증이므로 무조건 1회로 줄이지 않음 |
| WRITE | 실제 전송 1회 | log_id/sent_at 응답으로 화면 갱신 | 전송 재시도 금지; 별도 readback 검증 요구는 유지 |
| PING | 살아 있는 세션 heartbeat | SDK 연결 수명주기 안에서 유지 | 불필요한 polling과 구분; 삭제 대상 아님 |

### 현재 가장 큰 낭비: 읽기와 검색

- `getMessagePage`는 오래된 기록부터 앞으로 읽는다. 방을 열면 어댑터가 최대
  100페이지를 읽고 마지막 30개만 남긴다. SDK `getMessages(count:30)`로 바꾸어도
  내부에서 끝까지 읽어 마지막 일부를 반환하므로 해결되지 않는다.
- 처음 받은 이력은 암호화 저장하고 마지막 동기화 log_id 이후만 추가 수집해야 한다.
  최초 최신 30개를 직접 얻는 역방향 API는 현재 조사한 SDK에서 확인되지 않았다.
  log_id에서 숫자를 빼서 임의 시작점을 만드는 방식은 유실 위험이 있어 제외한다.
- 검색은 동일 기록을 검색어마다 다시 내려받아 클라이언트에서 필터링한다.
  한 번 수집한 기록을 로컬 인덱스로 검색하면 같은 수집 범위 재검색의 원격 요청은
  0회로 줄일 수 있다. 미수집 기록·새 변경 수집은 별도로 필요하다.
- 현재는 검색어에 맞지 않는 메시지까지 작성자 이름을 조회한다. 본문 필터 후
  결과 메시지의 누락 이름만 모아 조회하면 불필요한 MEMBER 요청을 줄인다.
- page count 30→최대 100과 원본 응답 캐시를 검토한다. 서버가 더 많이 반환했는데
  일부만 사용하고 다음 호출에서 다시 내려받는 비용도 줄일 수 있다. SYNCMSG 경로는
  현재 SDK가 80으로 제한하므로 일괄적으로 100개 반환을 가정하면 안 된다.
- 검색 결과에 도착한 페이지를 저장하면, 결과 선택 시 처음부터 해당 메시지까지
  다시 최대 100페이지를 훑는 작업을 제거할 수 있다.
- SDK의 KakaoTalkListener는 동일 client/session을 공유한다. 새 메시지·멤버 이벤트를
  목록/이력/이름 캐시에 반영하는 후보이며 누락 복구 검증이 필요하다.

## Telegram: 로컬 TDLib 호출과 서버 요청 구분

| API | 현재 사용 | 최소화 판단 |
| --- | --- | --- |
| getAuthorizationState | worker 시작 상태 확인, 대기 시 반복 | authorization update 상태 공유; 로컬 조회라 HTTP 절감으로 세지 않음 |
| loadChats | Main/Archive 각각 404까지 | 세션 유지, 로드 상태/목록 update 공유; 전체 방 완전성 유지 |
| getChats | Main/Archive 목록 ID 수집 | 목록 update 캐시로 대체 후보 |
| getChat | 방별 제목/최근 메시지, 발신 채팅 이름 | 개인 계정에서 offline; updateNewChat 및 후속 변경 캐시 활용 |
| getUser / getMe | 작성자/자신 확인 | updateUser 캐시 활용; 이름 Map의 진행 중 중복도 합침 |
| getChatHistory | 방 열기, 검색 결과 진입, 전송 후 | 이미 받은 메시지/문맥 재사용, 필요 시만 추가 수집 |
| searchMessages / searchChatMessages | 30개씩 검색 | 최대 100개 요청 가능; 반환 수는 TDLib 결정, 25→8 보장 불가 |
| sendMessage | 메시지 발송 | 1회 유지; 성공 update의 완성된 메시지를 저장하고 다시 읽지 않음 |
| getMessage | 기존 worker의 receipt readback | 신뢰 수준이 다른 검증이므로 임의 삭제 금지 |
| requestQrCodeAuthentication / checkAuthenticationPassword / checkAuthenticationCode / setAuthenticationEmailAddress / checkAuthenticationEmailCode | 최초/만료 인증 상태별 호출 | 저장된 세션 재사용. 필요한 인증 단계 자체는 생략 불가 |
| createPrivateChat | 초기 self chat 확보 | 세션에 확인된 ID 유지 |

TDLib 공식 가이드는 ID를 반환하기 전에 updateNewChat/updateUser가 도착하므로
클라이언트 캐시로 getChat/getUser 재호출을 피할 수 있다고 명시한다.
현재 port는 updateMessageSendSucceeded/Failed를 주로 처리하며 해당 메타데이터를
계정 캐시로 유지하지 않는다. Telegram 9개 방 조회는 이미 약 83ms였으므로,
오프라인 함수 호출 수보다 반복 세션 시작과 이력/검색 중복 제거를 먼저 한다.
TDLib 호출 하나를 서버 요청 하나라고 집계하지 않는다.

## 연결·기존 worker·로컬 RPC 경로

- Kakao 로그인 SDK: account/login.json, passcodeLogin/generate,
  passcodeLogin/registerDevice; 만료 갱신 후보 oauth2_token.json. 최초 인증과
  만료 시만 필요하다. `personalSession`의 평상시 재연결은 LOCO 3요청이며
  매번 휴대폰 인증 HTTP를 다시 하는 것은 아니다.
- Kakao getProfile 후보는 profile3/me.json와 more_settings.json **2요청**을
  병렬 실행한다. 이름 하나 얻으려고 그대로 호출하는 것도 최소 경로는 아니다.
  기존 MemoChat 이름과 같은 표시 의미인지 검증 후 결정한다.
- 기존 Slack read_page: auth.test + history + info가 한 묶음이다. account TUI의
  42회와 별도 경로이므로 합산하지 않는다. 반복 인증·메타데이터를 세션별 공유할 수
  있지만 계정 검증, capability 관측 시각, receipt 검증의 의미를 보존해야 한다.
- 기존 Kakao personal worker는 health/read/send/receipt마다 getChats로 범위를
  확인한다. 검증된 계정 스냅샷을 공유하되 membership 변경 시 무효화해야 한다.
- 로컬 수집 전용 Kakao 경로는 원격 LOCO와 다른 경계다. 로컬 조회를 서버 요청으로
  집계하지 않고, 연결된 reader가 getMessagePage를 부르면 그 내부만 별도 집계한다.
- TUI account.list 페이지와 system.status/sync.status/auth.status는 로컬 RPC다.
  진단은 이번 측정 약 1ms이며 강제 전체 갱신이 실제 원격 호출을 유발한다.
- 모든 계정 send 성공 뒤 TUI가 refreshChat을 호출한다. 전송 응답에 정규화된
  메시지를 포함하고 화면/캐시에 반영하면 표시 목적 재조회는 제거할 수 있다.
  사용자가 요구한 독립 readback 검증은 이와 별개로 유지한다.

## 구현 우선순위와 수용 조건

1. **응답 재사용:** 검색 원본 페이지, 전송 성공 메시지, CHATINFO의 이름을 버리지 않는다.
2. **일괄화:** Slack users.list, Kakao MEMBER 누락 ID 묶음, 검증된 MCHATLOGS/INFOLINK batch.
3. **계정별 세션과 캐시:** worker가 매번 이름·목록·로그인 상태를 버리지 않도록 한다.
4. **영속 증분 수집/검색:** 특히 Kakao의 동일 기록 반복 스캔을 없앤다.
5. **변경 알림:** Slack RTM/client.counts, Kakao listener, Telegram TDLib updates.

공통 계층에는 계정별 세션 수명주기, 중복 read 합치기, 캐시/검색 인덱스,
갱신 커서와 일관된 스냅샷을 둔다. SDK 고유 batch·이벤트 해석은 각 어댑터에 둔다.
현재 프로세스 격리와 자격증명 경계는 장기 실행 worker로도 유지할 수 있다.
전송은 read와 달리 자동 중복 합치기/재시도하지 않고 기존 request_id 규칙을 유지한다.

캐시 없는 최초 수집, 같은 상태 재실행, 메시지 1건 추가, 수정·삭제, 이름 변경,
연결 끊김/복구를 각각 검증한다. 호출 수 외에도 반환 방/메시지 ID 집합, 원래 이름,
최신순 정렬, 검색 범위, 전송 상태가 기존 의미를 보존하는지 비교해야 한다.
작은 패킷 수 감소가 큰 응답 크기·부분 누락으로 바뀌지 않는지도 확인한다.

## 참고 근거

- 현재 구현: platforms/{slack,telegram}/src/account.ts, contrib/kakao/src/account.ts,
  packages/accounts/src/worker.ts, packages/tui/src/index.ts.
- 설치 SDK 2.37.1: agent-messenger/src/platforms/kakaotalk/{client,listener}.ts,
  protocol/{session,connection}.ts, auth/*.ts 및 slack/{client,listener}.ts.
- [Slack users.list](https://docs.slack.dev/reference/methods/users.list/): 사용자 일괄 조회/페이지.
- [Slack history](https://docs.slack.dev/reference/methods/conversations.history/): 단일 방 이력.
- [Slack search.messages](https://docs.slack.dev/reference/methods/search.messages/): 최대 100개.
- [Slack assistant.search.context](https://docs.slack.dev/reference/methods/assistant.search.context/): 문맥과 최대 20개.
- [Slack rtm.connect](https://docs.slack.dev/reference/methods/rtm.connect/): 연결 API;
  현재 개인 세션 지원 판단은 공식 앱 토큰 설명이 아닌 실제 API 성공과 SDK 구현 근거.
- [TDLib 시작 가이드](https://core.telegram.org/tdlib/getting-started): update 기반 캐시.
- [TDLib getChat](https://core.telegram.org/tdlib/docs/classtd_1_1td__api_1_1get_chat.html): 개인 계정 offline.
- [TDLib searchMessages](https://core.telegram.org/tdlib/docs/classtd_1_1td__api_1_1search_messages.html): 검색 최대 100, 반환 수 보장 없음.
