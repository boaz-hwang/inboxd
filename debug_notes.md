# Debug Notes: Telegram connected but composer asks for connection

## 2026-10-03 — reviewed history pilot and no-activation decision

- 사용자 위임에 따라 현재 242후보를 승인 70/보류 146/제외 26으로 기록했다. 4K 분할은 28/12/22이며 원본 경계 중복 8건을 제외했다. 4K 첫 실행은 swap 증가 한도에서 중단됐다. 실제 train 최대는 2,791토큰이므로 설정값만 3K로 내려도 batch shape가 줄지 않는다는 것을 확인했다.
- 학습의 2K 초과 6건만 제외한 22/12/22 실험은 22회 update와 최종 validation·파일 저장 뒤 RSS 한도에서 종료됐다. 원래 manifest의 failed를 유지했다. 동일한 22회차/최종 체크포인트의 해시·finite parameter를 검사한 사본은 `mode=checkpoint-recovery`로 한정했고 실제 activate 호출이 거부되는 것을 확인했다.
- 오프라인 test loss는 3.528→2.970. 실제 대화 동일 22건의 익명 위임 평가에서 역할 실패 8→1(미확인 1), 사실 실패 9→0, 유용성 2.77→3.55였지만 새 역할 오류 1건도 있었다. production 입력으로 구성한 별도 합성 사례에서는 기존 거절을 발송 허용으로 뒤집는 회귀를 확인했다. 개선 신호와 적용 가능성을 구분해 운영에는 적용하지 않았다. 상세 분모·C 방식 생략 4건·평가 한계는 docs/27에 기록했다.
- 실제 실패 산출물 점검에서 개별 파일 0644/runs 부모 0755가 남는 것을 발견했다. 상위 learning 디렉터리는 0700이었지만 개별 비공개 권한 계약을 맞추기 위해 기존 5개 항목을 정리하고 자식 `umask=077`, runs 0700을 적용했다. 실패한 자식의 파일·디렉터리 권한 회귀를 포함해 Python 161개가 통과했다.
- 과거 `insufficient_evidence`와 `no_new_dataset`이 다음 cycle에도 남던 표시 오류를 수정했다. 최종 기본 2K cycle은 242후보, 길이 조건에 맞는 승인 32건, 분할 22/3/4와 temporal 0건에서 정상적으로 추가 학습을 보류했다. 모든 판단 출처는 사용자 위임으로 남기고 직접 사람 검토로 표시하지 않았다.

## 2026-10-03 — compact reply metadata and isolated evaluation examples

- 실제 224후보에서 반복 메타데이터가 평균 1,710.4토큰이었다. `reply-v4`는 메시지 ID만 입력 내부 별칭으로 바꾸고 고정 필드 배열·compact JSON을 사용한다. 발신자 원본 ID·본문·역할·절대 시각·답장 그래프·null과 false는 유지한다. 평균 전체 길이 2,947.6→1,983.7(-32.7%), 2K 길이 통과 79→124를 확인했다.
- 실제 기본 모델의 합성 7사례 v3/v4 비교에서 양쪽 모두 이전 거절을 흐리는 문제가 남았다. 압축을 개인화 정확도 개선으로 보고하지 않는다. 설치 후 정상 재시작 1.573초를 확인했다.
- A/B/C의 C 경로가 과거 예시의 턴을 현재 대화 앞에 붙여 현재 `turn_metadata` 위치를 어긋나게 할 수 있었다. 예시별 메타데이터와 전체 메시지를 별도 system 참고 영역으로 분리했다. 현재 실제 턴 순서가 변하지 않고 예시의 메타데이터가 보존되는 회귀를 추가했으며 전체 토큰 예산 검사를 유지했다. 기존 합성 A/B/C 실행은 파이프라인 실행 증거이며 품질 개선의 증거가 아니다.

## 2026-10-03 — historical adjacency linkage integration

- 실제 승인된 과거 후보 17건이 분할 전에 모두 `unreliable_linkage`로 탈락했다. Rust export의 `reply_linkage.kind=adjacent_turn`을 Python이 그대로 학습 linkage에 전달했으나 학습기는 `temporal_reply` 등 별도 어휘만 허용했다. 기존 테스트 fixture는 kind를 생략해 이 통합 오류를 발견하지 못했다.
- `history.candidate_record`에서 `adjacent_turn`을 `temporal_reply`로 정규화하고 원래 `reply_linkage` 근거는 보존한다. 인접했다는 사실만으로 승인하지 않으며 기존 검토 해시·승인, 시점과 답장 대상 일치 검사를 유지한다. 정규화로 후보 해시가 바뀌므로 기존 승인도 현재 후보에 맞게 다시 검토해야 한다.
- 실제 Rust linkage 모양의 승인 후보가 학습 준비를 통과하는 테스트와 미승인·대상 불일치·미래 맥락의 차단 회귀 테스트를 추가했다. 본문이나 실제 메시지 ID는 진단 기록에 남기지 않는다.

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

