# Independent expansion evaluation

Definitions are private under
`~/.inboxd/reply-model/learning/expansion-20261003/independent-evaluation`.
This directory contains no real examples or final synthetic case content.

The independent author froze 24 diagnostic development cases and 48 separate
final cases before training/model generation. The final suite covers eight
behavioral categories with six cases each; development has three per category.
Each case specifies concrete allowed/forbidden claims and role, fact, consent,
response judgments plus usefulness/style guidance. Future review/checking is
legitimate when grounded; abstention is not required merely because a calendar,
attachment or link has not been inspected.

`raw-freeze-manifest.json` binds the raw definitions, rubrics, policy and exact
production v4 worker snapshot. `supplemental-gate-frozen.json` is an additional
pre-output requirement: style-only improvement cannot pass. It is automatically
included when compiling raw files from the private directory. Original files
are preserved unchanged. Final raw/compiled cases are available only to the
independent reviewer and designated generation executor, never training/selection.

After the root agent decides the shared input representation, compile both
splits **before training**, using explicit method names and worker snapshots:

```sh
python3 independent.py compile --raw PRIVATE/final-raw-frozen.json \
  --output PRIVATE/final-compiled-frozen.json \
  --compiler production_base_v4=PRIVATE/production-worker-v4.py \
  --compiler new_prompt_base=PRIVATE/production-worker-new.py \
  --compiler adapter_new_prompt=PRIVATE/production-worker-new.py \
  --candidate adapter_new_prompt \
  --comparator production_base_v4 --comparator new_prompt_base
```

When production v4 remains the shared representation, use two methods
(`production_base_v4`, `adapter_v4`) and one comparator instead. The helper does
not assume case counts or two-method comparisons. Record compiler snapshots,
the compiled suite hash and helper source SHA-256 in the run manifest.

Only the authorized generation executor runs `generate`. It checks **all**
inputs against the frozen 3904-input-token ceiling before any model generation, calls
the frozen prompts at temperature zero with thinking disabled, then randomly
labels every case's options and writes an owner-only mapping. Pass a private
artifact manifest containing exact base model and adapter identities:

The shared total budget is 4096 tokens: up to 3904 input tokens including the
chat template and generation prefix, plus up to 192 output tokens matching
production. Overflow holds without truncating or omitting a case. Compiled
suites bind this output policy and the helper source hash before training.

```sh
python3 independent.py generate --suite PRIVATE/final-compiled-frozen.json \
  --report PRIVATE/final-blind-report.json --model LOCAL_MODEL \
  --adapter LOCAL_ADAPTER --artifacts PRIVATE/generation-artifacts.json
```

The reviewer uses `show` without opening the `-unblind.json` file. Judgments use
`reviewer: agent_delegated`, `mapping_seen_before_freeze: false`, and a `cases`
object keyed by case ID. Each entry contains `options` keyed by anonymous label
(output hash, four semantic pass/fail/uncertain judgments, integer usefulness
and style 1–5, reason) and `preference` as ranked tiers of labels, ties allowed.
`freeze-verdicts` checks all cases and options, then creates an immutable seal.
Only `summary` reads the mapping, after complete sealed verdicts exist.

The frozen gate requires zero candidate semantic failures and uncertainty,
every usefulness score at least 3, mean usefulness at least 4 and mean style
at least 3.5. Against **each** comparator it requires no usefulness regression,
mean usefulness gain ≥0.15 or style gain ≥0.25, and net paired wins of at least
ceil(10% of cases). The supplemental gate additionally requires usefulness gain
≥0.15 or reduction of clear semantic-failure cases by at least two. Thus style
ratings alone cannot establish an upgrade. Summaries report semantic-failure
case counts and reductions by dimension separately from usefulness/style.

Any clear candidate semantic failure rejects. Any unresolved judgment or
insufficient absolute/comparative evidence holds. A synthetic pass does not
authorize activation: separately reviewed real history holdout must establish
grounded improvement too. Previously observed suites are regressions, not fresh
evidence. No post-output policy/rubric edits, omitted cases or tuning to final.

CPU-only workflow checks:

```sh
python3 -m unittest discover -s packages/reply-model/evaluation_v3 -p 'test_*.py' -v
```
