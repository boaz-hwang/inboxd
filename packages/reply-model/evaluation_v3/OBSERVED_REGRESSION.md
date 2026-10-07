# Observed regression execution recipe

These are three separate, already observed sets: real22, synthetic24 and
operational4. They are never added to fresh-final96 counts, denominators or gate
evidence. Compare production base with the same single global Dev24 quality
winner used for fresh final evaluation. Do not select another checkpoint or
train from regression responses. Prior-reference comparison belongs only to
the fresh-final diagnostic report.

The immutable metadata plan is
`expansion-20261003/observed-regression-readonly-plan-v1.json`, hash
`f9ca7dbc7510ef8f518586e951cb7e86ef97d7897e408f0deb6b5de314c8aae7`.
It pins the old input/rubric/source identities and helper limitations. Preserve
its original files; create a new owner-only regression output directory.

No command below is authorized during active training. First require successful
full training, all four saved-artifact loss receipts, completed and frozen
five-method Dev24 review, the one global quality selection and its immutable
selected-adapter identity. `final_controller.require_completed_selection`
can validate those development-only files and the explicit selected weight SHA
without opening any fresh final inputs. Use that quality winner even when the
loss-only winner is different.

## CPU preparation after daemon restoration

1. Verify the frozen plan hash, pinned source-file SHAs, worker identity,
   tokenizer/library identities, exact selected-adapter weights/config and all
   resolver/helper source SHAs. Do not inspect old model responses. Extract old
   source/prompt/rubric metadata programmatically, without rendering outputs.
2. Load synthetic24 with unchanged `evaluation_v2/fresh_evaluate.load_suite`;
   require suite hash `d130426feb506abfb320c2e706484d30b503ac68036d1348e5d661fdc09655e4`
   and the original24 ids/prompt hashes. Do not call its `freeze` command.
3. Build operational4 with unchanged `operational_fixtures.inputs`; require the
   plan's exact four ids/per-case prompt hashes and input-bundle hash
   `1d1a1048dfc772c24bd5a63e052fa5886bce562ed19bf4ed60dad106a631277b`.
   Preserve the operational production-SYSTEM inputs. The bare user-only four
   cases from `learning_evaluation_rubrics.json` are a different set.
4. Use the dataset agent's scoped resolver in
   `evaluation_v3/regression_inputs.py`:

   ```python
   grant = regression_inputs.build_grant(
       old_report, old_manifest, quarantine_hash, authorization)
   resolved = regression_inputs.resolve_inputs(query, grant, quarantine)
   # resolved['inputs']: original old-case id -> ready generation messages only
   # resolved['metadata']: sealed proof with an entry for EVERY original22 id
   ```

   Grant seal key is `grant_hash`; metadata proof seal key is `proof_hash`.
   Both use compact `history.digest`. Proof entries contain id/status,
   original_prompt_hash/original_source_hash/rubric_hash; ready entries also
   contain current_prompt_hash/current_raw_content_hash/current_source_keys_hash
   and current target timestamps. Original timestamp bounds and original target
   content hashes were not retained; those availability limitations are recorded
   explicitly. Historical target content is never returned as model input.

   `query` is the existing `OwnerHistoryQuery(OwnerRpc())`. Only the six exact
   already observed rooms in the grant may be requested. These rooms are
   disjoint from newly sealed final rooms. The owner currently supports roomwide
   reads: record all requested rooms/pages/candidates/omissions honestly, then
   select old target provenance in Python memory. Do not claim an original
   timestamp filter. Missing original timestamp bounds alone do not make a case
   unavailable. Exact old target identity, causal context and prompt hash must
   still be proved. Close `OwnerRpc` before daemon pause.
5. Require mandatory current49-source quarantine and shared credential screening
   before a case can be ready. Keep original and current source hashes separate;
   backfill/schema changes never justify forging an old source approval. Every
   changed, missing, omitted, sensitive or otherwise unrecoverable case must have
   an explicit unavailable reason. No masked input, substitution or resampling.
   Do not read backups as a fallback without separate root authorization.
6. Construct three input maps and fixed expected-id lists. Pass the resolver's
   all22 availability entries to `observed_regression.preflight`. It requires
   ready real inputs to equal their original/current old prompt hashes using
   `personalization.digest`'s default-spaced sorted JSON contract. Resolver grant
   and proof hashes instead use `history.digest`'s compact contract; never
   interchange these schemes. Keep resolver/hash-scope verification explicit.