## 2026-09-23 — 사전 문맥 검증 + 단일 추천 생성
- 사용자 요청에 따라 기존 변경 전체를 576650a로 main에 먼저 커밋/푸시했다. 이후 production decision graph, retrieval/reasoning loops, post-generation LLM checker를 제거했다.
- storage는 최근 40개 발언과 최신 발언의 명시적 reply_to 원문을 같은 계정/대화방에서 최대 8개 보충한다. 원래 unread 계산은 그대로 유지한다. compiler는 ID/순서/화자/답장 원문 누락/잘림을 확인하고, 캘린더·링크/첨부 내용·오프라인 대화·미표명 의사결정을 알 수 없음을 생성 입력에 표시한다. 이는 구조적 검증이며 의미상 정보 충분성을 입증하는 모델이 아니다.
- 한 번의 로컬 생성 호출에 화자별 대화 turn과 metadata를 전달한다. 빈 응답/ABSTAIN은 abstained, 실행/출력 형식 오류는 failed다. 사후 검사는 코드의 형식 검사와 기존 context version fences뿐이다. ready는 독립 검증된 사실성을 뜻하지 않는다. 큐 순서·직접 입력 보호·명시적 수락/전송 경계를 유지한다.
- reply-v2 / single-generation-v2로 기존 실패/추천과 버전을 분리한다. 기존 worker는 evaluation-candidates/worker-legacy.py에 평가 기준으로 보존하고, product에는 현재 worker와 personalization helper만 패키징한다.
- 검증: Python 75개(legacy 포함), storage responses 33개, daemon lib 112개, TUI response 38개 통과. TS typecheck/boundary 및 설치 빌드 성공. 원문 인용 복구와 타 방 접근 차단을 회귀 검증했다.
- 실제 Qwen3.5-9B 합성 실행으로 호출 1회 확인. 프롬프트 보완 중 특정 일정 예시가 무관한 답변을 지배하는 현상을 발견해 해당 예시를 제거했다. 최종 7사례에서는 검토 의향, 일정 미확정, 기존 거절 유지, URL 정보 부족시 abstain을 관찰했지만 피드백 요청의 역할 반전과 선물 감사의 역할 반전이 남았다. 정확도 개선을 달성했다고 주장하지 않는다.
- 설치 후 실제 trajectory summary에서 새 pipeline과 generate만 있는 실행을 확인했다. 초기 설치와 재시작 사이 구 데몬/신 worker 버전 불일치 실패도 기록됐으며, 새 데몬 실행은 v2로 분리된다. 메시지 전송이나 읽음 조작은 수행하지 않았다.

## 2026-10-01 — 직접 작성한 답장의 지속 학습 파이프라인
- 기존 상태는 first_input/shown/inserted/send_outcome 기록과 수동 personalization 도구만 있었으며 자동 export/train 연결 및 활성 개인화 모델은 없었다. 사용자는 직접 입력한 데이터를 통한 개선 의도를 밝혔다.
- owner-only trajectory.list에 training_candidates 페이지 export를 추가했다. response session별 전송 최종문, 당시 문맥, 입력/수락/노출 여부를 연결하며 원래 암호화 저장소에서 읽는다. 성공확인 Sent/Verified, 직접 입력 이벤트, 유효한 과거 문맥만 후보로 삼고 미전송/불확실/그대로 수락한 모델 출력은 제외한다. 직접 입력을 기존 추천의 오답 라벨로 추정하지 않는다.
- continual.py에 status/show/review/cycle/schedule을 추가했다. 검토는 source+prompt hash에 묶고 본문 없는 review metadata만 저장한다. worker와 같은 build_generation_input으로 학습 예제를 만든다. 검토한 train100/valid20/test20 및 새 train25개가 모이면 전체 retained reviewed data로 base부터 LoRA를 학습한다. 고정 평가 partition을 유지하며 held-out chat의 새 예제를 학습에 섞지 않는다. 모델 손실과 8개 역할·사실 fixture의 base/adapter 실제 출력을 비교하고 사람 품질검토 대기에서 끝난다. 자동 활성화는 하지 않는다.
- 소스 삭제/retention 후 데이터는 다음 export/train에 사용되지 않는다. 기존 weights에서의 unlearning과 artifact 암호화는 미구현이다. 학습 2048 token 초과 예제는 정답 잘림을 피하기 위해 오류로 중단한다. 원문 카톡/텔레그램 앱에서 직접 보낸 메시지의 자동 라벨 연결은 이번 범위가 아니다.
- 실제 기록: first_input18, send_outcome3. 세 전송 모두 성공확인 조건 미충족으로 eligible0. 실제 cycle은 waiting_for_reviewed_data. 사용자가 자동 적용 질문에 답하지 않아 수동 적용 기본값을 유지했다.
- Python84, storage responses33, product artifact3(246 assertions), typecheck/boundary 통과. 합성20예제로 실제 MLX LoRA 1 iteration 및 adapter evaluation complete를 확인했으며 테스트 산출물은 임시 경로에서 정리하고 활성화하지 않았다. 패키징 테스트 초기 실패는 rustc PATH 및 manifest fixture 순서였으며 수정 후 통과했다.
- 설치 및 데몬 재시작 완료. 사용자 LaunchAgent page.boaz.inboxd.learning에 매일 로컬04:00 cycle을 등록했다. 데이터 부족시 학습하지 않고 상태만 기록한다. 추천 생성에는 별도 호출을 추가하지 않았다.

