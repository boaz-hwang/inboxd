# Post-training development evaluation

This controller never selects from final cases or activates an adapter. It is
prepared on CPU; only the designated GPU owner may explicitly run generation
after the exact approved training plan has completed and daemon restoration has
been independently verified. No package installs are needed.

Use the model venv Python. Set `EXP` to the private expansion directory, `EVAL`
to this source directory, and `MODEL` to the approved base model directory.
`COMPLETED_TRAINING_RUN` and `APPROVED_TRAINING_PLAN_HASH` below are explicit
placeholders for a future successfully completed, root-approved run and its
exact frozen plan hash. No full retry v3 plan exists yet. Training v1 and v2
failed and cannot supply development bindings; partial checkpoints from those
runs do not satisfy this protocol. Set `DEV_RUN` to a new private output
directory for that completed run. Do not execute these examples until these
values and the completed run have been independently verified.

```sh
python "$EVAL/checkpoint_dev.py" prepare-ledger \
  --suite "$EXP/independent-evaluation/dev-compiled-v4-checkpoint-selection-v2-frozen.json" \
  --checkpoint-ledger "$COMPLETED_TRAINING_RUN/run/adapter/checkpoint-validation.json" \
  --training-completion "$COMPLETED_TRAINING_RUN/run/completion.json" \
  --expected-training-plan-hash "$APPROVED_TRAINING_PLAN_HASH" \
  --model "$MODEL" --worker "$EVAL/../worker.py" \
  --output "$DEV_RUN"
```

Preparation verifies the completion's exact ledger path and file SHA, the
producer's default-spaced JSON digest for ledger and individual loss receipts,
four unique positive steps, saved weight identity, finite weights and losses,
validation identities and resource completion. It stages four independent
checkpoint directories, so the overwritten loss-winner alias is never assumed
to identify a saved checkpoint. The independent bindings still use the frozen
compact JSON hash protocol. Preparation prints only the binding hash and counts.

The binding freezes worker, base weights, tokenizer, library versions, evaluator
sources, shared daemon lifecycle sources, decoding, adapters and exact losses.
Root reviews that binding before the GPU owner explicitly starts this command;
use the exact daemon CLI, lock and binary paths already verified by that owner:

```sh
python "$EVAL/checkpoint_dev.py" run \
  --suite "$EXP/independent-evaluation/dev-compiled-v4-checkpoint-selection-v2-frozen.json" \
  --bindings "$DEV_RUN/bindings.json" \
  --expected-binding-hash "$APPROVED_DEV_BINDING_HASH" \
  --report "$DEV_RUN/report.json" \
  --inboxd "$VERIFIED_INBOXD_CLI" --daemon-lock "$VERIFIED_DAEMON_LOCK" \
  --daemon-binary "$VERIFIED_DAEMON_BINARY" --pause-daemon
```

The guarded child prechecks all inputs before inference, generates 24 cases for
each of five methods (base plus four checkpoints), then publishes case-specific
blind labels from a cache without a second inference. Models, garbage and MLX
cache are cleared between methods. The guard limits runtime to 900 seconds,
RSS to 12 GiB and swap growth to 1 GiB. Existing reports cannot be overwritten.
The shared lifecycle restores and checks the daemon even after failure/signals.

CPU review sequence, using the functions in these files:

1. `development_review.prepare_packets(suite, report, new_packet_directory)`
   gives `/root` and `/root/dataset_expansion` disjoint 12-case packets containing
   all five blind options. Neither packet contains the mapping. This development
   baseline was previously observed and is explicitly labelled as such.
2. Both reviewers complete every option's role/fact/consent/response judgment,
   usefulness/style 1–5, reason and tied preference tiers. Save their private
   templates as new judgment files; do not read `report-unblind.json`.
3. `development_review.merge_and_freeze(...)` validates and freezes all 24 cases.
   `freeze_summary_after_review(...)` is the first mapping read and writes a
   sealed development summary. Its placeholder candidate gate is ignored.
4. `development_selection.select_checkpoint(summary, checkpoint_metadata,
   frozen_rule)` ranks all four complete candidates using the frozen global
   rule: semantic-failure cases, uncertain cases, usefulness, style, exact saved
   artifact loss, then chronological step. Save its returned sealed selection
   via `independent.write_private`. Preserve the loss-only winner separately.
5. `selected_adapter.stage_selected(selection, bindings, new_selected_directory)`
   creates an immutable identity for the one global winner, with exact weight
   SHA and criterion. It still requires final evaluation and cannot activate.

Final generation is a separate, later-authorized operation. Its methods are
production base, this selected adapter, and the prior adapter as a diagnostic
only. The existing base-only meaningful improvement gate is unchanged for both
48-case sealed suites. Final outputs cannot influence checkpoint selection.

Only `review-grant-final48-only.json` serves the exact real48 original inputs.
`final_inputs.fetch_inputs` verifies source/raw/input/target hashes and returns
`messages[:-1]` in memory; historical targets never enter model input. The old
training/validation/review backends were retired. The final-only CPU owner
remains required through final generation and independent review.

The full actual-use input-only duplicate audit completed after daemon restoration.
All 198 training/validation example hashes matched the frozen dataset manifest:
train152 = real88 + authored64; valid46 = real30 + authored16. The two sealed
final suites contain synthetic48 and real48. The audit covered 26,000
train-versus-validation/final boundary pairs plus 2,304 synthetic-final versus
real-final diagnostic pairs, for 28,304 comparisons. Normalized role/body exact,
long-context near, shared long-message and full-input identity flags were all zero.
SYSTEM text, the shared reply instruction and gold targets were excluded from
input-only comparison; this evidence is separate from the real context-plus-gold
target audit and does not claim exhaustive semantic paraphrase detection.

The private `full-used-input-audit-frozen.json` audit hash is
`b33c5ac6bd9e59d037d700deb030575989c2787a885f763b85e5e2afd983d4e7`.
Its preserved supplemental evidence,
`post-training-cpu-full-audit-supplement-frozen.json`, has hash
`78f3200c2a2c0aaebf60bc4ac982b1ffff5d4bc39a047c306e67f0b927e6c5ef`.
These proofs cover the exact audited dataset; a retry that changes used examples
requires updated duplicate evidence. Context flags require full-input/actor
metadata identity checks and an explicit diagnostic reason; they never silently
remove or replace a frozen case. No corpus bodies, targets or model outputs are
included in metadata-only audit reports.
