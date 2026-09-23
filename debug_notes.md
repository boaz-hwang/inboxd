# Debug Notes: Telegram connected but composer asks for connection

## Rust account backend refactor verification (2026-09-19)

- Initial full suites failed four Rust worker trust tests and two Bun launcher
  tests. New account policy/real subprocess tests passed.
- The inherited macOS temporary directory started with `/var`, a symlink to
  `/private/var`. The production trust checks correctly reject symlink ancestors;
  fixtures used the OS temporary directory and incorrectly expected it trusted.
- Changing only `TMPDIR` to an owner-only temporary directory directly under the
  current user's home made all 13 Rust worker tests and all four Bun launcher
  tests pass. No trust validation was relaxed and no system permissions changed.
- The affected trusted fixture builders now create their temporary roots under
  canonical home paths, including config and provider acceptance fixtures. The
  final full suites pass with the default environment and no `TMPDIR` override.
- Clippy also caught one nonminimal cache-expiry boolean in the new Slack Rust
  backend; simplifying it preserved behavior and the strict Clippy gate passed.
- Review additionally caught lost acknowledged receipts from post-send name
  lookups, cancelled-send cache invalidation, and provider cursor cycles hidden
  by public UUID cursors. Implementation fixes have regression tests.
- Opt-in CLI fixtures were updated to the installed `.inboxd/state/sock` layout
  with a shorter temporary prefix for macOS socket limits. Scope-worker TUI
  fixtures explicitly select their existing scope mode instead of automatically
  entering the new account workspace. Original behavioral assertions remain.
- Final verification: Bun 469 passed/0 failed (release daemon/fake-worker lanes
  enabled); default Rust workspace/all-features passed (one existing opt-in
  large performance gate ignored); strict Clippy, typecheck and boundaries passed.

## Startup performance investigation (2026-09-19)

Follow-up API audit: docs/14-api-call-audit.md. Slack users.list works but omits
one of 15 DM peers, so the directory reduction target is 42→29, not 28.
client.counts works for 20/26 rooms; the six missing rooms are non-archived DMs.
rtm.connect returned a WebSocket URL; event delivery/reconnect remain unverified.
Kakao source SDK packet trace: 54 requests for 46 rooms (3 login, 1 list,
48 CHATINFO, 2 GETMEM). Batch MCHATLOGS/INFOLINK are SDK-supported candidates;
multi-room response completeness has not yet been validated. No product edits.

- Installed TUI: first header 583ms, first chat 4,925ms in a 120x40 PTY.
- Controller: forced directory refresh 5,169–5,976ms; cached 81-room directory
  published in 3ms in a comparison harness. No production behavior changed.
- Per-provider workers: Telegram 83ms, Kakao 1,037ms, Slack 5,641ms.
- Slack trace: 1 list + 26 history + 15 users.info calls, max concurrency 3.
- Daemon stop/start/readiness including Keychain: 166ms. Diagnostics ~1ms.
- Root: unconditional startup refresh and wait-for-all account directory barrier;
  per-room Slack requests and disposable name cache multiply remote work.
- Proposed: immediate snapshot reads, per-account background refresh, encrypted
  persisted snapshots, reusable names. Preserve operation serialization, snapshot
  pagination consistency, failure state and authorization boundaries.
- Full evidence and implementation/verification plan: docs/13-startup-performance.md.
- Analysis only; no startup fix installed and no messages sent during measurement.

## Problem
The authenticated Telegram account appeared connected in Doctor, but selecting
one Telegram conversation showed a connection-required composer.

## Reproduction and evidence
A read-only protocol controller observed authenticated + text-send capability
for the current Telegram resource. `chat.list` also contained a historical
account alias with the same chat ID. The sidebar listed the historical resource
first. Selecting it refused composition with exact resource capability missing;
selecting the configured resource opened the composer normally. No send was made.

## Root cause
The workspace mixed retained history and currently configured resources without
marking their difference. The composer conflated an absent exact capability with
failed authentication. Account + chat + platform scope checks correctly refused
to borrow another account's send authority.

## Fix
Configured resources sort before historical ones. Unregistered retained history
is marked [보관], with a read-only composer and guidance to find a current chat.
Capability loading, probe errors, missing scope and actual unauthentication now
have distinct composer hints. Capability refresh retains the focused resource by
identity if sorting changes. No resources are merged and no account IDs, messages
or stored history are rewritten.

## Verification
The regression failed before the fix: historical Telegram preceded current
Telegram, and loading claimed a connection problem. Both tests pass after the fix.
All 117 TUI tests, typecheck and import-boundary checks passed. Live protocol
recheck: current Telegram appears first and can compose; historical Telegram
remains read-only with the corrected hint. The installed TUI verification checks
conversation search, draft input and cancellation without sending another message.

## Repeated Keychain password prompts during development

- Observed: installed daemon's designated requirement was a `cdhash` requirement;
  rebuilding the monolithic daemon changed that identity. Repeated replacements
  therefore invalidated the previous Keychain grant.
- Fixed: independent `inboxd-keychain` executable, stable across unrelated builds.
  Daemon reads through an owner-validated private subprocess pipe. Normal `get`
  disables Keychain interaction; explicit initialization authorizes the helper.
- No Mac password cache, database-key file, expanded all-application ACL, or
  automatic dialog retry was added. Existing key remains in Keychain.