## 2026-10-02 — 과거 답장 학습의 실제 실행 검증
- 기대: owner 과거 후보 추출, 실제 tokenizer와 운영 prefix 일치, LoRA 학습·검증 체크포인트 선택·독립 평가의 실행. 실측 없는 품질 개선 주장은 하지 않는다.
- 설치본 첫 조회: Kakao 62방/809메시지/내 발신290, Telegram16방/406메시지/내 발신94. 후보216, 2048토큰 초과139, 48KB 후보초과4. 모두 출처·수정·coverage 미확인이 남아 자동승인하지 않았다.
- 실제 tokenizer에서 MLX 기본 ChatDataset prefix와 enable_thinking=False 운영 prefix 불일치를 발견했다. 임시 모델 view에 non-thinking template를 고정하고 실제 전체/마스킹 prefix 일치 검사 후 MLX에 전달하도록 수정했다. 원본 모델 파일은 수정하지 않는다.
- 자동 플랫폼 p75만으로 묶으면 Telegram 4152초 차이의 발신도 묶였다. p75를 median+3MAD 및 잠정300초로 제한하고 선택값·묶음 검토 사유·해시를 추가했다. 후속4096토큰 집계는 후보222, 초과63, 선택간격 Kakao60초/Telegram115초였다.
- 수집기의 --approver 비대화형 CLI 호출은 TTY 조건으로 실패했다. sync backfill을 기존 owner 인증 경로로 연결했다. Kakao 대표방30일/1페이지는10events/4.401초, Telegram은 capability adapter가 없어 connected account.messages fallback을 추가했다(coverage unknown, 예산·중복·cursor 만료 재개 구분). 최종 실제 fallback 검증은 진행 중이다.
- 4K 합성 train 3684/prefix3668/loss16 토큰에서 첫 gradient 단계가 장시간 실행됐고 physical footprint peak19.3G, 시스템 swap36GB 수준을 관측했다. 자원 압박으로 중단 신호를 보냈고 이후 PID 소멸과 작은 Metal 연산 정상 종료를 확인했다. 성공한 학습으로 기록하지 않는다.
- 후속1K 합성 train921/prefix905/loss16 토큰은 55.6초 후 Metal Insufficient Memory로 실패했다. 당시 validation894토큰은7.556초/손실3.603. 종료 후 메모리 여유90%가 관측되어 단순 입력 한도 축소만으로 해결됐다고 보지 않는다. 학습 경로의 메모리 원인을 조사 중이다.
- 재부팅 후 설치 데몬 재시작이 readiness timeout으로 실패했다. timeout의 키체인 안내는 원인 확정이 아니므로 별도 startup 진단을 진행한다.

- chunk checkpoint 1K 실험은 26.47초/MLX peak13.303GB로 성공했지만, padded batch의 upstream loss가 첫 padding 토큰까지 포함하는 경계 오류를 발견했다. 정답 끝 경계를 exclusive로 고치고 ChatDataset→CacheDataset→iterate_batches의 921/905→16 loss tokens를 검증했다.
- chunk checkpoint 4K+동시 추천 실험은 validation 후 첫 gradient에서 system swap이 약2.95→14.74GiB로 증가하여 122초에 중단했다. idle 추천 3회는2.309/2.310/2.311초, 학습 중5.012/2.326/2.333초였다. 학습 자식과 자손의 소멸, 임시 staging 잔여0을 확인했다. ps RSS가 당시GPU/physical memory 압박을 충분히 반영하지 못해 단독hard limit으로 취급하지 않는다.
- 재부팅 후 별도 실행한 daemon은 owner CLI status ready=true로 복구 확인했다. Telegram 지정1방30일/1페이지 probe는30건/0.984초,local_budget 종료이며 수집 완전성은unknown이다. 설치본 본문 없는100개검토표본을 준비했고 실제 승인기록은만들지않았다.

