# Local history and personal adapter pipeline

The [design and implementation checklist](../../docs/27-historical-reply-training-plan.md)
is the source of truth for scope and verification. The offline pipeline combines
historical Kakao/Telegram replies with actual Inboxd response-session sends. The
online recommendation path still makes one generation call. Training never sends
messages or automatically activates an adapter.

Use the installed Python environment and runtime, for example:

```sh
~/.inboxd/reply-model/venv/bin/python ~/.inboxd/product/release/history.py --help
```

All commands below use those same paths. Models are absolute local directories;
training disables downloads and telemetry. Messenger collection uses provider
networks. The default model is `~/.inboxd/reply-model/models/Qwen3.5-9B-4bit`.

## Collect and inspect history

`history.py report` paginates owner-only `trajectory.list` exports, groups self
sends into reply turns, uses the actual tokenizer, and reports reasons and token
lengths. Kakao and Telegram are included by default; `--platform slack` is opt-in.

```sh
~/.inboxd/reply-model/venv/bin/python ~/.inboxd/product/release/history.py report
~/.inboxd/reply-model/venv/bin/python ~/.inboxd/product/release/history.py sample --sample-size 100
~/.inboxd/reply-model/venv/bin/python ~/.inboxd/product/release/history.py show --id 'hist:ID'
```

The default sequence budget remains 2048. `--max-seq-length` changes the candidate
budget; it does not prove the device can train at that size. The final trainer
also checks length. Long targets over the production generation limit of 192
content tokens are held. Neither inputs nor targets are silently shortened into
approved examples.

Automatic turn gaps are provisional: the platform p75 is capped by median plus
three median absolute deviations and a 300-second ceiling. `--gap-policy` accepts
a JSON object mapping platform names to an explicit maximum number of seconds.
The effective rule is reported and included in review hashes. Grouped messages
need human review for topic changes even when the time and reference checks pass.

Additional collection is bounded separately:

```sh
~/.inboxd/reply-model/venv/bin/python ~/.inboxd/product/release/history_collect.py plan \
  --root /absolute/private/collection --days 30 --max-rooms 1 --pages-per-room 1
~/.inboxd/reply-model/venv/bin/python ~/.inboxd/product/release/history_collect.py run \
  --root /absolute/private/collection --max-requests 1
~/.inboxd/reply-model/venv/bin/python ~/.inboxd/product/release/history_collect.py status \
  --root /absolute/private/collection
```

`--max-rooms` applies per platform. The immutable plan fixes rooms, interval and
page budget; use a new root for a new scope. The runner checks live daemon jobs and
committed checkpoints before resuming `sync.backfill`. A terminal provider page
is not a completeness guarantee. Coverage and known limits remain separate.

If a Telegram room has no capability history adapter, the runner uses the
connected account's `account.messages` read path. Every attempted read consumes
the plan's page budget, including an uncertain timeout. It follows the daemon
cursor while valid; after expiry it replays from the head and deduplicates IDs so
buffered messages are not skipped. This path stores observations but **never
claims verified coverage**, including when the provider returns `complete`.
Provider pages can straddle the requested interval; in-range and out-of-range
counts are reported, and collection stops at the lower time boundary or budget.

## Review before training

Historical candidates carry unknown read/edit/authorship evidence explicitly.
Known target mismatches, edits after the answer, deleted context, active coverage
limits, unordered messages and missing sources are hard holds. Uncertain evidence
and semantic questions require review. Unchanged model suggestions are excluded,
and exact original message IDs prevent their re-entry through historical export.
No reply and a manually composed reply are not negative labels for a suggestion.

```sh
~/.inboxd/reply-model/venv/bin/python ~/.inboxd/product/release/history.py review \
  --id 'hist:ID' --decision hold
# After reading show, acknowledge every reported reviewable warning explicitly:
~/.inboxd/reply-model/venv/bin/python ~/.inboxd/product/release/history.py review \
  --id 'hist:ID' --decision approve \
  --ack-reason authorship_unknown --ack-reason context_edit_unknown \
  --ack-reason target_edit_unknown --ack-reason coverage_unverified
```

