# Local personal adapter tooling

`personalization.py` provides explicit dataset inspection, offline MLX LoRA training,
held-out loss evaluation, activation, and rollback. It does not auto-train from
message edits and does not claim a trained personal model exists.

Use the same Python environment as the local reply worker (`requirements.txt`).
Models must be installed absolute local directories. Runtime downloads and training
telemetry are disabled. Run with network denied when verifying offline operation.

## Reviewed examples

Input is an explicitly prepared local JSONL file. Each row contains:

- `id`, `conversation_id`, `timestamp` (numeric chronological time).
- `reviewed: true`, `target_role: "self"`.
- `linkage: "explicit_reply" | "reviewed_turn"`.
- `target_message_id`, `context_message_ids`, `context_timestamps`.
- `provenance_refs`: source observation identifiers.
- `messages`: exact model chat input followed by the final assistant reply.
- Optional `duplicate_group`: reviewed near-duplicate group identifier.

Context timestamps must precede the target. Source pairing must be checked before
setting `reviewed`; a format check cannot establish that a reply is factually correct.
Examples are split chronologically 70/15/15, then conversations, exact repeated
answers, and declared duplicate groups spanning splits are excluded. This can leave
no usable split, especially for a single long conversation; training then stops with
`insufficient_disjoint_data`. Do not invent examples to fill a split.

## Commands

```sh
python personalization.py inspect --examples /absolute/reviewed.jsonl
python personalization.py train --examples /absolute/reviewed.jsonl \
  --model /absolute/model --output /absolute/new-adapter --iters 100
python personalization.py evaluate --examples /absolute/reviewed.jsonl \
  --model /absolute/model --output /absolute/base-evaluation
python personalization.py evaluate --examples /absolute/reviewed.jsonl \
  --model /absolute/model --adapter /absolute/new-adapter \
  --output /absolute/adapter-evaluation
python personalization.py activate --model /absolute/model \
  --adapter /absolute/new-adapter --registry /absolute/active-adapter.json --reviewed
python personalization.py rollback --registry /absolute/active-adapter.json
```

Evaluation here is held-out language-model loss, not a verdict on fact correctness,
style, routing, or authority. Review actual outputs and the plan's stage-specific
metrics before activation. `--reviewed` is an explicit operator assertion, not an
automatic quality gate. The worker must validate base identity and adapter identity
when loading the active registry. Training never changes the registry.

The registry records active and previous adapters; rollback to `null` selects base.
Base identity hashes config and weight content, and adapter identity hashes weights.

## Storage boundary and current limits

Canonical observations remain in Inboxd's encrypted storage. This developer tool
accepts a manually reviewed export; automated storage export/label review is not yet
connected. Training datasets are staged in a temporary 0700 directory with 0600 files
and removed on ordinary success/failure. An abrupt process kill can leave temporary
files; cleanup must be handled before a production training service is enabled.

Adapter outputs, manifests, and runtime logs are owner-only filesystem artifacts,
**not application-encrypted artifacts**. They can contain learned private information.
Do not present this tooling as satisfying the plan's encrypted model-artifact lifecycle.
Production automatic training remains gated on encrypted artifact handling and deletion
integration. Deleting a source example does not remove its influence from trained weights.

The synthetic smoke check exercises actual local LoRA execution and does not provide
evidence of improved personalization. No synthetic adapter is automatically activated.