- Tests: helper hash stability across product rebuilds; missing-item `get` exits
  without prompting; unit validation of labels and key bytes; full test suite.
- Live verification completed: helper authorization retained across three silent
  saved-key reads; two restarts succeeded. After a further daemon source change
  and rebuild, the helper's designated requirement remained identical and the
  updated daemon restarted without another password prompt.

## Account workspace live verification

- Discovered 80 provider chats: Telegram 9, Slack 26, KakaoTalk 45; no unresolved
  titles in this account set. Provider message sender names resolved in all three.
- Global search found results from all three providers; selecting a hit restored
  the exact chat and message focus. Kakao self names use its MemoChat membership
  because the provider's MEMBER query omits self.
- One new owner-TUI message per verified self chat was sent without an approval
  code and read back in Telegram, Slack and KakaoTalk. No third-party test sends.
- Bun suite: 437 passed, 13 opt-in integration cases skipped. Rust daemon/protocol/
  helper tests, typecheck, boundary checks, formatting and Clippy passed.

## Implemented API reduction and startup optimization

Priority corrected to cold API reduction before caching/concurrency. Fresh Slack
directory: 42→29 HTTP calls. Fresh Kakao directory: 54→50 LOCO calls by reusing
CHATINFO for titles/member names and eliminating a redundant self-member snapshot.
Eight fresh Kakao room pages: 8→1 MCHATLOGS; actual full page equality verified.
Kakao 46 room titles: no mismatches against the previous SDK path.

Account workers now retain sessions; background directory snapshots and concurrent
read dispatch expose completed accounts immediately. RPC pagination remains bounded
and immutable; batch responses are split by exact chat. Search hit context retains
the hit even near the beginning of a larger provider page. Explicit refresh bypasses
Kakao history caches. No sending was performed for performance measurements.

Installed TUI first chat: 4,925ms baseline → 362–2,034ms after daemon restart.
Final installation measured 2,034ms. Two existing TUIs auto-reconnect, so these
are not isolated cold-start trials; cold API counts were measured separately.
Final Bun suite: 449 pass, 13 opt-in skips. Full 81-room
refresh still takes seconds; this is first usable chat, not all-provider completion.
See docs/15-startup-optimization-results.md for measurements and remaining limits.

## 2026-09-19: Kakao self-chat send succeeded but history stayed stale

- Observation: the live TUI reported `Verified`; its room preview changed, while message history lagged. The TUI already calls `account.messages` after successful sends. This is separate from unsolicited incoming-message push updates.
- Cause: `direct_send::execute` selects an exact fixed binding before account dispatch. That worker can send and independently verify delivery, but it did not invalidate `AccountService`'s separate history/backend caches. Kakao could therefore return its complete, fresh pre-send snapshot. Account-native sends already fenced those caches. The viewport also retained its previous focus after a successful refresh.
- Reproduction: a real Bun Kakao adapter fixture first loads a complete 100-message history. Delivery through the independent send boundary introduces message 101. Without invalidation, an overlapping read restores stale cached history. The regression fails with the old behavior and passes with the shared boundary.
- Fix: fixed-worker dispatch uses the existing per-account send lock, invalidates cached state before/after dispatch, and holds a weak lifetime marker so overlapping reads cannot publish stale snapshots. Cancellation drops the marker without retaining a false in-progress state. No extra polling loop, send retry, or new cache is introduced. Successful TUI sends focus the newest refreshed message.
- Validation: workspace Rust tests, Clippy, TypeScript checks, import boundaries, all 114 TUI tests, and 70 render captures pass. Tested external-send overlap and cancellation with synthetic providers; no real test messages sent. Installed product refreshed.

## 2026-09-22: Enter did not open a selected conversation

- Reproduction: open room A (which automatically starts an empty response composer), Shift+Tab to rooms, ArrowDown to B, Enter. The active room stayed A. Enter also failed to return to A with an existing draft.
- Cause: dispatchKey treated composeActive as global editing even while rooms had focus; selectConversation independently rejected all active composers.
- Fix: route room-pane Enter separately from editor input. Resume the same room without replacing its draft/session; allow another room when the composer is empty and reset its reply target. Existing nonempty drafts and template composition remain protected with an explicit cancellation hint. Enter in the room list never sends a message.
- Validation: both new regressions failed before the fix; the TUI suite and TypeScript check pass afterward. No real messages sent.

## 2026-09-22: Phone-read Kakao rooms stayed unread in Inboxd