The warning list above is an example; the actual case may require more or fewer
acknowledgements. `reject` excludes a case. Hard holds cannot be approved away.
Reviews bind to source content, prompt, grouping and filtering rules. Changes
invalidate approval. The shared state root is `~/.inboxd/reply-model/learning`.
Aggregate reports and sample manifests omit message bodies; only explicit local
`show`/`review` displays reveal inputs and targets.

## Train, validate and compare

```sh
~/.inboxd/reply-model/venv/bin/python ~/.inboxd/product/release/continual.py status
~/.inboxd/reply-model/venv/bin/python ~/.inboxd/product/release/continual.py cycle
```

Each cycle rebuilds candidates from current retained observations and approved
reviews. It trains from the base model with the approved replay set. The pilot
thresholds are 100 train / 20 validation / 20 test, with 25 new train examples;
`--min-train`, `--min-eval`, and `--min-new` configure them. Both temporal and whole
held-out-chat test evidence are required. These counts are operating defaults,
not proof of statistical adequacy. Below threshold the cycle reports
`waiting_for_reviewed_data` and runs no training.

Initial splits use independent episodes and reserve a whole chat where possible.
Canonical source keys are compact JSON strings `[platform,account,chat_id,msg_id]`
covering both context and targets. Shared sources, overlapping intervals and
explicit duplicate groups cannot cross partitions. Repeated short answers in
independent contexts are allowed. Frozen evaluation sources remain excluded on
later cycles. New independent episodes can train; newer temporal holdouts are
reserved, while old tests become `retrospective` when they no longer measure the
future. Whole held-out chats remain excluded from training.

Before approving a review sample, freeze the provisional turn-gap policy in a
JSON file such as `{"kakao":64,"telegram":115}`. Pass the same `--gap-policy` path
to `history.py` review commands and `continual.py` cycle. Without this
option, new observations can change the provisional thresholds and invalidate
old review hashes. Use the same sequence budget for review and training as well.

`--seq-length`, `--batch-size`, and `--epochs` configure training; `--iters` can
override the epoch-derived iteration count. The MLX dataset uses the same
`enable_thinking=False` template as generation through a private staged model
view. Base weights are not modified. Full and prompt-prefix tokens are compared
before running MLX; loss covers only the final answer and its termination token.
A dedicated `training_runtime.py` checkpoints Qwen3.5 recurrence and LM-head loss
in chunks of 32 tokens and computes the LM-head only at answer positions. The
static answer-token bound is measured before training; exceeding it is an error.
Gradients still pass through the full context and all four
selected LoRA layers. Its loss excludes prompt tokens and padding. It patches only
its child process; installed MLX libraries and base weights remain unchanged.
Saved checkpoints are selected using validation loss, followed by a separate
final test. Test results do not select the checkpoint.

The explicit `personalization.py` option
`--runtime-backend parallel_chunk16 --compile-mode disabled` selects the newer
Qwen3.5 training path: differentiable 16-token parallel recurrence and a frozen
28-layer prefix computed before gradient tracing, with the last four LoRA layers
remaining trainable. It preserves the full context and answer-only loss; inference
uses the original recurrence. Unsupported model layouts or training scopes fail
before training. The default remains `legacy` for existing callers. Manifests and
saved-checkpoint validation receipts record the selected backend, exact source
hashes, MLX versions and combined runtime fingerprint. The product packages both
`parallel_chunk.py` and `prefix_outside.py`.

This backend option selects algorithms, not the entire resource policy. The
successful 535-update, batch-1, 4K experiment also used `MLX_BFS_MAX_WIDTH=4` before
the child's first MLX import, a 20 GiB allocator scheduling guideline, 1 GiB cache,
zero cache-clear threshold, gradient checkpointing and normal OS pressure guards.
The guideline is not a hard allocation cap. These settings are not automatically
installed by the backend flag, and `run_local` does not forward an arbitrary
parent environment. Reproduce the complete recorded controller profile rather
than assuming the flag or exporting the environment alone reproduces its memory
use. The measured maximum padded input was 3,905 tokens, not a proof for every
4,096-token input or other batch/model configurations.

