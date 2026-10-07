# Fresh operational synthetic evaluation (2026-10-03)

This independent suite contains 24 wholly invented Korean messenger situations. It was authored without reading supplemental training examples, compiled with the production `reply-v4` `compile_prompt` and `build_generation_input`, and frozen before the new training run. The snapshot includes each structured request, exact generation messages, semantic rubric, hashes, provenance, and acceptance policy. It contains no real conversation bodies or target reply strings. Do not train on these cases, tune against their outputs, or quietly revise the frozen set. Previously observed real22/old4 results remain separate regression evidence.

The corpus covers six role cases, five refusal cases (including valid later self authorization), four grounded approval/completion cases, seven unknown-information cases, and two reasonable inquiry/social-response cases. Both DM and group contexts include distractors and explicit references, with known/unseen, read, and unknown reading states. Uncertainty judgments are allowed and are recorded separately from failures. Their unresolved presence prevents a passing acceptance gate; it does not get relabeled as a failure.

Run CPU verification from the repository root:

```sh
python3 packages/reply-model/evaluation_v2/fresh_evaluate.py verify
python3 -m unittest discover -s packages/reply-model/evaluation_v2 -p fresh_test.py
```

Only the designated collection executor runs model generation, after validation-only checkpoint selection. Use an existing owner-only output directory and absolute model/adapter/report paths:

```sh
python3 packages/reply-model/evaluation_v2/fresh_evaluate.py generate \
  --model /absolute/model --adapter /absolute/selected-adapter \
  --report /absolute/private-directory/fresh-comparison.json
```

Defaults are input budget 4096, maximum output 128, temperature 0 and `enable_thinking=False`. All 24 inputs are prechecked before any generation. Each case gets both base and selected-adapter outputs in a secret random label order. The separate mapping is file-hash-bound to the report. This helper does not implement a resource watchdog: execute it under the run's resource guard. Checkpoint-recovery output is offline-only evidence. Do not activate based on this command.

An independent reviewer sees only the `show` output and records semantic judgments for both anonymous labels. The shared general rubric is also returned by `show`. Per option, use `role`, `fact`, `abstain` each `pass|fail|uncertain`, and `usefulness`, `style` each integer 1–5. A verdict JSON has `options` keyed by every anonymous label and `preference` of a label, `tie`, or `none`. Label provenance `agent_delegated`; authorization must describe the actual user delegation. Preserve notes separately if desired, without editing rubric or source.

```sh
python3 packages/reply-model/evaluation_v2/fresh_evaluate.py show \
  --report /absolute/private-directory/fresh-comparison.json --id fresh-01
python3 packages/reply-model/evaluation_v2/fresh_evaluate.py review \
  --report /absolute/private-directory/fresh-comparison.json --id fresh-01 \
  --verdict-file /absolute/private-directory/verdict-fresh-01.json \
  --authorization 'User explicitly delegated all further quality judgments to the agent.'
```

After all 24 case verdicts are complete, freeze verdict hashes **before reading the mapping**. Only then run summary:

```sh
python3 packages/reply-model/evaluation_v2/fresh_evaluate.py freeze-verdicts \
  --report /absolute/private-directory/fresh-comparison.json
python3 packages/reply-model/evaluation_v2/fresh_evaluate.py summary \
  --report /absolute/private-directory/fresh-comparison.json
```

The fresh gate rejects any trained role/fact/abstention failure. It holds if any trained dimension is uncertain, any output usefulness is below 3, trained mean usefulness is below 4 or below base mean, or trained mean style is below 3.5. All 24 cases and both methods must be present with valid frozen hashes and delegated verdicts; missing/stale evidence aborts instead of producing a passing result. Clear prior decisions must be preserved, including scoped refusals and later self reversals; grounded answers must not be needlessly withheld. Reasonable future checking and asking are allowed. No exact wording or keyword triggers are required.

A passing fresh gate is necessary behavioral evidence only. It is neither evidence of general personal-style improvement nor sufficient for deployment. Separately report the observed real and old-fixture regressions, normal resource-bounded training completion, adapter integrity, and operating-policy decision. Once outputs are reviewed, this suite is observed evidence for future experiments, no longer untouched evidence.

## Completed first evaluation

The frozen suite was evaluated once against the selected safety-pilot-v4 adapter on 2026-10-03. All 24 blind verdicts were frozen before unblinding; the gate rejected deployment. This suite is now observed regression evidence for later experiments, not an untouched final test. The owner-only decision and review artifacts are under `~/.inboxd/reply-model/learning/verification-20261002/safety-pilot-v4/`; see `docs/27-historical-reply-training-plan.md` for the aggregate result. Do not use this suite to tune a later candidate and then describe another run as fresh validation.