- 최종target-position gather 경로는 전체context gradient를보존한채2K/4K합성훈련성공(58.85초/21.552GB,59.98초/37.976GB). 설치본에서검증체크포인트선택/독립test/ABC6사례/격리registry적용·롤백을완료했다. 정확도개선이나사람품질판정으로해석하지않는다.
- daemon launcher readiness timeout 원인을확인: 같은reader hello+status의실제응답5회가221/233/253/255/258ms였으나probe는200ms마다연결을끊었다. STATUS_PROBE_TIMEOUT_MS를1000으로수정하고350ms정상응답을기존daemon으로인식하여중복spawn하지않는회귀4tests/typecheck통과. 전체deadline60초와경로·권한검사는유지한다.

- 수정된정상launcher경로로설치daemon재시작1.539초ready확인. 최종cycle은225후보(history224/session1)/승인0으로waiting_for_reviewed_data,실제개인화학습·운영활성화없음. 매일04:00스케줄은2K,batch1,epoch2,시간7200초/RSS20GiB/swap증가4GiB,고정턴정책64/115초. source/install학습모듈일치·staging잔여0확인. 실제100건사람검토와실데이터ABC품질판정이남은운영단계다.


## 2026-10-03 — 확장 데이터 학습의 swap 증가 조사

- 기대: 실제 학습 88건 + 합성 64건으로 304회 업데이트와 저장 가중치 4개 검증을 완료한다. 학습 2K·검증 4K, batch 1, 기존 gradient checkpoint·정답 위치 loss, RSS 28GiB·swap 증가 4GiB 한도를 적용한다.
- 실측: 첫 v1은 MLX 로더가 빈 미사용 test 파일을 읽어 업데이트 전에 실패했다. 빈 분할 파일을 생략하는 수정 및 실제 설치 로더 회귀를 포함한 검사 61개를 통과했다. 테스트 원문을 학습에 제공하지 않는 정책은 유지했다.
- v2는 1,396.677초에 training_swap_limit으로 종료됐다. 마지막 학습 기록은 90회, 최대 프로세스 RSS 19.56GiB, MLX peak 22.959GB, 시스템 swap 추가 증가 최대 4.167GiB다. 76회 가중치 SHA 193402d2a6ae95ee8f08de207459dee64dd327ba467f00da482a71f373b1b28d는 보존했다. 학습 중 검증 손실은 2.855→2.553이며 저장된 76회 가중치의 재검증 값은 아니다.
- 종료 후 실제 데몬·암호화 저장소·스키마 7 준비 상태를 확인했다. 활성 어댑터는 없다. 다른 앱의 프로세스를 종료하거나 실행 중 한도를 바꾸지 않았다.
- H1: 서로 다른 배치 길이에 대한 컴파일 흔적이 누적된다. 설치된 MLX trainer는 32단위 길이와 stateful compiled step을 쓰며, 매 단계 allocator cache는 이미 정리한다. 따라서 일반 allocator cache 정리와 컴파일 흔적의 수명을 구분한다. 같은 버전의 [공개 이슈 4464](https://github.com/ml-explore/mlx/issues/4464)에 관련 보고가 있으나 닫힘 사유와 로컬 실험을 확인하기 전 확정 원인으로 취급하지 않는다.
- H2: 긴 사례 또는 검증/학습 전환의 순간 최대 점유가 RSS·MLX 집계에 충분히 나타나지 않는다. 실제 배치 길이, active/cache/peak 메모리와 OS 지표를 함께 수집해 확인한다.
- H3: 시스템 전체 swap 변화량이 해당 학습의 지속적인 물리 메모리 부족을 과대 표시한다. swap 증가 약 2GiB 당시 free 약 16.6GiB와 memory_pressure의 여유 60%가 관측됐으나, 이것만으로 순간 압박이 없었다고 결론 내리지 않는다. 다른 대형 경쟁 프로세스는 관측되지 않았다.
- 한 번에 바꿀 후보는 전용 학습 프로세스의 compile 활성화 여부다. 예제·순서·길이·학습층·학습률·자원 한도를 동시에 바꾸지 않는다. CPU의 작은 loss/gradient 대조에서 compiled/eager 수치가 같음을 확인한 뒤, 실제 모델의 짧은 제한 실행에서 속도와 자원을 측정한다. 전체 재실행 및 원인 확정은 아직 하지 않았다.
- 진단 결과: 동일 합성 길이·순서로 기본 컴파일 36회/600.811초 시간 한도, 컴파일 해제 56회/583.218초 완료. 같은 36회의 업데이트 시간은 587.308→363.468초, 실제 모델 손실 최대 차이 약 0.009. 최대 RSS 25.335→7.311GB, MLX peak 22.957→22.622GB, swap 증가 1.611→0GB다. 작은 모델의 손실·기울기·Adam 업데이트 대조와 관련 검사 66개가 통과했다. 보고서 `compile-diagnostic-v1/summary.json` 해시는 `b1f65e1b0fa6c46cf6ff812ab9aa4e7dbf3fb6797724ce16fc41de76a7d8cb87`이다.
- 해석: 컴파일 해제는 재시도할 실측 근거가 있지만 H1의 메모리 인과는 확정하지 않았다. 순차 실행의 시작 swap은 3.285/4.896GB이며, 진단 시작 여유 메모리는 v2보다 약 14.2GB 많았다. active 메모리는 두 조건 모두 약 5.071GB로 안정적이었다. upstream 이슈의 buffer-count 한도 오류는 로컬 swap guard 종료와 다르며, [종료 설명](https://github.com/ml-explore/mlx/issues/4464#issuecomment-5595997328)도 로컬 원인 증거로 대체하지 않는다.
- 다음 조치: 같은 198개 예제·304회 업데이트·기존 자원 한도로 `compile_mode=disabled`를 명시한 별도 v3 계획을 동결한다. 실패 v2 및 76회 가중치는 보존한다. 진단 후 최신 모듈 설치·10개 소스/설치 해시 일치·격리 import·데몬 스키마 7 복구를 확인했다. 전체 완주와 독립 품질 향상은 별도 미확인 상태다.
- v3 실측 후속: 2026-10-03 19:11 KST에 학습 자식이 304회 업데이트와 저장 가중치 4개 생성을 정상 완료했다. 자식 실행 3,482.404초, 최대 RSS 7,378,223,104바이트, 시스템 swap 추가 증가 최대 0. 기존 한도를 유지한 전체 학습의 완주 증거이며, 시작 환경이 다른 v2와의 비교만으로 메모리 원인을 단정하지 않는다. 저장 가중치 4개 검증과 추천 품질 비교는 이어서 수행 중이다.
- 19:27 KST 후속: 저장된 76/152/228/304회 가중치의 검증 손실은 각각 2.546/2.445/2.464/2.471, 검증 실행 합계 925.324초, 모두 자원 한도 내 정상 완료했다. 제어 프로세스 exit 0과 실제 데몬·암호화 저장소·스키마 7 복구를 확인했다. 운영 추론 변경 없이 전용 학습의 컴파일 해제 조건에서 전체 학습·저장 검증을 완주했으며, 품질 향상 판단은 이어지는 독립 평가에 맡긴다.

## 2026-10-03 — 확장 v3 개발 품질 미달 조사

- 같은 개발 24건의 5개 모델 답장 120개를 블라인드 판정 후 동결·매핑 확인했다. 선택된 152회 모델은 의미 오류 8→4건, 역할 오류 1→0건, 말투 3.50→3.75지만 유용성은 2.875→2.667로 낮아졌다. 228/304회는 의미 오류 10/11건으로 더 나빴다. 선택·판정 산출물은 보존한다.
- H1: 실제 학습 예제의 마스킹·종료 토큰·생성 prefix 처리에 문제가 있어 일부 후보의 반복/태그 출력이 늘었다. 정확히 사용한 예제에서 CPU 토큰 경계와 종료 토큰 감독 여부를 확인한다. 아직 원인으로 확정하지 않는다.
- H2: 실제 88건 중 인사·확인 47건이라는 구성과 2K 제한으로 기존 결정 보존·구체적인 응답보다 짧은 긍정/회피를 더 학습했다. 실제 정답 토큰 기여량과 추가 3K/4K 후보 분포를 확인하고, 자원 검증 뒤 필요한 행동을 보강한다. 사례 수만 늘리거나 전체 재학습 횟수만 늘리는 것으로 해결됐다고 주장하지 않는다.
- H3: 입력에서 최신 내 결정·미정 상태를 충분히 구분하지 못한다. 선택 후보의 남은 개발 오류와 낮은 유용성 사례를 분류한 뒤, 데이터 보강 또는 공통 입력 표현 변경을 독립된 실험으로 설계한다. 사례별 정답을 코드에 넣지 않는다.
- 실제·합성 최종 48+48건은 미사용 상태로 보존한다. 개발 개선 후 사전 고정한 최종 기준으로 확인하며, 현재 어댑터는 활성화하지 않는다.
- H1 점검: 실제 사용한 198개 예제의 해시, 학습 prefix와 운영 토크나이저 경계가 모두 일치했다. 정답 뒤 종료 토큰과 줄바꿈도 전부 감독 대상이며 padding은 손실에서 빠진다. 학습 정답 토큰은 회차당 2,263개, 두 회차 4,526개로 실제 로그와 같다. 검사한 마스킹·종료 토큰 누락은 발견하지 못했다. 자유 생성 시 종료 확률은 측정하지 않아 반복 출력 원인까지 해결됐다고 판단하지 않는다.
- H2 점검: 실제 88건은 정답 토큰의 55.3%, 합성 64건은 44.7%를 차지한다. 인사·확인 47건은 전체 152건의 30.9%, 전체 정답 토큰의 21.1%다. batch 1의 사례별 평균 손실이므로 사례 비중과 토큰 비중을 구분한다. 추가 4K 구조 후보 2,710건 중 입력 3,904 한도를 적용하면 2,704건이며, 이 수는 승인 수가 아니다.
- H3 점검: 선택 후보의 남은 오류 4건은 모두 입력 621–685토큰이다. 따라서 문맥 한도 확대만으로 해결된다고 볼 근거는 없다. 기존 v4에도 결정 관련 지침이 있으므로 지침 부재를 원인으로 단정하지 않는다. 같은 개발 24건·고정 152회 가중치에 마지막 생성 지시만 바꾸는 2×2 비교를 준비했다. 최종 평가와 운영 프롬프트는 바꾸지 않았다.
- 자원 진단 `4k-resource-probe-v2`: 2K/head65는 6회/100.536초, 최대 RSS 7.334GB, swap 증가 0으로 완료했다. 이어진 4K/head65는 34.137초에 첫 업데이트 완료 전 Metal `Insufficient Memory`로 실패했다. head188 조건은 실행하지 않았고 자동 재시도·한도 상향도 없다. 실제 데몬·암호화·스키마 7 복구와 타이머 해제를 확인했다.
- 위 진단의 시작 조건 차이: 2K 시작 wired 3.74GB/free 27.92GB, 4K 시작 wired 21.74GB/free 12.28GB였다. 프로세스를 새로 시작해도 OS 메모리가 같은 상태로 돌아오지 않았다. 지연된 메모리 해제는 원인 후보일 뿐이며, 이 결과로 4K 자체가 불가능하다고 확정하지 않는다. 다음 자원 진단에는 조건 사이 메모리 안정 여부와 대기 한도를 사전에 정한다.
- H3 단일 변경 실험 완료: 마지막 지시문만 자세히 바꾼 개발 24×4 비교의 명확한 오류는 기본 모델 8→9, 고정 152회 어댑터 4→10이었다. 유용성도 각각 2.958→2.625, 2.917→2.500으로 하락했다. 모든 96개 판정을 동결한 뒤 매핑을 확인했다. 새 지시문은 채택하지 않으며, 지시가 부족해서 실패했다는 설명은 이번 변경으로 뒷받침되지 않는다. 최종 96건은 아직 생성·품질 평가에 사용하지 않았다.


### 4K 실제 자료 검수 중 확인한 입력·정답 계약 (2026-10-03)

- 승인된 길이 극단 표본의 재점검에서 의미상 근거는 있으나 운영 SYSTEM의 한두 문장 형식과 맞지 않는 장문 5개를 확인했다. 원판정은 보존하고 `fourk-dataset-expansion-v1/root-qa-admission-overlay-v1.json`으로 입장 보류를 추가했다. 정답을 잘라 승인하거나 길이 숫자만으로 제외하지 않는다. 최종 학습 최대 정답 길이는 입장 후 재산출한다.
- `worker.compile_prompt`와 `build_generation_input`에는 개별 발언의 `ts`만 있고 생성 현재 시각·날짜·시간대는 없다. 검토용 실제 정답 시각은 모델 입력 근거로 사용하면 안 된다. 대화가 오늘임을 확립하지 않은 절대 날짜를 정답에서 ‘오늘’로 변환한 사례는 보류한다. 현재 실험은 동결된 reply-v4 입력을 유지한다. 현재 시각 제공은 별도 입력 계약 개선 후보이며 이번 데이터·평가 중간에 조용히 추가하지 않는다.

- 4K 검수 기록 입장 검사에서 Luna 42행의 `hash`가 원문 `review_hash` 대신 판정 행 자체의 digest인 저장 오류를 발견했다. 42/42에서 잘못된 값의 계산식과 기존 ID·grant·input·target 연결이 정확함을 독립 확인했다. 원판정을 수정하지 않고 `preparation-v3/root-luna-binding-correction-v1.json`으로 정정하며, 이후 writer는 원천 hash를 직접 바인딩하고 행 서명을 별도 필드에 둔다. 일부 승인 경고 누락·입력 hash 오기는 별도 정정 기록으로 확인한다.
- 위 저장 오류와 별개로 일정·권한·자료 적합성 관련 승인 11건을 root/Sol이 전체 맥락으로 다시 확인했다. 8건은 앞선 본인 의사와 연결됐고, 현재 일정 가능 여부·과거 작업 방법·보이지 않는 시안 승인에 근거가 부족한 3건은 입장 보류했다. 전체 묶음을 독립 재검토했다고 표시하지 않는다.


### 2026-10-04 — 실제 4K 파일럿의 첫 업데이트 전 메모리 압력

- 최종 학습 535개(실제 471 + 합성 64), 검증 46개를 봉인했다. 전체 정답·EOS·줄바꿈 상한은 66이다. 실제 6개 전체 길이는 2,302–3,904이며 최대 입력은 3,885토큰이다. 추가 special token을 뺀 `tokenizer.vocab_size` 대신 실제 `get_vocab()` 범위 248,077로 파일럿 토큰 ID 검증 메타데이터만 정정했다. 원래 데이터·토큰·6개 grant는 불변이다.
- `actual4k-resource-pilot-v1/run-v2`는 시뮬레이터·에뮬레이터 0개, 30초 안정 창을 통과했다. 시작 free+inactive+speculative 합은 28.748GB, wired 4.136GB이며 이 합은 실제 학습 용량 보장이 아니다. GPU 프로세스 실행 18.307초에 OS pressure 2로 중단됐다. 마지막 wired 31.123GB·compressor 10.193GB, 최대 프로세스 RSS 7.572GB, swap 추가 증가 0이다. 완료 업데이트·학습 가중치·모델 개선 증거는 없다.
- 이전 3K 합성 시험에는 매 단계 후 active 약 5.07GB와 free cache 약 33.1GB가 관측됐다. peak active 약 32.86GB는 별도 최고값이다. 현재 `clear_cache_threshold=0`은 단계 완료 후 캐시를 정리하며, 첫 단계 내부의 미사용 캐시 보유는 제한하지 않는다. [MLX set_cache_limit](https://ml-explore.github.io/mlx/build/html/python/_autosummary/mlx.core.set_cache_limit.html) 및 설치 버전의 docstring을 확인했다. 다음 별도 시험은 모델 로드 전 free cache 한도만 1GiB로 설정하고 기존 데이터·계산·중단 기준을 유지한다. 활성 텐서의 최대 점유 감소나 4K 성공을 보장하는 설정은 아니다.
- 종료 후 자동 복구가 실패했다. 시작 도구는 status 요청당 1초를 기다리고 전체 60초 후 새 데몬을 종료한다. 별도 조회에서는 준비·암호화·schema7 정상 응답에 3.57초/1.09초가 걸렸다. 응답 기한에 따른 오판 가능성을 확인해 소스의 요청별 기한을 10초로 늘리고 전체 60초는 유지했다. 1.2초 정상 응답 회귀를 포함한 집중 검사 4개가 통과했다. 설치 CLI는 아직 교체하지 않았으며, 실험 복구는 같은 설치 데몬·설정·환경과 더 긴 준비 조회를 쓰는 별도 경로로 보강한다. 실패 파일럿 기록은 덮어쓰지 않는다.

- 캐시 1GiB 시험(`actual4k-resource-pilot-cache1g-v1/run-v1`)도 17.598초에 pressure 2로 중단됐다. 모델 로드 후 active 5.038GB, 첫 batch shape `[1,2305]`·정답 3토큰까지 도달했으나 업데이트는 0회다. 최대 RSS 7.657GB, 추가 swap 0. 자동 복구와 후속 schema7 확인은 성공했다.
- 다음 후보 `set_memory_limit`은 Metal allocator 구현만 보면 캐시 GC 설정처럼 보이지만, [동일 v0.32.2의 상위 graph evaluator](https://github.com/ml-explore/mlx/blob/v0.32.2/mlx/transforms.cpp)는 active memory가 한도를 넘고 실행 중 task가 있으면 streams를 finalize하고 `scheduler::wait_for_one()`을 호출한다. 전체 참조를 확인하지 않은 초기 조사 결론은 정정했다. 20GiB 설정은 계산을 유지하며 비동기 작업의 메모리 중첩을 줄일 후보지만, 단일 연산·필수 live buffer를 강제로 줄이는 hard cap은 아니다.
- 작업 없는 Gradle 8.14.3 데몬 PID52935 하나만 `--status`로 IDLE 확인 후 정상 `--stop`했다. 종료 전 footprint 표시는 2.5G이며 이만큼의 물리 RAM이 회수됐다고 주장하지 않는다. 사용자 전면 앱은 종료하지 않았다. macOS disk buffer purge는 권한 오류로 실행되지 않았고 재시도하지 않았다. 다음 시험에는 이 OS 시작 조건 변화도 기록하며, 개선을 allocator 한도 변경만의 인과로 단정하지 않는다.


### 2026-10-04: actual 4K resource blocker after cleanup

Simulator/Android emulator devices and UI were verified stopped; four obsolete review RAM owners and one independently verified idle Gradle daemon were stopped. Final admission remains 535 train / 46 validation records. GPU trials have not established actual 4K memory feasibility and full training has not started.

Frozen-prefix materialization inside differentiation failed before its first update. Moving prefix work outside differentiation preserved the original loss and passed two CPU updates plus intervening evaluation with full 62-gradient and Adam parity, but the first three actual MLX peaks were unchanged. Both this trial and the separately frozen bounded-warning diagnostic completed four updates through padded length 3137 and stopped during the next long record.

The final bounded-warning diagnostic (plan dfea59be061f8f4cf4fd6deb6979cdb929f0be436f879e96df8a51f6f6679558) observed raw final pressure 4, wired 41218228224 bytes, reclaimable proxy 1641627648 bytes, and swap growth 1313142211 bytes. The normal-only trial was not retrospectively relabeled. The monitor's last-good pressure field is stale when validation raises; the conclusion correctly uses resources.samples[-1].pressure_level. This is a critical-pressure guard stop, not evidence of an observed Metal OOM.

### 2026-10-04 — exact chunk VJP: CPU parity passed, first actual pilot failed

The user explicitly requested resolving the underlying memory issue and continuing through training. A process-local custom recurrence VJP copies evaluated chunk values into independent leaf buffers and propagates the final-state cotangent through every preceding chunk. Helper SHA `5cee017acac1757c93b872a4bee8e58e2a2f624aaa9747e4214e5349fe48cad1` passed separate CPU recurrence checks and the original answer-only loss with all 62 LoRA gradients, two persistent Adam updates, and intervening validation. The remaining CPU gradient graph shrank, but this was not proof of GPU peak memory.

The actual same-six/18-update normal-pressure pilot (`actual4k-resource-pilot-boundedvjp-v1/run-v1`, plan `7cb80a43c71f0119c710e73bb4c5306a4035caf8c67ca967428c092e2ad7d248`) stopped after 22.989 seconds before completing the first update. Initial wired/proxy were 3.995/32.006GB; the final observed pressure was 2, wired 39.055GB, proxy 2.245GB, peak RSS 7.095GB, and additional swap 0.272GB. The phase within the first update has not yet been localized. This result does not establish a memory improvement. Daemon restoration and encrypted schema 7 readiness passed. No full training or adapter activation occurred. Preserve this failure and inspect phase-local allocation before another actual-data run.

The prefix observer measured the first frozen-prefix peak at 5764891944 bytes and first full-step peak at 25080535380 bytes; the large additional peak occurred after prefix preparation. Counters are cumulative, not independent per-stage peaks. No adapter remains. Automatic daemon restoration and independent schema 7 readiness passed. No further GPU trials or speculative CPU optimization until external memory headroom changes; then retest the original normal-only policy.

## 2026-10-04: 4K memory fix and final training/evaluation closure

The complete 535-update run succeeded with the fixed C16 parallel gated-delta recurrence and frozen-prefix computation outside gradient tracing. Full-context gradients were preserved. Peak MLX memory was 29.987 GB, incremental swap was zero, and all 1,377 pressure samples across training/checkpoint evaluation were normal. This required the complete recorded allocator/BFS/cache/guard profile; the new backend option alone is not a 30 GB guarantee.

Saved checkpoint 268 was selected by the frozen development quality rule, rather than the lowest-loss 535 checkpoint. All 96 fresh final cases and 288 outputs were judged before unblinding. Real clear semantic failure cases fell from 25/48 to 12/48, but synthetic usefulness declined from 2.8125 to 2.6875 and consent failures rose from 8 to 10. Both final gates reject; an observed explicit-refusal reversal also remains. Production stays on the base model with no active adapter. The former real22 reproduction gap remains disclosed.

Only after final summaries were frozen, the validated helpers were integrated into runtime v5 with explicit parallel_chunk16 opt-in. Related tests: 71 pass, including the real tiny CPU installer/prefix/62-gradient/Adam2/mid-evaluation path. Four training modules were backed up, installed, and imported in isolation. Actual full-9B training used the preintegration sealed controller; the new packaged installer was not subjected to a second full training run. Both owned corpus RAM servers shut down gracefully, their sockets and review staging were removed, and daemon/encryption schema7 readiness was confirmed. Daily04:00 schedule remains deleted. Full evidence and limitations: docs/27-historical-reply-training-plan.md, sections18.3–18.6.