- Reproduction: installed daemon directory returned provider unread 0 but local unread >0 for 7 of 50 Kakao rooms. The user-selected room had provider 0 / local 1. Synthetic external-read regressions also failed before the fix.
- Cause: NOTIREAD was discarded as an invalidation hint. SDK formatting dropped LCHATLIST.s/ll. Storage took max(provider remaining, explicit local unseen) indefinitely, so fresh provider reads could not consume old explicit observations.
- Fix: read notifications trigger an authoritative directory requery without trusting peer receipt payloads. SDK directory results retain decimal-string s/ll; only the Kakao boundary exposes numeric read_through. A zero-unread directory snapshot also confirms through its own ll, since live verification found one room with n=0 and s behind its last message. Later history cannot extend that snapshot boundary.
- Persistence: existing encrypted evidence JSON retains the monotonic cursor. Unread calculations, late observation ingestion and recommendation sources exclude IDs through that cursor. Newer IDs remain unread; older directory snapshots cannot rewind the cursor. Affected queued/generated recommendations are fenced, and response.get updates source IDs without replacing a user's draft or fabricating a local-view event.
- Validation: Rust daemon/storage suite, encrypted reopen and stale-directory replay, 149 adapter/TUI tests, 160 SDK tests, TypeScript and import boundaries pass. The existing encrypted-storage test still expected schema 5; corrected its expectation to the already-current schema 6. This fix introduces no schema migration.
- Live verification uses provider directory/message reads only. It never calls mark-read, response.seen or message.send to make the counts agree. Updated the installed product and restarted its verified owner-local daemon.
- Final installed-daemon readback: the requested room is provider 0 / local 0, all 50 directory rooms expose read evidence, and provider-zero/local-unread mismatches fell from 7 to 0. A new phone interaction was not staged; verified the existing phone-read discrepancy and deterministic future-update regressions.

## 2026-09-22: Keep prepared recommendations after reading and revisiting

- User expectation: a recommendation prepared for unread messages stays visible on re-entry until a reply is sent, even after the unread badge becomes zero.
- Reproduction: prepare and complete a synthetic recommendation, record local seen (or advance provider read), close the session and open the room again. The regression returned abstained instead of the existing ready text before the fix.
- Cause: prepare returned early for an empty unseen set; the previous phone-read fix additionally invalidated recommendations when the provider cursor advanced. These incorrectly treated reading as reply completion.
- Fix: reuse queued/generating/ready recommendations with identical context, original source set and runtime; keep unread accounting separate. Successful send retires text and fences in-flight generation. A changed message context/runtime does not reuse obsolete recommendations. Text erased specifically by the old provider_read_advanced path can be recovered from its recorded ready trajectory only after the same context/runtime and unsent checks.
- Validation: local and phone read → close → reopen keeps the same text and ID; sent replies do not reappear; changed context/runtime is rejected; legacy read-only invalidation recovery passes. TUI renders the retained recommendation at unread 0 and Tab accepts it without sending. Rust daemon/storage tests, 144 TUI tests and TypeScript checks pass. No real message sent during testing.
- Installed product rebuilt and owner-local daemon restarted. Live readback still has zero provider-zero/local-unread mismatches; no ready recommendation in a read room was present during this check, so recommendation retention is verified by the regression fixtures, not claimed as a live model/UI observation.

## 2026-09-22: Hide Kakao revision-feed JSON in message display

- User reported raw logId/targetRevision JSON in the youth-leader room and requested text when present, otherwise no displayed item. Read-only inspection found metadata-only envelopes with hidden and feedType fields among normal messages.
- Fix: TUI message projection recognizes the complete Kakao revision-envelope signature. It renders a nonempty message/text/body string when available and omits bodyless feed rows. Directory titles remain available while metadata-only previews are suppressed. Normal text, ordinary JSON and other platforms remain unchanged. The target log ID is not used to infer deletion of another message; stored history is not rewritten.
- Verification: actual room response had 15 rows; display projection keeps 12 content rows and suppresses 3 internal feeds, with no targetRevision/feedType envelope left visible. Rendering regression covers the chat and inbox preview, actual text extraction, ordinary JSON preservation, and no send/seen RPC. Full TUI tests, typecheck and import boundaries pass. Installed launcher rebuilt; an already-running TUI needs to be reopened to load the display change.

## 2026-09-22: Internal Kakao feeds are not messages; entering a room reads all

- The previous fix hid revision envelopes in the TUI only. They still entered persistent history, search, response context and explicit unseen rows. The youth-leader room returned 15 records including 3 internal feeds; its provider/local unread were already 0/0 during this investigation, so a positive live badge was not reproduced.
- Added a shared narrow envelope normalizer. Kakao history/search filters internal-only entries before observation while preserving pagination cursors/completeness. Observation storage and bounded core event ingestion defend the same boundary; actual embedded text and ordinary JSON remain messages. Startup transaction repairs previously stored envelopes and their FTS/seen/unseen entries, invalidating affected recommendations. It never uses the envelope's target logId as a message deletion or read instruction.
- User clarified that entering a chat must read every message immediately. TUI now requests response.seen(all) on entry rather than waiting for every rendered line. Storage selects all retained IDs in the session's exact room, synchronizes the maximum Kakao cursor and consumes count-only unread evidence optimistically. Evidence is linked to the read operation so failure restores the previous count; new incoming unseen messages remain counted. Existing unsent recommendation retention remains independent of seen state.
- Regression coverage: hidden feeds leave real unread messages intact and cannot be reinserted or searched; all-feed pages preserve continuation; entry consumes 100 provider unread with only three retained messages, restores 100 on failure and counts a later incoming message; long offscreen messages are read without scrolling or exposing a recommendation. Core/storage/daemon tests, 146 TUI tests, typecheck, boundaries and architecture HTML checks passed.
- Installed the updated product and restarted the verified owner-local daemon. Live verification uses read-only account queries; no test message is sent and no real chat is explicitly marked read by the verification script. TUI must be reopened to load entry behavior.
- Final installed-daemon readback: youth-leader room returned 14 actual message rows and zero internal-feed rows (no TUI filtering needed). Two new provider-unread messages were present; local unread correctly matched 2. Verification deliberately left them unread, so live room-entry/mark-read was not exercised; this behavior is covered by regression tests.

