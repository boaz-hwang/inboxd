# Local decision-model alternatives (research, 2026-09-23)

The current pipeline asks a Qwen3.5-9B chat model for typed context decisions,
then still makes one draft-generation call and one independent grounding-check
call. A specialized decision model could replace the **decision** call without
removing generation, grounding, policy checks, retrieval limits, or trajectory
records. This document is a source review only: no model was downloaded or run.

## Candidates

| Candidate | Fit for this product | Evidence and limit |
| --- | --- | --- |
| [Kev-4B](https://github.com/jaredpalmer/kev) | Best first **local experiment** for typed routing; Apache-2.0 adapter/head on Apache-2.0 Qwen3.5-4B-Base, self-hosted MLX path and training code. | [Model card](https://github.com/jaredpalmer/kev/blob/main/docs/model-cards/kev-4b.md) reports 0.837 new-source locked-test accuracy and ~9 GB bf16 serving memory. Repository reports 721 ms median for five three-option questions on an M5 with a ~270-token state via MLX; this is neither this M4 nor inboxd's longer Korean state. |
| [Kev-9B](https://github.com/jaredpalmer/kev/blob/main/docs/model-cards/kev-9b.md) | Local accuracy candidate if 4B fails. Same typed interface and trainable architecture, with higher memory cost. | Card reports 0.852 new-source locked-test accuracy and ~19 GB bf16 serving memory. Its older M5 PyTorch/MPS five-question timing is about 2 s; the current repository describes an MLX path but publishes no comparable 9B/M4 latency for this workload. |
| [Kev-0.8B](https://github.com/jaredpalmer/kev/blob/main/docs/model-cards/kev-0.8b.md) | Small-memory floor, unlikely first choice for accuracy. | Card reports 0.684 new-source locked-test accuracy. Even on M5 its MLX median is 149 ms for five questions and a short state. It explicitly recommends 4B when accuracy matters. |
| [Jev 1.13](https://docs.typesafe.ai/models) | Useful architectural reference; not a local replacement for private conversation processing in the current product. | Official docs provide a hosted `POST /v1/systemone` model, 64k request/32k state-plus-question limits, and no customer fine-tuning/LoRA. English is the primary training language; the provider says CJK accuracy is lower and requires workload testing. No downloadable checkpoint or local inference path is documented. |
| [KLUE RoBERTa base](https://huggingface.co/klue/roberta-base) | Korean-specific 0.1B encoder baseline for a future supervised classifier; not a ready typed multihead decision model. | The [KLUE NLI dataset](https://huggingface.co/datasets/klue/klue) is CC-BY-SA-4.0. The base model card has no explicit license tag, so redistribution terms need separate review. Task labels/training and Mac latency measurement are still needed. |

Kev's [README](https://github.com/jaredpalmer/kev#limitations) says its released
training used at most 384 state tokens and 1,024 tokens for state plus one
question; serving accepts up to 8,192 for that pair. The inboxd decision state
can contain much longer conversation text. Long-context accuracy is therefore
an open risk even when input fits the serving limit. The Kev project lists
multilingual slices as deferred in its [research plan](https://github.com/jaredpalmer/kev/blob/main/PLAN.md);
its published aggregate benchmarks do not establish Korean messenger accuracy.
The popular [mDeBERTa XNLI card](https://huggingface.co/MoritzLaurer/mDeBERTa-v3-base-mnli-xnli)
and [GLiClass Multilang Mini card](https://huggingface.co/knowledgator/gliclass-multilang-mini)
list their trained languages without Korean. They do not provide a stronger
Korean-ready candidate on present evidence.

## Integration boundary

Kev and Jev return independent `choice`, `noul`, and `score` questions against
one state. In inboxd, `response`, `sufficiency`, and `escalation` could be
closed-set choices; each `gap`, `risk`, and registered source could be a
separate yes/no question. The existing [decision contract](../packages/reply-model/context_intelligence.py)
and [policy](../packages/reply-model/policy.py) must still validate labels,
source IDs, cross-head consistency, retrieval scope, and execution budgets.
Independent question answers can contradict one another. A probability is an
estimate to calibrate on reviewed inboxd cases, not proof that a decision is
correct. TypeSafe's own [limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
note indirection, long irrelevant state, prompt injection, and structural
inconsistency across questions.

Kev is a LoRA adapter **plus a pointer head** on a **base** Qwen model; the
installed Qwen3.5-9B is a chat checkpoint. Its adapter cannot be dropped into
the current MLX-LM `generate_text` loader as if it were the personal text LoRA.
An isolated local decision service or a dedicated in-process loader would be
needed, with strict input/output validation and offline operation. Keep the
current generation and grounding calls unchanged while testing it.

For a fair trial, freeze Korean conversation examples before model selection,
including valid replies, role reversals, explicit negation, URL contents,
unknown availability, and long/group conversations. Compare route correctness,
source/gap correctness, downstream ready quality, false approvals, abstentions,
calibration, peak memory, and p50/p95 latency on this M4 Pro. Also compare
identical short versus long states. The existing 26 checker examples measure
grounding behavior, not routing quality, so they cannot by themselves select a
decision model. No hosted Jev call should receive private conversation data
under the current local-only design.
