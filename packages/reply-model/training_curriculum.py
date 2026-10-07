"""Separate synthetic train and validation supervision using production input."""
import copy
import json
from pathlib import Path

from learning_split import key
from personalization import digest, prefilter_length
try:
    from worker import PROMPT_VERSION, build_generation_input, compile_prompt
except ModuleNotFoundError:
    import importlib.util
    spec = importlib.util.spec_from_file_location('curriculum_worker', Path(__file__).with_name('inboxd-reply-worker.py'))
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    PROMPT_VERSION = worker.PROMPT_VERSION
    build_generation_input, compile_prompt = worker.build_generation_input, worker.compile_prompt


VERSION = 'reply-safety-curriculum-v1'
VALIDATION_VERSION = 'reply-safety-validation-v1'


def _fixture_path(name):
    installed = Path(__file__).with_name(name)
    return installed if installed.is_file() else Path(__file__).parent / 'fixtures' / name


DEFAULT_FIXTURE = _fixture_path('reply_safety_curriculum.json')
DEFAULT_VALIDATION_FIXTURE = _fixture_path('reply_safety_validation.json')


def build_records(tokenizer, *, seq_length=4096, fixture=DEFAULT_FIXTURE):
    """Validate all synthetic examples, including exact template target boundaries.

    These are authored supervision, never observed user sends or semantic reviews
    of messenger history. Callers must explicitly assign every record to train.
    """
    return _build_records(tokenizer, seq_length=seq_length, fixture=fixture, split='train')


def build_validation_records(tokenizer, *, seq_length=4096, fixture=DEFAULT_VALIDATION_FIXTURE):
    """Independent synthetic valid-only cases for checkpoint selection, never train."""
    return _build_records(tokenizer, seq_length=seq_length, fixture=fixture, split='valid')


def _build_records(tokenizer, *, seq_length, fixture, split):
    version = VERSION if split == 'train' else VALIDATION_VERSION
    provenance = 'invented_training_only_v1' if split == 'train' else 'invented_validation_only_v1'
    prefix_id = 'curriculum-v1-' if split == 'train' else 'curriculum-valid-v1-'
    bundle = json.loads(Path(fixture).read_text())
    if bundle.get('version') != version or bundle.get('source') != 'synthetic' or bundle.get('split') != split:
        raise ValueError('invalid_curriculum_bundle')
    records, seen = [], set()
    for case in bundle['cases']:
        identity = case['id']
        if identity in seen or not identity.startswith(prefix_id):
            raise ValueError('invalid_curriculum_identity')
        seen.add(identity)
        if case.get('source') != 'synthetic' or case.get('provenance') != provenance:
            raise ValueError('invalid_curriculum_provenance')
        context = []
        for index, turn in enumerate(case['turns']):
            if turn['role'] not in ('self', 'other') or (turn['author'] == 'self') != (turn['role'] == 'self'):
                raise ValueError('invalid_curriculum_role')
            context.append({'message_id': f'm{index}', 'author_role': turn['role'],
                'author_id': turn['author'], 'body': turn['body'], 'ts': 1000 + index,
                'reply_to': None})
        if not context or context[-1]['author_role'] != 'other':
            raise ValueError('invalid_curriculum_reply_target')
        chat = {'platform': 'telegram', 'account': 'synthetic-curriculum', 'chat_id': identity}
        compiled, omitted = compile_prompt({'context': context, 'chat': chat, 'incoming_message_ids': None})
        if omitted or json.loads(compiled[-1]['content'])['preflight']['status'] != 'ready':
            raise ValueError('curriculum_preflight_failed')
        messages = build_generation_input(compiled) + [{'role': 'assistant', 'content': case['target']}]
        target_id = 'synthetic-target'
        sources = [key(chat['platform'], chat['account'], identity, m['message_id']) for m in context]
        target_key = key(chat['platform'], chat['account'], identity, target_id)
        record = {'id': 'synthetic:' + identity, 'source': 'synthetic', 'chat': chat,
            'conversation_id': digest(chat), 'timestamp': 1000 + len(context),
            'context_message_ids': [m['message_id'] for m in context],
            'context_timestamps': [m['ts'] for m in context], 'context': context,
            'target_message_id': target_id, 'target_role': 'self', 'messages': messages,
            'source_message_keys': sources + [target_key], 'target_source_keys': [target_key],
            'provenance_refs': [version, identity, provenance],
            'reviewed': True, 'review_provenance': 'authored_synthetic_supervision',
            'authorship': 'synthetic', 'linkage': 'reviewed_turn', 'training_only': split == 'train',
            'validation_only': split == 'valid', 'synthetic_split': split,
            'purpose': case['purpose'], 'prompt_version': PROMPT_VERSION,
            'curriculum_version': version, 'curriculum_revision': bundle.get('revision', 1),
            'fixture_hash': digest(bundle),
            'review_binding_kind': 'authored_synthetic_supervision'}
        # The admission protocol names this field review_hash. Its explicit
        # prefix/provenance binds authored supervision, never a messenger or
        # human review. Include the exact compiled prompt and target as well as
        # fixture identity so a changed compiler or source invalidates admission.
        record['review_hash'] = 'authored-synthetic:' + digest(record)
        full = tokenizer.apply_chat_template(messages, return_dict=False, enable_thinking=False)
        prefix = tokenizer.apply_chat_template(messages[:-1], add_generation_prompt=True,
                                               return_dict=False, enable_thinking=False)
        if len(full) - len(prefix) > 192:
            raise ValueError('curriculum_target_exceeds_generation_limit')
        kept, rejected = prefilter_length([record], tokenizer, seq_length)
        if rejected:
            raise ValueError('curriculum_over_token_budget')
        records.extend(kept)
    return records


def merge_training_records(real_records, assignments, synthetic_records):
    """Append synthetic train records without changing any real partition.

    Synthetic data must be excluded from historical-example retrieval and from
    real-data approval/minimum-count reports by callers.
    """
    if set(assignments) != {r['id'] for r in real_records}:
        raise ValueError('explicit_real_assignments_required')
    result, splits = copy.deepcopy(real_records), dict(assignments)
    for record in synthetic_records:
        if record['id'] in splits or record.get('source') != 'synthetic' or record.get('training_only') is not True:
            raise ValueError('invalid_synthetic_training_record')
        result.append(copy.deepcopy(record))
        splits[record['id']] = 'train'
    return result, splits


def merge_validation_records(real_records, assignments, synthetic_records):
    """Preserve existing assignments and append only explicit valid-only records."""
    if set(assignments) != {r['id'] for r in real_records}:
        raise ValueError('explicit_real_assignments_required')
    result, splits = copy.deepcopy(real_records), dict(assignments)
    for record in synthetic_records:
        if (record['id'] in splits or record.get('source') != 'synthetic'
                or record.get('validation_only') is not True or record.get('training_only') is not False):
            raise ValueError('invalid_synthetic_validation_record')
        result.append(copy.deepcopy(record))
        splits[record['id']] = 'valid'
    return result, splits