## 2026-09-23: Telegram external read and recommendations independent of unread

- Root causes reproduced before edits: (1) Telegram getChat normalization discarded last_read_inbox_message_id; daemon directory validation additionally only carried Kakao cursors. Shared storage compares decimal IDs but Telegram message keys are scoped telegram:message:<chat>:<id>, so the prior read boundary could not remove explicit unseen rows. A regression with three messages and read-through 10 returned 3 instead of 1. (2) response.prepare abstained before queuing whenever unread sources were empty, even with recent history. Its read-room regression returned abstained instead of queued. The generation prompt and route also explicitly permitted no_reply/ABSTAIN, independently of whether a draft was requested.
- Direct corrections: retain Telegram's own inbox cursor (never outbox), carry it through directory validation, compare the numeric suffix inside the existing exact room scope in both SQL counting and Rust source/observe filters. Preserve monotonic evidence. No synthetic local mark-read is used for external synchronization.
- Remove unread-only eligibility for recommendations: when unread targets are empty use the latest actual context message, without inserting unseen rows. Re-entry retries cached abstained/failed generations. Policy abstention routes to contextual clarification through the existing grounding checker; rejected/empty drafts retry twice with the same conversation. No canned fallback text, no bypass of grounding. Exhausted failures remain explicit failures, not invented recommendations.
- User clarified empty rooms: TUI refreshes server history and follows empty-page continuations before preparing a recommendation. Only a successfully exhausted, empty history removes the room; failures and incomplete/cyclic/limited traversals preserve it. A changed directory preview/time lets a previously empty room appear again.
- Read-only live baseline: 10 Telegram rooms, none exposed a read cursor; all suggestion statuses were abstained. No positive live provider-zero/local-unread discrepancy was present at inspection, so the precise missed-read scenario was demonstrated by regression. Installed-daemon readback after correction exposes cursors for all 10 rooms and has zero provider-zero/local-unread mismatches.
- Validation: failing storage regressions now pass, including partial reads, stale cursor replay, late old history and genuinely new arrivals. Adapter test distinguishes inbox/outbox cursor. Python tests verify contextual regeneration, rejected drafts stay withheld, and no canned text. TUI test covers server history, all-empty history, failure and empty-page continuation. Full Rust storage/daemon suite, Python 48 tests, typecheck and boundaries pass. Real sends and response.seen are not used for verification.
- Live generation exposed an additional concrete blocker: Telegram's final retained row was the adapter placeholder [ChatDeleteMember], and the model repeatedly tried to answer that service notification. The compiler now omits that known non-utterance from reply context (records its ID as omitted; history/unread data are not deleted). Regeneration now includes the rejected draft and actual checker result, while grounding input excludes rejected drafts so failed proposals never become conversational evidence. Python regression verifies the preceding human utterance remains. Final Python suite: 49 passed; final TUI suite: 147 passed.
- Further live trace narrowed the recommendation failure: after omitting the service row, its stale target ID left the compiled prompt with no reply target, and routing every no_reply decision to clarify forced unnecessary questions about older topics. The compiler now targets the last remaining actual utterance when the original target is omitted. A no_reply decision requests a normal contextual reply; genuine uncertainty/defer requests clarification. The generator can naturally acknowledge a closing thanks without being forced to revive old topics. The regression asserts the actual remaining target ID.
- Final installed-product verification: Telegram has 10/10 own-read cursors and zero provider-zero/local-unread mismatches. The same initially failing, already-read Telegram room loaded 15 records and reached ready with nonempty model-generated text and a supported/grounded checker result, using the reply route after no_reply. No hardcoded default, real send, or local/provider mark-read was used to obtain this result. Installed launcher and owner-local daemon are updated; reopen the existing TUI for its history/empty-room changes.

## 2026-09-23: Hanwha AI-Native room stays generating then fails