The October 4 run completed training at approximately 29.99 GB peak MLX memory
and zero additional swap. Its selected checkpoint improved some held-out real
replies but failed the frozen synthetic and real quality gates, including consent
preservation. It was not activated. See [the experiment and evaluation record](../../docs/27-historical-reply-training-plan.md#185-최종-96건-평가와-적용-결정).

Each training/evaluation subprocess has a watchdog: `--max-runtime-seconds`
(default 7200), `--max-rss-gib` (default 20), and on macOS
`--max-swap-gib` (default 4, growth since the subprocess started). The limits apply per subprocess,
including each checkpoint evaluation. RSS is observed process memory, not a
hard Metal/GPU allocation cap. Swap is measured systemwide, so other apps can
also trigger that conservative guard. Over-budget or cancelled runs terminate their
own process group and leave a failed manifest. Failed attempts are not repeated
automatically with the same model/runtime/settings/data. Resource failures also
remain blocked when only the dataset changes. Use `cycle --retry-failed` for an
explicit retry after resolving the cause; this flag is never enabled implicitly. Interrupted cycles also require an explicit retry.

The cycle produces actual A/base, B/new-adapter and C/train-only past-example
outputs, plus the active adapter if one exists. Missing examples or over-budget
cases are explicit omissions. Role, fact and abstention rubrics are independently
defined; a base model's abstention is not ground truth. A better loss is not an
automatic quality verdict.

The daily 04:00 LaunchAgent was unloaded and its installed plist deleted at the
owner's request on 2026-10-03. Do not recreate that schedule. A future step will
assess whether training is needed and run it only when warranted; that assessment
logic is **not implemented**. The current count/split checks measure readiness,
not whether retraining will improve the model. `cycle` remains an explicit
execution command and can train when its readiness checks pass; it is not a
training-need assessment command. The separately authorized 4K experiment continues.

Training needs enough local memory and compute time; it is not a cloud job.
Measure long-context and concurrent inference costs before raising the sequence
budget. The real synthetic verification harness is opt-in:

```sh
~/.inboxd/reply-model/venv/bin/python scripts/verify-history-runtime.py \
  --output /absolute/private/new-smoke --seq-length 1024 --iters 1 --full
```

Its synthetic examples prove execution and masking, not personalization quality.
It never writes the production adapter registry. See the design's verification
record for measured successes and resource-limited attempts.

## Blind output review and activation

```sh
~/.inboxd/reply-model/venv/bin/python ~/.inboxd/product/release/quality_review.py status \
  --report /absolute/private/run/blind-review.json
~/.inboxd/reply-model/venv/bin/python ~/.inboxd/product/release/quality_review.py show \
  --report /absolute/private/run/blind-review.json --id 'CASE_ID'
~/.inboxd/reply-model/venv/bin/python ~/.inboxd/product/release/quality_review.py review \
  --report /absolute/private/run/blind-review.json --id 'CASE_ID' \
  --verdict-file /absolute/private/verdict.json
~/.inboxd/reply-model/venv/bin/python ~/.inboxd/product/release/quality_review.py summary \
  --report /absolute/private/run/blind-review.json
```

The reviewer sees current, hash-verified input and anonymous outputs. Changed or
deleted source evidence is stale and cannot receive a current verdict. The verdict
file supplies every `option_N`: `role`, `fact`, and `abstain` each take `pass`,
`fail`, or `uncertain`; `usefulness` and `style` each take an integer 1–5.
`preference` is an option label, `tie`, or `none`. Method mappings and token/latency
metadata remain in a separate owner-only unblind file. The aggregate summary
requires all cases reviewed and current. Review provenance is recorded separately
from scores. The default `--reviewer human` records a human judgment. Only when
the user has explicitly delegated quality judgments, an agent may submit:

```sh
~/.inboxd/reply-model/venv/bin/python ~/.inboxd/product/release/quality_review.py review \
  --report /absolute/private/run/blind-review.json --id 'CASE_ID' \
  --verdict-file /absolute/private/verdict.json --reviewer agent_delegated \
  --authorization 'User explicitly delegated quality judgments in this session.'
```

`--authorization` must contain the actual delegation statement; it is stored with
the verdict and should contain no conversation body or credentials.
`quality_review_complete` means every current case has a valid judgment.
`human_review_complete` is true only when every judgment has explicit human
provenance. `reviewer_counts` distinguishes `human`, `agent_delegated`, and
`legacy_unknown`; older verdicts remain summarizable but are not assumed to be
human judgments. Delegated review does not imply manual adapter activation.

Only after reviewing quality and resource results, activate explicitly:

```sh
~/.inboxd/reply-model/venv/bin/python ~/.inboxd/product/release/personalization.py activate \
  --model /absolute/local/model --adapter /absolute/private/run/adapter \
  --registry /Users/YOU/.inboxd/reply-model/active-adapter.json --reviewed
~/.inboxd/reply-model/venv/bin/python ~/.inboxd/product/release/personalization.py rollback \
  --registry /Users/YOU/.inboxd/reply-model/active-adapter.json
```

`--reviewed` is an operator assertion. Activation checks completed training,
checkpoint selection and model identity; runtime checks the manifest and weight
digest. Rollback swaps active/previous, and a null active adapter selects the base.

For an explicit private JSONL export, `personalization.py inspect/train/evaluate`
remain available. Records require reviewed self targets, reliable linkage,
strictly earlier context timestamps, chat identity, canonical source keys and
exact model messages followed by the final assistant reply. Do not fabricate
records to satisfy a minimum split size.

## Explicit supplemental experiments

`training_curriculum.py` builds 32 authored synthetic training examples and eight
separate validation examples with the production prompt. They carry synthetic
provenance and explicit train/validation assignments. They are never counted as
observed user sends, real approvals or historical retrieval examples. The daily
cycle does not add these examples automatically.

The source-only `bounded_pilot.py` records and rechecks the specific pilot's
dataset, source-review, partition, runtime and held-out-suite hashes before model
execution. It can filter only training examples by total token length while
preserving the frozen real validation/test sets. It does not truncate messages.
Its optional daemon pause verifies the owner lock and executable before normal
shutdown; inner and outer cleanup restore the daemon. This is an explicit local
experiment, not a change to the daily scheduler.

`evaluation_v2/fresh_README.md` describes the independently frozen final suite.
Checkpoint selection uses validation only. Previously observed real cases and
the four operational fixtures are separate regression evidence. Once final
outputs are inspected, they must not be described as untouched evidence in a
later experiment.

Guarded runs can write `resources.json` with elapsed time, process-tree RSS and
system swap growth, without command lines, environment values or conversation
bodies. RSS does not measure all Metal allocations; system swap also includes
other applications. The pilot additionally guards comparison generation. Its
explicit resource settings do not change scheduler defaults.

## Storage and retention

Source observations stay in SQLCipher. Reviews, partition manifests and cycle
status keep IDs, hashes, decisions and counts. Training JSONL and the staged model
view use private temporary directories; ordinary completion/failure removes them,
and startup cleanup handles abandoned staging. Review outputs, adapters and logs
are owner-only filesystem files, not application-encrypted artifacts. Generated
outputs may repeat private information; retain them only as needed for review.

Deleting a source removes it from subsequent candidate rebuilds but does not
unlearn existing weights. Retrain without it and activate the new adapter, or roll
back to a version that did not learn it. Historical editing/deletion without the
original body cannot be reconstructed. A missing receipt or edit timestamp stays
unknown rather than being treated as verified human authorship or unchanged text.
