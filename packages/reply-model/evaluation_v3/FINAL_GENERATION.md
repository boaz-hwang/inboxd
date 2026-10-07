# Bounded final generation

`final_controller.py` is a separate controller. Existing frozen evaluation and
training helpers remain unchanged. Its tests use fake cases, fake tokenizers
and fake inference. Do not invoke preparation or generation during training or
before root authorizes access to the sealed final inputs.

The two suites remain synthetic48 and real48. Each compares production base,
the one globally chosen development quality winner, and the exact prior adapter.
The quality winner may differ from the loss winner. The prior comparison is
diagnostic only; activation still requires the frozen base comparisons on both
suites. Synthetic criteria retain their original numeric gate plus supplemental
behavior requirement. Real evaluation uses its separately frozen real protocol.
The controller does not compute either gate or activate an adapter.

After successful training, complete and freeze every five-method Dev24 judgment,
summary and global selection. Stage the winner with `selected_adapter.py` into a
new immutable directory. Then set the following placeholders to the exact
private files and independently verified hashes for that completed run. Neither
failed training v1/v2 nor a loss-winner alias can satisfy preparation.

Use the model venv Python. `EXP` is the expansion root, `EVAL` this directory,
and `FINAL_RUN` a new private output directory. The following command is for
later authorization, not an instruction to run during training:

```sh
python "$EVAL/final_controller.py" prepare \
  --synthetic-suite "$EXP/independent-evaluation/final-compiled-v4-three-method-frozen.json" \
  --real-admission "$EXP/independent-evaluation/real-final48-admission-frozen.json" \
  --real-protocol "$EXP/independent-evaluation/new-real-holdout-protocol-frozen.json" \
  --final-grant "$EXP/review-grant-final48-only.json" \
  --comparison-policy "$EXP/independent-evaluation/three-method-comparison-policy-frozen.json" \
  --selected-identity "$SELECTED_ADAPTER_DIRECTORY/selected-adapter-identity.json" \
  --selection "$FROZEN_GLOBAL_DEV_SELECTION" \
  --dev-summary "$FROZEN_DEV_SUMMARY" --dev-metadata "$FROZEN_DEV_CHECKPOINT_METADATA" \
  --dev-verdicts "$FROZEN_COMPLETE_DEV_VERDICTS" --dev-rule "$FROZEN_DEV_RULE" \
  --dev-bindings "$APPROVED_COMPLETED_DEV_BINDINGS" \
  --expected-training-plan-hash "$APPROVED_COMPLETED_TRAINING_PLAN_HASH" \
  --expected-candidate-sha "$QUALITY_WINNER_WEIGHT_SHA256" \
  --prior-adapter "$EXACT_PRIOR_ADAPTER_DIRECTORY" \
  --expected-prior-sha "$PRIOR_WEIGHT_SHA256" \
  --worker "$EVAL/../worker.py" --output "$FINAL_RUN"
```

This CPU operation verifies complete 24-case/five-option blind development
verdicts, recomputes the global ranking, binds exact checkpoint receipts and
selected identity, and checks both adapter weights. Prior metadata must match
the same base model identity. It verifies real case rubrics by exact id plus
quality hash and source/input/target hashes. Historical targets are checked by
`final_inputs` and excluded from model input.

Preparation freezes both complete suite hashes, all adapter/source/library/base
and tokenizer bindings inherited from the verified development run, and the
complete token preflight: input <=3904 including the generation prefix, output
192, total <=4096, thinking disabled, temperature zero, no truncation. It writes
only private metadata `bindings.json`; real message bodies stay in memory.
Root must approve that exact run hash before the sole GPU owner launches:

```sh
python "$EVAL/final_controller.py" run \
  --bindings "$FINAL_RUN/bindings.json" --expected-run-hash "$APPROVED_FINAL_RUN_HASH" \
  --inboxd "$VERIFIED_INBOXD_CLI" --daemon-lock "$VERIFIED_DAEMON_LOCK" \
  --daemon-binary "$VERIFIED_DAEMON_BINARY" --pause-daemon
```

The shared daemon lifecycle surrounds the guarded child and restores/checks the
daemon on success, failure and handled signals. Limits are 1800 seconds, RSS
12 GiB and swap growth 1 GiB. The child re-verifies exact inputs and preflights
all 96 cases before inference. Each method handles one full 48-case suite, then
releases its model, garbage and MLX cache; a final cleanup runs on exceptions.
One exact selected adapter serves all candidate cases. Case-specific blind
labels are published through unchanged `multi_adapter` from in-memory output
caches, without a second inference or per-case adapter choice.

Real compiled inputs and suite bindings live only in `private_staging`, which
is removed afterward. Durable files are the two private reports and sealed
mappings, metadata completion/attempt receipts, runtime log and resource report.
Report rows contain only case ids and blind outputs. The transient real suite
contains the source-reference request and exact frozen rubric; independent
reviewers recreate that suite and retrieve original contexts from the
final48-only owner. That owner process (currently PID73132) must remain alive
through generation and review. The old review backends are not needed.

`outputs-complete.json` requires both complete 48-by-three reports, verified
case sets, output hashes and mapping-file hashes. `completion.json` is written
only after the guard succeeds and daemon readiness is restored. An existing
attempt, report, mapping or failure blocks another launch. Failures produce a
hold receipt; partial results are not complete evidence and cannot justify
activation or final-driven checkpoint reselection. There is no automatic retry.

For later independent synthetic review, existing frozen review/summarization
helpers and the frozen comparison policy apply. For real review, recreate the
deterministic real suite only in temporary private storage via `assemble_suites`
and verify its hash against the approved binding; obtain original contexts from
the owner grant. `real_gate.freeze_real` validates all48 blind judgments and
freezes them without mapping access; `real_gate.summarize_real` revalidates the
complete frozen judgments before its first mapping read and writes a sealed
real-only summary. Both require the approved run binding and frozen real
protocol. Candidate semantic failures and uncertainties must be zero, case
usefulness at least3, mean usefulness at least4 and mean style at least3.5.
The base comparison must have no usefulness regression, at least5 net paired
wins, and usefulness gain at least0.15 or reduction of at least2 failure cases.
Prior metrics are diagnostic only and add no activation requirement.
Generic synthetic `independent.summarize` is deliberately unsupported for the
real suite, so synthetic thresholds cannot silently replace the real criteria.
Mappings remain sealed until complete blind judgments have been frozen.

If both frozen final gates pass, root checks the separately reported observed
regressions and the exact evaluated weight identity before conditional deployment.
Preserve the selected adapter directory and its pre-final identity unchanged.
Stage a separate deployment directory with identical weights and adapter config,
attach the final decision evidence to its manifest, and clear its pending-review
flags only after that decision. The existing low-level `personalization.activate`
does not itself compute the combined final gates; its caller must establish them.
Verify the installed worker's loaded adapter identity and an actual new local
recommendation after activation, while retaining the prior registry state for
rollback. Generation and model activation do not authorize sending a message.