- Exact target: Kakao room “한화투자증권 AI-Native 변환 프로젝트”. Prior encrypted trajectory shows status failed/draft_check_withheld, not an endless UI poll or a provider fetch failure. The generator produced the same recipient-side acknowledgement and unsupported future-call promise on all three attempts; grounding withheld all three.
- Root cause in the earlier read-room change: response.prepare fabricated an incoming source from the last context message when unread sources were empty, even when that message was authored by self. The prompt compiler also marked the latest message unseen as a fallback. This conflated “generate a next turn” with “reply to an incoming message”, causing role reversal after the owner's file-sharing message.
- Direct minimal fix: permit generation with empty incoming sources (actual context is still required), remove the fabricated storage source and compiler unseen fallback, and explicitly compile reply_mode=continue_self when the final actual speaker is self. Self-authored IDs are excluded from incoming even for legacy malformed input. continue_self instructs the model to extend the owner's already-sent message, not acknowledge it as recipient. Grounding and bounded regeneration remain enabled; no canned reply and no timeout increase.
- Regression: read-room preparation stays queued with an empty source set and unread zero; self-authored last message cannot be tagged incoming; model generation accepts read conversation context without unseen IDs. Python 51 tests and storage library 27 tests passed. Rebuilt installation and restarted the verified owner-local daemon. Verification loads the real target history and opens a local recommendation session only, without sending or marking messages read.
- Role labels alone were insufficient in live generation: the real MLX chat template received all context as one user JSON payload. Generator input now represents own turns as assistant and counterpart turns as user, then a separate drafting request. The final request identifies the latest own message and explicitly requests a continuation when the counterpart has not replied; the checker independently enforces that perspective. This fixes representation instead of suppressing grounding failures.
- During live verification, the room received two newer counterpart messages (history grew from 4 to 6), changing the target mid-generation. The newer question asks for visit logistics; the model invented a confirmed meeting and grounding correctly rejected it. Retry was previously using the same reply plan, yielding the same unsupported commitment. Rejected drafts now retry with the existing clarify strategy and an explicit non-committal information-request task. Tests assert strategy transition and retention of actual checker feedback. Final Python suite: 52 passed; storage library: 27 passed.
- Reproduction continued after each edit rather than treating status ready alone as success. A ready candidate still used recipient perspective and was rejected on manual inspection. Newer live context then caused unsupported meeting confirmations; deterministic regeneration repeated them. Final generation keeps role-aligned turns, puts the drafting/clarification instruction in a separate final natural-language request, and uses nonzero sampling only for rejected-draft retries to explore a different candidate. The same independent grounding check must approve every candidate. No generic fallback text or bypass was introduced.
- Final decisive protocol reproduction: the checker explicitly returned supported=true with a correct speaker-based explanation, but omitted reasonCode. The worker still classified that approved draft as withheld because it required the redundant literal reasonCode=grounded. Normalize missing/null diagnostic reasonCode to grounded only when supported is exactly true; contradictory rejection codes, false verdicts and malformed verdicts remain rejected. Added positive missing-code and contradictory-code regressions.
- Final verification on the installed daemon and exact Hanwha AI-Native room: queued → generating → ready, no error. The actual generated follow-up asks whether the shared file was checked; the checker explicitly approves it as the sender's question to the recipient. The once-missing grounded diagnostic label is normalized, and the draft is retained as ready. No canned fallback or real message send/mark-read was used. Python 54 tests and storage library 27 tests pass; updated product installed and owner-local daemon restarted. Re-enter the room to open the current successful recommendation session.

## 2026-09-23 — 삼성물산 44회차 내부 이벤트 재발
- 실제 `account.messages` 읽기에서 `{logId:3934384549540935683,byHost:false,hidden:true,feedType:14}` 본문을 확인했다. 이전 필터는 `targetRevision`을 필수로 요구하여 revision feed(25)만 걸렀고, revision 없는 hidden feed(14)를 메시지로 통과시켰다.
- core/TUI에서 `targetRevision` 필수 조건만 제거했다. Kakao의 숫자 feedType + logId + boolean hidden 공통 envelope로 식별하며 일반 JSON 및 다른 플랫폼 본문은 유지한다. 실제 message/text/body가 있으면 본문을 보존한다.
- 기존 공통 core 함수 적용 경로(backend history/search/preview, observation, sync ingestion, startup repair)를 그대로 사용한다. startup repair가 기존 messages/FTS/unseen을 정리하며 target logId의 실제 메시지를 삭제하거나 읽음 처리하지 않는다.
- 실제 feed14 fixture로 Rust 및 TUI의 수정 전 실패를 확인했다. feed25와 feed14 모두 backend pagination/search 필터, storage의 두 번 실행 가능한 복구 및 재수신 차단, unread 실제 메시지 보존 테스트에 포함했다.
- Rust core/daemon/storage 및 storage 통합 테스트, TUI 관련 27개 테스트, typecheck 통과.
- 추천 시간 별도 읽기: 조회 당시 방 상태 generating 1, queued 30; 최근 두 trajectory step 합계 11.019초(ready), 24.670초(failed). 대기 시간 미포함이며 queued도 TUI에서 생성 중으로 표시한다. 한 개 worker가 순차 처리한다.
- 설치본 교체 및 daemon 재시작 후 삼성물산 44회차를 실제 재조회: complete=true, 내부 JSON 0개, 로컬 logId 검색 0개. 실제 원본 target 메시지(3934384549540935683)는 보존됐고 정상 메시지 2개가 남았다. 전송/읽음 요청 없이 검증했다.

## 2026-09-23 — 추천 실패의 자동 재시도 제거
- 재현 결과 한 번의 요청이 `abstained` 또는 grounding 거절이면 Python worker가 같은 문맥으로 최대 두 번 더 초안을 생성했다. 별도로 방을 다시 열 때 storage가 동일한 failed/abstained suggestion을 queued로 되돌려, 사용자 동작이 또 다른 자동 재시도가 됐다.
- worker는 초안 생성과 grounding 검사를 각각 한 번만 실행한다. 빈 출력/ABSTAIN 및 grounding 거절은 즉시 failed가 되며, 오류 코드와 generate/check 단계, checker reasonCode가 암호화된 trajectory에 남는다. 초안이나 대화 본문을 외부 로그에 추가하지 않았다.
- 같은 context/runtime의 failed 상태는 방을 다시 열어도 유지되고 claim할 수 없다. 새 메시지나 편집, runtime 변경으로 context version이 바뀌면 새 작업으로 생성된다.
- Python 54개 테스트와 storage responses 테스트 23개가 통과했다. 실제 모델 실행, 설치, daemon 재시작은 이 변경 단위에서는 수행하지 않았다.