7. Preflight every input before inference, with generation prefix included,
   thinking disabled and a common input cap3904 without truncation. Preserve
   synthetic output128 and real/operational output192, all temperature zero.
   The old input cap4096 is recorded as historical metadata; cap3904 is an
   explicit current comparison policy, not an input rewrite. An overflowing
   input holds the execution rather than silently disappearing.
8. The separate restored-daemon CPU window produces a sealed resolution proof
   for root's coverage/provenance review. Compute the shared
   `observed_controller.resolution_approval(proof)` and supply its `approval_hash`
   to the owner command below. This binds grant/quarantine/worker/resolver/hash
   scheme, counts and every original22 entry's input/source hashes, status and
   reason. Whole-room pages/inventory are preserved in the execution audit but
   excluded from approval identity: an unrelated new room message is allowed,
   while an original22 input/source/status change holds before generation.
   Freeze a metadata-only run binding containing original plan/grant/resolution
   hashes, all50 original ids and availability entries, ready input hashes,
   exact winner artifact SHA, current-source and quarantine provenance, library,
   tokenizer/base/worker/resolver/helper SHAs, token counts, budgets and output
   paths. The CLI is a pre-authorized combined run: root approves its scope,
   selected SHA, completed plan, resolution approval and budget in the command,
   then CPU preparation freezes the binding and automatically proceeds to the
   guarded GPU child. No additional user confirmation is needed. Root can also
   call programmatic `prepare(...)`, hold its returned binding/bundle in the
   controller's memory, inspect the exact binding, then call `execute(...)`;
   the existing memory bundle requires no second query in that flow.

After root coordinates completed development selection and the restored CPU
window, the sole GPU owner may use this command shape. Every value below is a
placeholder for an independently verified artifact or authorization, not
permission to run during active training:

```sh
python "$EVAL/observed_controller.py" run \
  --plan "$EXP/observed-regression-readonly-plan-v1.json" \
  --grant "$EXP/observed-real22-input-grant-prepared-v1.json" \
  --quarantine "$EXP/sensitive-source-quarantine-final-v14.json" \
  --selected-identity "$SELECTED_ADAPTER_DIRECTORY/selected-adapter-identity.json" \
  --selection "$FROZEN_GLOBAL_DEV_SELECTION" --dev-summary "$FROZEN_DEV_SUMMARY" \
  --dev-metadata "$FROZEN_DEV_CHECKPOINT_METADATA" --dev-verdicts "$FROZEN_COMPLETE_DEV_VERDICTS" \
  --dev-rule "$FROZEN_DEV_RULE" --dev-bindings "$APPROVED_COMPLETED_DEV_BINDINGS" \
  --expected-training-plan-hash "$APPROVED_COMPLETED_TRAINING_PLAN_HASH" \
  --expected-candidate-sha "$QUALITY_WINNER_WEIGHT_SHA256" \
  --expected-resolution-approval-hash "$APPROVED_REAL22_RESOLUTION_APPROVAL_HASH" \
  --authorization "$ROOT_OBSERVED_EXECUTION_AUTHORIZATION" \
  --output "$NEW_OBSERVED_RUN" \
  --inboxd "$VERIFIED_INBOXD_CLI" --daemon-lock "$VERIFIED_DAEMON_LOCK" \
  --daemon-binary "$VERIFIED_DAEMON_BINARY" --pause-daemon --authorize-execution
```

The prepared grant hash is
`90f30ba52d6f14c73fe9710cf4079e04b9608b8e47ec519190bc60c48e506b91`;
the known49-source quarantine hash is
`fbd4cad7c22edaedd8e04e5e8931c352fc0c4e1c75163b9f3379d6d07879d2bc`.
Changing either requires an explicit reviewed policy update, not an automatic
fallback. The binding retains all22 availability rows and exact ready-input
hashes before any model inference. The maximum is50 original cases/100 outputs;
300 seconds is an estimate, not a measurement. The execution limit is1200
seconds, RSS12 GiB and swap growth1 GiB.

Real inputs remain in parent memory or `personalization.private_staging`, never
a durable corpus file. A guarded subprocess may read an owner-only transient
input file there; include its exact content hash in the approved binding, pass
only generation messages and no historical targets, and remove staging in
`finally`. Frozen metadata and unavailable reasons can be retained separately.
Parent resolution must occur before daemon pause; a paused child cannot query
the stopped owner. The final48-only owner is unrelated and remains untouched.

