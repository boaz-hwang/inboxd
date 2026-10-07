# Instruction-only development diagnostic

This is one predeclared 2×2 experiment on the already observed Dev24. It uses
the unchanged v4 base and the immutable v3 step152 quality winner with the
unchanged v4 instruction or one new ordered instruction. The fixed adapter was
trained with v4; its new-instruction result tests an interaction, not a new
prompt-trained adapter. This experiment cannot reselect checkpoints or activate.

`prompt_instruction_experiment.py` changes only the last user message's content.
SYSTEM, history, turn roles, source identities and metadata remain byte-identical.
The generic order is recipient → latest self decision per topic → consent scope
→ grounded reply or missing-information request. It preserves explicit refusals,
cancellations and approvals without inferring private state. It allows useful
clarification, future checking and thanks. There are no case IDs, names, dates,
example replies, extra model calls or semantic parser.

The frozen methods are `base_v4`, `adapter152_v4`, `base_instruction_v1` and
`adapter152_instruction_v1`. All four generate all24 cases freshly:96 outputs.
Existing outputs are retained as history and are not reused in this run. Every
compiled message prefix and original request/rubric hash must match Dev24.
CPU preparation preflights every full tokenized input, including template and
generation prefix, at3904 tokens plus192 output tokens; overflow holds without
truncation or omission. Sampling remains temperature0/thinking disabled.

Use the model venv Python and the private expansion directory. The preparation
paths JSON contains exactly `original_suite`, `worker`, `selected_identity`,
`selection`, `dev_summary`, `dev_metadata`, `dev_verdicts`, `dev_bindings`, and
`dev_rule`. These refer only to Dev artifacts, the original worker and immutable
selected adapter. It contains no training examples or final paths.

```sh
python "$EVAL/prompt_diagnostic.py" prepare \
  --paths "$EXP/independent-evaluation/prompt-instruction-diagnostic-paths-v1.json" \
  --output "$EXP/prompt-instruction-diagnostic-v1"
```

Preparation verifies the completed v3 selection, fixed152 artifact SHA, original
worker, base/tokenizer/library identity and source fingerprints. The new compiled
Dev suite and binding are private/exclusive files. Root reviews the binding and
new source SHA before the sole GPU owner may launch the following command with
the exact reviewed hash and verified daemon paths. No additional user approval
is required after root authorizes that concrete command.

```sh
python "$EVAL/prompt_diagnostic.py" run \
  --bindings "$EXP/prompt-instruction-diagnostic-v1/bindings.json" \
  --expected-binding-hash "$APPROVED_DIAGNOSTIC_BINDING_HASH" \
  --inboxd "$VERIFIED_INBOXD_CLI" --daemon-lock "$VERIFIED_DAEMON_LOCK" \
  --daemon-binary "$VERIFIED_DAEMON_BINARY" --pause-daemon
```

The guarded child loads each method cleanly, generates its24 outputs, then clears
model/cache state before the next method. A final cleanup also runs on failure.
The shared lifecycle pauses the daemon and restores readiness in `finally`.
Limits are900 seconds,12GiB RSS and1GiB swap growth. Budget estimate from the
previous120-output Dev run is roughly213 seconds for96 outputs;900 seconds is
a ceiling, not a measured completion time for this variant. Attempt, partial
output or failure files block rerun/overwrite; failures hold. No deployment or
final input/socket is involved.

After successful output completeness, guard and daemon restoration:

```sh
python "$EVAL/prompt_diagnostic.py" packets \
  --bindings "$EXP/prompt-instruction-diagnostic-v1/bindings.json" \
  --output "$EXP/prompt-instruction-diagnostic-v1/blind-review"
```

Root and dataset reviewers each receive12 disjoint cases with four randomized
options and unchanged rubrics. All96 judgments must be completed and frozen
before the mapping is read. Reviewers are `agent_delegated`. Previous Dev
exposure is explicit; model names are omitted from packets. Save completed
templates to new judgment paths, then:

```sh
python "$EVAL/prompt_diagnostic.py" merge \
  --bindings "$EXP/prompt-instruction-diagnostic-v1/bindings.json" \
  --packet-dir "$EXP/prompt-instruction-diagnostic-v1/blind-review" \
  --root-judgments "$ROOT_DIAGNOSTIC_JUDGMENTS" \
  --dataset-judgments "$DATASET_DIAGNOSTIC_JUDGMENTS" \
  --output "$EXP/prompt-instruction-diagnostic-v1/verdicts-frozen.json"
python "$EVAL/prompt_diagnostic.py" summary \
  --bindings "$EXP/prompt-instruction-diagnostic-v1/bindings.json" \
  --verdicts "$EXP/prompt-instruction-diagnostic-v1/verdicts-frozen.json" \
  --output "$EXP/prompt-instruction-diagnostic-v1/summary-frozen.json"
```

The first semantic mapping read is in the summary after complete verdicts are
sealed. The summary reports all four methods and prompt effects within both
weights, plus adapter effects within both instructions. Diagnostic thresholds
are at most2 clear-error cases,0 uncertainty cases and mean usefulness at least
3.025. Style alone is insufficient. These thresholds are not activation gates;
existing final synthetic48/real48 rubrics and their distinct gates are unchanged.
No checkpoint reselection is performed. A future representation change would
need separately frozen final compilation and both production-v4 and new-prompt
base comparators before any final access; this preparation does neither.