## 2026-09-23 — 정상 초안의 grounding 오판
- 최근 실패 trajectory 24건을 요약 조회했다. route/reason 실패는 0건이고 모든 실패의 마지막 단계가 checker였다. 첫 checker 사유는 unsupported_fact 12, role_confusion 9, unsupported_commitment 3건이었다.
- checker 입력에 실제 대화·근거뿐 아니라 생성용 instruction, response strategy, unread ID 같은 제어 메타데이터까지 `context`로 전달되어 작은 모델이 이를 대화 사실로 판정했다. 실제 발신자가 링크 확인을 부탁한 정상 초안도 수신자 역할 전환으로 거절됐다.
- checker 입력을 conversation, evidence, reply_mode와 draft로 분리했다. 발신자의 후속 확인 요청과 수신자 역할 전환, 일정 확인과 일정 확정, 통상적인 검토 의향과 근거 없는 완료 주장, 명시적 금지 유지와 약화를 각각 구분하도록 기존 검증 계약을 명확히 했다. 검증 단계 자체와 strict verdict parsing은 유지했다.
- 독립적으로 먼저 작성한 균형 fixture 8건(허용 4/거절 4)은 실제 Qwen3.5-9B checker에서 지원 여부와 reasonCode 모두 일치했다. 검토 의향/완료 주장 경계 2건도 모두 일치했다. Python 계약 테스트 54개가 통과했다.
- fresh 실제 삼성물산 44회차와 한화 AI-Native 문맥을 generation+checker로 실행했을 때 각각 첫 초안 1회로 ready/grounded였다. 이 두 실행은 route plan을 강제로 reply로 준 것이므로 전체 decision graph 검증으로 주장하지 않는다. 실제 본문은 0600 임시 파일에만 두고 로그에는 출력하지 않았다.
- 후속 경계 조건: 실패 뒤 휴대폰 읽음 또는 로컬 seen이 source ID만 바꾸면 같은 대화/runtime인데 새 context version이 만들어져 다시 queued될 수 있었다. terminal failed/abstained 조회는 저장 당시 source set으로 대화/runtime 동일성을 검증한 뒤 현재 읽음 source 변화와 무관하게 같은 실패 ID를 유지한다. 과거 `provider_read_advanced` ready-text 복구는 error를 구분해 그대로 보존한다. 새 메시지와 runtime 변경만 새 작업을 만든다. storage responses 테스트 26개 통과.

## 2026-09-23 — 전체 방 추천 생성 순서
- 기존 큐는 사용자가 연 방을 별도 priority로 올리고 activity를 무한대로 기록했다. 따라서 안 읽은 방이나 더 최근 상대 메시지가 있는 방보다 먼저 실행될 수 있었다. 128개를 넘으면 낮은 순위 작업을 `reply_queue_evicted` 실패로 끝내 전체 방 생성도 보장하지 못했다.
- 큐 순서를 `안 읽음 여부 → 마지막 실제 상대 메시지 시각 → 최초 대기 시각`으로 고정했다. 내 최신 메시지는 도착 시각으로 쓰지 않는다. 방 열기는 순서를 바꾸지 않으며, 최상위 작업의 짧은 coalescing 대기가 끝날 때까지 하위 작업을 건너뛰지 않는다. 이미 실행 중인 생성은 중단하지 않고 다음 dispatch부터 적용한다.
- 저장소 prepare 결과가 현재 unread를 함께 반환하므로 전화 등 외부 읽음 갱신 후 디렉터리 관찰이 같은 방의 큐 항목을 교체하면서 우선순위를 낮춘다. 큐는 방별로 coalesce하되 128개 이후 작업을 버리지 않는다.
- 결정적 큐 테스트에서 안 읽음 그룹 우선, 각 그룹의 최신 상대 메시지 순서, 최신 내 메시지 제외, 129개 방 보존을 검증했다. daemon worker 테스트 9개와 storage responses 테스트 23개가 통과했다. 설치와 daemon 재시작은 수행하지 않았다.
- M4 Pro 48GB 실측에서 production 모델의 생성만 2-worker 처리량은 1-worker보다 54% 높았고, 생성+검증 처리량은 21% 높았다(판단·검색·큐 대기 제외). 생성+검증의 개별 평균 시간은 동시 실행 시 11.0초에서 17.1초로 늘어나는 GPU 경합도 확인했다. 따라서 중앙 우선순위 큐는 유지하고, 실제 검증한 macOS 물리 메모리 48GB 이상에서 최대 2개 consumer를 둔다. 대기 작업이 하나면 두 번째 모델 프로세스는 시작하지 않는다. 그 외 환경 기본값은 1이며 `INBOXD_REPLY_WORKERS`로 1~2 범위에서 지정할 수 있다.
- notification permit이 합쳐져도 두 대기 consumer가 backlog를 함께 가져가는 비동기 회귀를 추가했다. 첫 dispatch가 남은 backlog를 다시 깨우며, 최종 회귀는 daemon worker 테스트 11개와 storage responses 테스트 25개가 통과했다.

