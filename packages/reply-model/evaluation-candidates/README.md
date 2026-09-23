# Reply accuracy experiments (2026-09-23)

These files are evaluation-only candidates. `worker.py` does not import them, and
the product build does not package them. The local evaluator accepts their paths
explicitly and records source/model/fixture SHA-256 values in each JSONL header.
No candidate below met the accuracy gate for installation.

`worker-legacy.py` is the frozen pre-v2 production baseline for offline comparison.
Production now uses preflight + one generation in `../worker.py`, without a checker.
Run historical checker evaluations with `--worker` pointing to `worker-legacy.py`;
they do not measure the current production pipeline.

| Candidate | Change from the existing checker | Observed result |
| --- | --- | --- |
| Baseline | Production prompt and non-thinking Qwen3.5-9B | [20 cases: 16/20 verdict and reason](../evaluation-results/accuracy-baseline-20260923.jsonl); [new role holdout: 3/6 verdict, 2/6 reason](../evaluation-results/accuracy-baseline-holdout-v2-20260923.jsonl) |
| A (`checker_prompt.py`, `reason_first_variant`) | Put explanation before verdict in the JSON schema | [Role 6: 4/6 verdict, 3/6 reason](../evaluation-results/accuracy-reason-first-role-20260923.jsonl) |
| B (`checker_prompt.py`, `build_checker_prompt`) | Replace the long policy with an actor-focused policy | [Early 16 cases: 9/16 verdict](../evaluation-results/accuracy-checker-candidate-20260923.jsonl); stopped for multiple false approvals and rejections |
| C (`checker_prompt.py`, `explicit_roles_variant`) | A plus explicit `self`/`other` definitions | [Role 6: 3/6 verdict, 2/6 reason](../evaluation-results/accuracy-c-role-20260923.jsonl) |
| D (`checker_thinking.py`) | Existing prompt, thinking enabled, greedy decoding, 2048-token cap | [No final verdict; reasoning truncated](../evaluation-results/accuracy-d2-error-20260923.jsonl). The first parsing run was an experiment-harness error, not a model verdict. |
| E (`checker_sampling.py`) | D with Qwen-recommended sampling and fixed seed 42 | [First case: no final verdict; reasoning truncated](../evaluation-results/accuracy-e-sampling-first-20260923.jsonl) |
| F (`checker_frame.py`) | Existing policy with source/request/draft actors extracted before verdict | [Role 6: 6/6 verdict, 4/6 reason](../evaluation-results/accuracy-f-frame-role-remaining-20260923.jsonl) when combined with [the first two cases](../evaluation-results/accuracy-f-frame-critical-20260923.jsonl), but [balanced 8: 7/8](../evaluation-results/accuracy-f-frame-balanced-20260923.jsonl), including a false rejection of a valid sender follow-up |
| G (`checker_mode.py`) | F for `reply_other`, baseline for `continue_self` | [Boundary 6: 5/6](../evaluation-results/accuracy-g-boundary-20260923.jsonl), including a false rejection of a visible address; [new role holdout: 3/6](../evaluation-results/accuracy-g-holdout-v2-20260923.jsonl) |

F's actor extraction sometimes names the wrong requested actor even when the
final verdict happens to match. G's holdout exposes both false approval of a
reversed request and false rejection of ordinary uncertainty and group context.
These results cannot establish that either checker is safer than the baseline.
Across the original 20 cases plus the six new holdout cases, the baseline has
19/26 correct verdicts and 18/26 correct reason codes. G has 22/26 and 20/26,
respectively, but still scores only 3/6 on the new holdout and retains a
dangerous false approval of a reversed request. It was therefore not installed.

The separate [27B holdout run](../evaluation-results/accuracy-27b-holdout-v2-partial-20260923.jsonl)
was interrupted after three of six planned cases when priorities changed. All
three completed rows matched their expected verdict and reason, but this is an
incomplete observation, not a 3/6 score or a model-selection result. No 27B
production switch followed.

Run the evaluator with the installed local Python environment and model only.
For example, from the repository root:

```sh
~/.inboxd/reply-model/venv/bin/python packages/reply-model/evaluation_accuracy.py \
  --worker packages/reply-model/worker.py \
  --checker-mode packages/reply-model/evaluation-candidates/checker_mode.py \
  --check-max-tokens 768 \
  --result /tmp/inboxd-checker-review.jsonl \
  packages/reply-model/fixtures/accuracy_role_direction.json
```

The evaluator injects each fixture draft into the first model call and makes
one real checker call. It never sends a message or marks a conversation read.
Thinking outputs are not written to the result file. `test/test_checker_thinking.py`
checks the thought-boundary parser without loading a model.