## Sole-owner bounded child

`observed_controller.py` uses the same existing lifecycle as the
development/final controllers. It passes the verified daemon CLI/lock/binary and private
output directory to `bounded_pilot.daemon_pause(args)`. Inside that context call
`personalization.guarded_training_run` on the newly frozen child source:

```python
with bounded_pilot.daemon_pause(args):
    personalization.guarded_training_run(
        [model_venv_python, frozen_child_path, '--bindings', approved_bindings_path],
        env=environment, stdout=private_runtime_log, pass_fds=(),
        max_runtime_seconds=1200,
        max_rss_bytes=12 * 1024**3,
        max_swap_bytes=1024**3,
        resource_report_path=private_resource_report)
```

The selected adapter path/hash and input binding are verified again in the
child. Preflight all three sets before the first model call. Use
`observed_regression.generate_cached(engine, inputs, selected_adapter, group,
mx.clear_cache)` for each set: base handles every ready case, model/cache release
follows, then the same quality winner handles every case, with cleanup also on
exceptions. This function makes no collection or model-selection decision.

For synthetic24, pass the resulting cache to
`publish_existing_synthetic(fresh_evaluate, cache, tokenizer, selected_adapter,
new_report_path, original_suite_path)`. It reuses unchanged `generate`, whose
rubric-only calls produce exactly base/trained and no retrieval branch. It
requires all24 and complete publication. Add an exclusive metadata sidecar
classifying this as observed regression; the helper's historical `fresh_*`
field names do not make the evidence fresh. Old `fresh_gate` is not today's
activation gate.

For operational4, call
`publish_existing_operational(operational_fixtures, cache, model,
selected_adapter, new_operational_directory)`. The injected cache factory
publishes the unchanged helper's base/selected_adapter blind outputs without
loading another model. Its original192-token policy remains unchanged. Verify
all four fixed ids, eight outputs, prompt/input hashes, mapping SHA and exact
original rubrics before marking this group complete.

For real22, `observed_controller.publish_real` publishes a plain two-method observed report.
Do not invoke `learning_evaluation.compare(test=real22)` unchanged: its real-case
retrieval branch creates misleading omissions even with empty training inputs.
Use the precomputed cache to publish base/trained options for ready original ids
with case-specific randomized labels and a separate sealed mapping. Report
source kind as observed real history, with original/current source and exact
old prompt/rubric hashes, evaluation group and explicit same-input status.
Retain all22 availability entries, including unavailable cases with no outputs.
Write `expected_case_count=22`, ready/unavailable/output counts and
`complete_same_input_22 = (ready_count == 22 and output_count == 44)` explicitly.
Available-subset metrics must name their denominator and never claim a complete
22-case run. The completed publication adapter preserves original/current source
metadata separately, validates every output and retains every unavailable row.
`validate_publication` requires exact accounting and complete synthetic24 and
operational4 publication before writing the outputs receipt.

Reject existing report/mapping/attempt paths before inference; write an exclusive
attempt receipt so partial failures cannot silently be retried or overwritten.
Verify every output hash and each group's full fixed-id accounting. Completion
requires the bounded child to succeed and daemon restoration/readiness to be
verified. Failures remain holds with explicit partial/unavailable counts, never
permission to tune or change cases. Runtime logs contain counts/hashes only.

## Observed review and reporting

Reuse `fresh_evaluate.report_view`/blind verdict freezing for synthetic24 and
`quality_review.validate_verdict` for legacy role/fact/abstain and usefulness/style
judgments. Real review uses an explicit resolver over frozen ready packets,
never `quality_review._candidate_records` or an unrestricted global collector.
Operational4 uses its original independently authored rubrics. No rubric edits
after seeing new outputs. Freeze every available blind judgment before mapping
access and retain unavailable rows unjudged with reasons.

Report three separate observed tables: expected/ready/unavailable/reviewed count,
same-input coverage, semantic failures/uncertainties, usefulness/style and paired
preferences for base versus the identical quality winner. Preserve the fresh
synthetic48 and real48 summaries separately. Observed regressions can identify
problems; they are not fresh improvement evidence or a replacement for either
fresh gate. There is no additional training or checkpoint reselection step.