## 2026-09-23 — 첫 시도 생성·실패 진단·전체 방 스케줄링
- 사용자 지시: 자동 재시도 없음, 실패 표시와 원인 기록 유지. 전체 방 생성, 안 읽은 방 우선 후 최신 수신 순. Mac 실측으로 병렬 처리 판단. 이후 추가 지시로 1초 최적화/검증 제거 계획은 보류하고 기존 판단·검증 유지 및 정확도 복구를 우선한다.
- 메인 진단: 기존 trajectory.list는 큰 모델 입력으로 반환 예산을 소진해 최신 실패 여러 건을 확인하기 어려웠다. owner-only status 필터 및 본문 제외 summary를 추가하고 회귀 테스트를 통과했다. 실패 단계/오류/검증 사유를 보존한다.
- 실제 최근 실패 24건은 모두 판단을 통과했으며 첫 검사 분류는 unsupported_fact 12, role_confusion 9, unsupported_commitment 3이었다. 모두 구버전 재시도 3회가 기록되어 있었다. 생성 오류와 정상 후속 질문을 거절한 검증 오판이 혼재한다.
- 담당 GPT-5.6-sol agent가 Python 재시도 및 방 재입장 자동 재queue를 제거하고, 동일 문맥 실패 보존과 새 문맥 작업 생성 경계를 테스트했다. 별도 agent가 중앙 우선순위 큐와 최대2개 작업자 구현을 맡고, 세번째 agent는 Mac 실측 및 독립 품질 검토를 맡았다.
- 검증 입력 계약에서 생성용 instruction/response_strategy가 실제 conversation/evidence와 한 payload에 섞여 있었다. 정상 발신자 후속 질문을 role_confusion으로 거절하거나, 모델이 추정한 user_decision gap을 실제 대화 사실로 취급한 사례를 확인했다. 검증 자체는 유지하며 입력을 분리하는 수정을 담당 agent가 실제 모델로 검증 중이다.
- 추가 지침 모순: SYSTEM 예시의 '조건을 먼저 확인해 볼게요' 및 기존 no_pretend_action 평가 기준의 '확인 후 회신 의향만 가능'은 일상적인 확인 의향을 허용하지만, checker는 모든 새 행동 약속을 금지했다. 삼성물산 실제 로그에서 '확인해 보겠습니다'까지 거절됐다. 확인 의향과 수행 완료 주장/일정·계약 확정을 구분하도록 동일 계약으로 맞추는 것이 필요하다.


## 2026-09-23 — 설치 후 문안 직접 검토
- 단순 `ready`/`supported=true`를 품질 통과로 보지 않고 실제 원문과 초안을 직접 비교했다. URL을 열지 않고 맞다고 확인한 초안, 상대가 나에게 요청한 피드백을 상대에게 다시 요구한 초안이 통과한 사례를 발견했다.
- URL 문자열과 목적지 내용 근거를 구분하고, 관련 없는 evidence가 있다는 이유로 URL 경계를 생략하지 않도록 수정했다. 대화에서 self가 이미 확인한 사실은 실제 근거로 유지한다.
- role 오류는 같은 명사/행위가 등장해도 요청자와 행동 주체가 뒤집힐 수 있는 문제다. 별도 담당자가 독립 합성 사례 6개를 사전 판정해 검증 담당자에게 전달했다. 그룹방에서 최신 other의 수신자가 항상 self라고 단정하지 않는다.
- continue_self에서 반드시 후속 질문을 만들라는 생성·검증 지침이 이미 확인한 내용을 다시 묻게 하는 원인이므로 양쪽 계약에서 질문 강제를 제거한다.
- 실제 대화는 검증 중에도 새 메시지가 들어오므로 시점별 context가 같은지 대조했다. 실제 개인 대화/초안은 저장소에 넣지 않고 권한 0600 임시 결과로 검토했다. 테스트는 메시지 전송이나 읽음 처리 없이 수행했다.

- 위 role 방향 실험은 최종 적용하지 않았다. 독립 실제 모델 6사례에서 첫 안 3/6, 최소 frame 안 2/6으로 정상 답변 오탐과 역할 반전 누락이 남았다. 해당 실험(continue_self 질문 해제/추가 self URL 예외 포함)은 전부 되돌려 최종 설치본과 worker/context_intelligence 소스가 byte-identical함을 확인했다. 질문 강제의 별도 원인과 역할 방향 문제는 미해결로 남긴다. 이것만으로 특정 새 아키텍처가 반드시 해결한다고 주장하지 않는다.
- 최종 설치·재시작 완료. Python 계약 테스트 55 통과, storage responses 26 및 daemon 110/storage 30 기존 실행 통과. 마지막 조회에서 ready 22, failed 10, queued 28, generating 2, abstained 25였다. 전체 실패 상태는 벗어났으나 전체 방 정상화/무실패를 달성한 것은 아니다. ready에도 역할 방향 오류가 있을 수 있어 자동 검사 성공을 사람 검토 완료로 취급하지 않는다.

