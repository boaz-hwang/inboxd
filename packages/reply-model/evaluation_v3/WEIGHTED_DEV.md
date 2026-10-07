# One weighted-trial development comparison

`weighted_dev.py` reuses the frozen v4 Dev24 cases/rubrics, `independent.py`,
`multi_adapter.py`, checkpoint staging, exact saved-loss receipts and the shared
guard/daemon lifecycle. Existing helpers and runtime sources remain unchanged.

Six methods generate144 fresh outputs: `production_base_v4`,
`old152_control_v4`, and `checkpoint_1_v4` through `checkpoint_4_v4`. The last
four are the new weighted run's saved76/152/228/304 artifacts. Only those four
are eligible for selection. The old v3 step152 adapter is an immutable diagnostic
control, independent of the new152 artifact. Every method uses identical v4
messages, model/tokenizer and decoding; there is no instruction experiment here.

The compiled six-method Dev suite and selection policy can freeze before
training. The executable binding must wait for the actual approved weighted
plan/map/helper hashes, completed run and all four saved-artifact unweighted
validation losses. No prospective completion or placeholder artifact hash is
accepted. The rank rule is unchanged: fewest clear failure cases, fewest uncertain
cases, highest usefulness, highest style, lowest exact artifact validation loss,
then chronological step. The two controls cannot win selection. The lowest-loss
checkpoint is retained separately.

The later `--paths` JSON contains exactly:

- `original_suite`: the original frozen five-method v4 Dev24 suite.
- `original_rule`: its frozen v2 global selection rule.
- `old152_identity`: immutable v3 selected-adapter identity.
- `ledger`, `completion`, `model`, `worker`: actual completed weighted-run
  receipts/completion and the unchanged model/worker.
- `weighted_source_proof`: a separately verified compact-sealed metadata proof
  produced from actual completed weighted experiment artifacts.

The weighted source proof contract is `source_proof_hash` over every other field
using the independent compact JSON digest. It must bind:

- `ordinary_training_plan_hash`, `experiment_hash`, `weight_map_hash`.
- `training_complete:true`, `validation_unweighted:true`,
  `saved_steps:[76,152,228,304]`, `weighted_training_dispatches:1`,
  `unweighted_saved_validation_dispatches:4`.
- `artifact_paths` with exactly `ordinary_plan`, `weighted_experiment`,
  `weight_map`, `weighted_dispatch`, `ledger`, `completion`.
- `helper_fingerprints` with absolute weighted producer/helper paths and their
  exact SHA; `file_sha256` with all six artifacts and all weighted helper files.

The producer's own experiment/map/dispatch seals and dispatch identities must be
verified by engineer/root against the real producer contract before this proof
is frozen. That producer schema is still pending; no actual proof or executable
binding is created during generic CPU preparation. The unchanged ledger loader
uses the producer's default-spaced JSON digests, exact completion-to-ledger
file/path binding, finite adapter checks and all four actual artifact receipts.
The ordinary plan hash is passed to that loader; weighted experiment/map/helper
identity is additionally bound through the new source proof. Validation remains
unweighted on the exact46 examples. Weighted training loss is not comparable to
the old unweighted training loss.

Later authorized CPU preparation:

```sh
python "$EVAL/weighted_dev.py" prepare \
  --paths "$ACTUAL_WEIGHTED_DEV_PATHS_JSON" --output "$NEW_WEIGHTED_DEV_RUN" \
  --expected-plan-hash "$APPROVED_ORDINARY_PLAN_HASH" \
  --expected-source-proof-hash "$VERIFIED_COMPLETE_WEIGHTED_SOURCE_PROOF_HASH"
```

Preparation stages four independent checkpoint directories, preserves the old
control path, preflights the24 unique inputs shared identically by all six
methods at3904 input/192 output, and freezes the exact binding. No final paths
are accepted. Existing files/directories cannot be overwritten.

After root reviews the actual binding, the sole GPU owner may run:

```sh
python "$EVAL/weighted_dev.py" run \
  --bindings "$NEW_WEIGHTED_DEV_RUN/bindings.json" \
  --expected-binding-hash "$APPROVED_WEIGHTED_DEV_BINDING_HASH" \
  --inboxd "$VERIFIED_INBOXD_CLI" --daemon-lock "$VERIFIED_DAEMON_LOCK" \
  --daemon-binary "$VERIFIED_DAEMON_BINARY" --pause-daemon
```

Each method generates all24 cases, then releases model/cache state before the
next. Failure cleanup also clears model/cache. The shared lifecycle restores
daemon readiness after failure/signals. The prospective budget is1200 seconds,
12GiB RSS and1GiB swap growth. Estimated144-output duration is roughly319 seconds
from the previous120-output run; it is not a measurement of this trial.

CPU review commands after complete144 outputs, guard completion and restoration:

```sh
python "$EVAL/weighted_dev.py" packets \
  --bindings "$NEW_WEIGHTED_DEV_RUN/bindings.json" \
  --output "$NEW_WEIGHTED_DEV_RUN/blind-review"
python "$EVAL/weighted_dev.py" merge \
  --bindings "$NEW_WEIGHTED_DEV_RUN/bindings.json" \
  --packet-dir "$NEW_WEIGHTED_DEV_RUN/blind-review" \
  --root-judgments "$ROOT_WEIGHTED_DEV_JUDGMENTS" \
  --dataset-judgments "$DATASET_WEIGHTED_DEV_JUDGMENTS" \
  --output "$NEW_WEIGHTED_DEV_RUN/verdicts-frozen.json"
python "$EVAL/weighted_dev.py" summary \
  --bindings "$NEW_WEIGHTED_DEV_RUN/bindings.json" \
  --verdicts "$NEW_WEIGHTED_DEV_RUN/verdicts-frozen.json" \
  --summary "$NEW_WEIGHTED_DEV_RUN/summary-frozen.json" \
  --selection "$NEW_WEIGHTED_DEV_RUN/selection-frozen.json"
```

Root and dataset get12 disjoint cases each, with six randomized outputs. All144
semantic judgments, usefulness/style scores and preferences must freeze before
the first mapping read. The summary explicitly marks its structural candidate
gate/paired field unused and additionally reports every new candidate's paired
result against both controls. Selection ranks only the four new candidates.
Previous judgments remain untouched. A failure/partial attempt blocks automatic
retry or overwrite.

This is observed development evidence and cannot activate or consume final96.
Future final paths must point to the separately restored final48 grant in its
new directory, but this wrapper never reads or compiles final inputs. Final
criteria/rubrics remain unchanged. Materializing a selected adapter and binding
future final comparison are separately reviewed later steps.
