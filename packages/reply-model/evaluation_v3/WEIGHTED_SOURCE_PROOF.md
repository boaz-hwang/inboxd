The weighted producer source review found no blocking issue. Training multiplies
the ordinary answer loss by the globally normalized example weight; batch1 does
not cancel the multiplier. Adam's resulting influence is an empirical hypothesis.
All validation arithmetic remains unweighted. Weighted training loss cannot be
compared with the previous unweighted training loss.

`weighted_source_proof.py` is a CPU metadata verifier. It reads no training
examples, conversations, tokenizer or model. Use it only after the actual
weighted run and all four saved-artifact evaluations finish. Root and engineer
must first verify actual daemon readiness/restoration with a post-run status
query. `daemon-pause-resources.json` is not evidence of restoration.

The verifier checks the spaced-JSON producer seals, approved plan/experiment/map,
current two producer source hashes, weighted and ordinary completion linkage,
one weighted train dispatch and four unchanged saved-validation dispatches,
all304 observed training calls/order/target tokens and230 internal unweighted
validation calls. It binds the complete train guard (`adapter/resources.json`)
against6600seconds/28GiB/+4GiB swap, the exact four numbered artifacts and their
complete validation guard receipts. The validation target bound is the actual
bound shared by the four evaluation dispatches; it need not equal the train65
bound. The receipt's runtime-source field is the producer's two-file dictionary.

After completion, invoke the following with approved actual hashes; these are
placeholders rather than a claim that completion exists:

```sh
~/.inboxd/reply-model/venv/bin/python packages/reply-model/evaluation_v3/weighted_source_proof.py \
  --ordinary-plan APPROVED_ORDINARY_PLAN \
  --weighted-experiment APPROVED_WEIGHTED_EXPERIMENT \
  --weight-map APPROVED_WEIGHT_MAP \
  --weighted-dispatch COMPLETED_TRAINING_RUN/weighted-dispatch-proof.json \
  --weighted-completion COMPLETED_TRAINING_RUN/weighted-completion.json \
  --loss-observation COMPLETED_TRAINING_RUN/adapter/weighted-loss-observation.json \
  --ledger COMPLETED_TRAINING_RUN/adapter/checkpoint-validation.json \
  --completion COMPLETED_TRAINING_RUN/completion.json \
  --expected-plan-hash APPROVED_ORDINARY_PLAN_HASH \
  --expected-experiment-hash APPROVED_EXPERIMENT_HASH \
  --expected-map-hash APPROVED_WEIGHT_MAP_HASH \
  --output NEW_PRIVATE_SOURCE_PROOF.json
```

Output refuses overwrite and contains compact independently sealed metadata only.
Its six core `artifact_paths` match the existing frozen `weighted_dev.prepare`
contract; weighted completion, observation, train/saved guard receipts, numbered
weights, producers and verifier are additionally bound through `file_sha256`.
The later unchanged `checkpoint_dev.metadata_from_ledger` also checks actual base
identity and all four weights for finite values before Dev binding. This helper
does not authorize GPU generation, deployment, final access or activation.

Fake CPU tests:

```sh
~/.inboxd/reply-model/venv/bin/python -m unittest discover \
  -s packages/reply-model/evaluation_v3 -p test_weighted_source_proof.py -v
```