## 2026-09-23 — 큐엠아이티 / Heeju 카카오 메시지 조회 복구
- 키보드 변경 요청은 철회되어 조작법 코드는 변경하지 않았다.
- 실제 account.messages에서 두 방이 사용하는 카카오 계정의 `채팅 목록을 먼저 불러오세요` 오류를 재현했다. 목록 캐시는 남아 있지만 갱신 실패 시 slot.failed가 메시지 조회를 차단했다.
- 설치 설정에 저장된 인증으로 SDK 목록 조회를 실행해 LOGINLIST -950 / invalid_access_token을 확인했다. 동일 계정·기기와 일치하는 저장된 refresh token으로 갱신하고, 회전된 토큰을 SDK 인증 파일과 inboxd 설정에 권한 0600으로 저장했다. 인증값은 출력하지 않았다.
- worker에서 알려진 인증 오류 코드만 안전한 재연결 안내로 변환하고, batch 및 Rust worker 경계를 거쳐 목록 오류와 메시지 조회 오류에 보존한다. 다른 provider 오류 원문은 외부에 노출하지 않는다. 인증 자동 갱신 기능을 추가한 것은 아니다.
- 검증: accounts 227 tests, typecheck, boundary 검사, Rust failed-refresh 회귀 테스트 통과. 설치본 빌드·교체와 데몬 재시작 완료.
- 재시작 후 실제 account.list에 오류 없음. account.messages에서 큐엠아이티_AX프로그램 11개 / Heeju 3개, 양쪽 complete=true, error 없음. 메시지 전송 및 읽음 요청은 하지 않았다.

## 2026-09-23 — 계정 인증 자동 복구 및 타 서비스 확인
- 카카오: 계정·기기 일치 SDK 인증 파일을 최신 토큰의 기준으로 사용한다. 기존 daemon 설정에 오래된 접근 토큰이 남아도 새 워커는 저장된 최신 토큰을 읽는다. 명시적인 invalid_access_token만 갱신하며 프로세스 공유 파일 잠금 아래 재조회→갱신→접근/갱신 토큰 atomic 저장 후 연결 교체와 조회 1회 재시도를 수행한다. push listener와 history batching도 새 연결에 연결한다.
- 갱신 거부와 갱신 후 재조회 인증 실패는 토큰 fingerprint에 묶어 기록하여 워커가 다시 시작돼도 반복 갱신하지 않는다. 카카오 일시적인 갱신 통신 실패는 60초 cooldown을 둔다. 계정 재인증으로 토큰이 바뀌면 이전 실패 기록은 적용되지 않는다. 자동 전송/파일 전송/읽음 재시도는 추가하지 않았다.
- Slack: 현재 설치 계정은 웹 세션 방식이다. 정상 조회 후 auth.test로 확인한 workspace/user/domain을 저장하고, 인증 오류 발생 시 유효한 d cookie로 제한된 Slack HTTPS redirect 경로에서 웹 토큰을 복구한다. 갱신 토큰의 workspace와 user를 다시 확인한 뒤 저장하며, 변경된 계정이나 외부 redirect는 거절한다. 일반 account worker와 fixed-binding worker가 최신 인증을 공유한다. 쿠키 자체가 해제되면 재연결 안내하며 무한 갱신하지 않는다. OAuth 앱의 refresh_token 방식으로 잘못 취급하지 않았다.
- Telegram: OAuth 접근 토큰 방식이 아닌 TDLib 저장 세션을 사용한다. TDLib 401 뒤 Ready를 확인한 읽기만 1회 재시도한다. 세션 해제/로그인 대기 상태는 connect telegram 안내로 전달한다. 전송은 재시도하지 않는다.
- 알려진 서비스별 인증 코드만 batch/IPC/Rust 오류 경계를 통과시키고 원문 provider 오류/인증값은 노출하지 않는다. 조회 실패 배너 아래 이미 불러온 메시지는 보존해 표시한다. 키보드 조작법은 변경하지 않았다.
- 검증: 관련 TS 테스트 453개, 이후 추가/보완한 auth/IPC 테스트 9개, typecheck 및 import boundary/diff 검사 통과. Rust daemon lib 110개, config 18개 통과. 독립 Bun 프로세스 3개의 카카오 갱신 경쟁에서 실제 mock 갱신 호출 1회를 확인했다.
- 설치본 빌드·교체 및 데몬 재시작 완료. 실제 목록 오류 0, Kakao 52 / Slack 26 / Telegram 10개 방. 실제 메시지 조회: 큐엠아이티 11, Heeju 3, Slack 표본 5, Telegram 표본 29, 모두 오류 없음. Slack recovery identity 저장 1계정 확인. 실제 서비스의 만료를 인위적으로 유발하지 않았으며 만료/거부/동시성은 fixture로 검증했다. 메시지 전송/읽음 요청은 수행하지 않았다.

## 2026-09-23 — 현재 실행의 추천 생성 실패 원인 재확인
- 설치된 inboxd의 owner trajectory.list를 status=failed, summary=true, limit=15로 읽기 조회했다. 최근 실패 이력 15건 모두 route/generate 완료 후 check가 supported=false를 반환한 draft_check_withheld였다. 방별 현재 실패 수가 아닌 실패 시도 이력이다.
- 사유 분포: unsupported_fact 9, role_confusion 3, unsupported_commitment 3. 근거 없는 링크 확인/수행 약속 차단과 검증 이유 자체의 오해(잘 마시시고를 완료 행동으로 해석 등)가 혼재한다. 전체 원문 대조 없이 모든 거절을 정당하거나 오탐이라고 단정하지 않는다.
- TUI는 failed를 원인 구분 없이 추천 생성 실패로 표시한다. storage는 같은 대화/runtime의 terminal failure를 유지하므로 재실행/재입장만으로 없어지지 않는다.
- 이번 확인은 진단만 수행했다. 모델 계약/검증 정책 변경, 실패 초기화, 재생성, 설치/재시작 및 메시지 전송은 수행하지 않았다.
