"""Blind, source-isolated comparison of local reply methods."""
import hashlib
import math
import json
from pathlib import Path
import random
import time

from learning_split import chat_key, interval, overlaps, source_keys
from personalization import private_json, digest


def retrieval_examples(train, case, *, max_examples=2):
    """Stable past-only retrieval, excluding heldout sources and chat derivatives."""
    case_keys = source_keys(case)
    eligible = [r for r in train if r['timestamp'] < case['timestamp']
                and not (source_keys(r) & case_keys)
                and not (chat_key(r) == chat_key(case) and overlaps(interval(r), interval(case)))]
    eligible.sort(key=lambda r: (r['timestamp'], r['id']), reverse=True)
    return eligible[:max_examples]


def retrieval_prompt(prompt, examples):
    """Keep example turns outside the current conversation's metadata positions."""
    reference = ("\n별도의 과거 대화 예시(JSON): 아래 예시는 다른 상황에서 작성한 답장입니다. "
                 "말투와 답장 방식을 참고하되 예시의 사실·결정을 현재 대화에 적용하지 마세요. "
                 "각 예시의 메타데이터는 그 예시 안에서만 유효합니다.\n" +
                 json.dumps([{'messages': r['messages']} for r in reversed(examples)],
                            ensure_ascii=False, separators=(',', ':')) +
                 "\n이후 실제 대화 턴은 현재 대화입니다. 현재 turn_metadata의 순서에는 과거 예시를 포함하지 않습니다.")
    if prompt and prompt[0]['role'] == 'system':
        return [{**prompt[0], 'content': prompt[0]['content'] + reference}] + list(prompt[1:])
    return [{'role': 'system', 'content': reference}] + list(prompt)


def evaluation_cases(test_records, rubric_cases=(), heldout_rubric=None):
    cases = []
    for r in test_records:
        cases.append({'id': r['id'], 'source': 'heldout_reply', 'messages': r['messages'][:-1],
                      'rubric': heldout_rubric, 'record': r,
                      'evaluation_group': r.get('evaluation_group', 'unclassified'),
                      'source_hash': r.get('review_hash') or digest(r)})
    for case in rubric_cases:
        rubric = case.get('rubric')
        if not isinstance(rubric, dict) or not all(k in rubric for k in ('role', 'fact', 'abstain')):
            raise ValueError('external_rubric_required')
        cases.append({'id': case['id'], 'source': 'rubric_fixture',
                      'messages': case['messages'], 'rubric': rubric,
                      'source_hash': digest({'id':case['id'],'messages':case['messages'],'rubric':rubric})})
    return cases


def compare(engine, tokenizer, train, test, adapter, output, *, active_adapter=None,
            rubric_cases=(), heldout_rubric=None, max_tokens=192, max_input_tokens=4096,
            seq_length=2048, seed=0, gap_policy=None):
    """Produce outputs with anonymous labels; reviewers fill verdicts separately."""
    gap_policy = {} if gap_policy is None else gap_policy
    if (not isinstance(gap_policy, dict) or any(
            platform not in ('kakao', 'telegram', 'slack') or type(value) not in (int, float)
            or not math.isfinite(value) or value < 0 for platform, value in gap_policy.items())):
        raise ValueError('invalid_gap_policy')
    methods = {'base': None, 'trained': str(adapter)}
    if active_adapter:
        methods['active'] = str(active_adapter)
    results = []
    if not isinstance(heldout_rubric, dict) or not all(k in heldout_rubric for k in ('role', 'fact', 'abstain')):
        raise ValueError('external_rubric_required')
    omissions = []
    def count(messages):
        return len(tokenizer.apply_chat_template(messages, add_generation_prompt=True,
                                                  enable_thinking=False, return_dict=False))
    for case in evaluation_cases(test, rubric_cases, heldout_rubric):
        prompt = case['messages']
        if count(prompt) > max_input_tokens:
            omissions.append({'id': case['id'], 'reason': 'common_prompt_over_budget'})
            continue
        outputs = []
        for name, adapter_path in methods.items():
            start = time.perf_counter()
            response = engine.generate_text(prompt, adapter_path=adapter_path, max_tokens=max_tokens, temperature=0.0)
            elapsed = time.perf_counter() - start
            outputs.append({'method': name, 'text': response,
                            'input_tokens': count(prompt),
                            'output_tokens': len(tokenizer.encode(response)), 'latency_seconds': elapsed})
        if case['source'] == 'heldout_reply':
            examples = retrieval_examples(train, case['record'])
            while examples:
                example_prompt = retrieval_prompt(prompt, examples)
                if count(example_prompt) <= max_input_tokens:
                    break
                examples.pop()
            if examples:
                start = time.perf_counter()
                response = engine.generate_text(example_prompt, max_tokens=max_tokens, temperature=0.0)
                outputs.append({'method': 'retrieval', 'text': response,
                                'input_tokens': count(example_prompt),
                                'output_tokens': len(tokenizer.encode(response)),
                                'latency_seconds': time.perf_counter()-start,
                                'example_ids': [r['id'] for r in examples]})
            else:
                omissions.append({'id': case['id'], 'reason': 'retrieval_example_unavailable_or_over_budget'})
        rng = random.Random(hashlib.sha256(f'{seed}:{case["id"]}'.encode()).digest())
        rng.shuffle(outputs)
        labels = {}
        blind = []
        for index, item in enumerate(outputs):
            label = f'option_{index+1}'
            method = item.pop('method')
            response = item.pop('text')
            labels[label] = {'method': method, **item}
            blind.append({'label': label, 'text': response,
                          'output_hash': digest(response), 'human_verdict': None})
        results.append({'id': case['id'], 'source': case['source'],
                        'source_hash': case['source_hash'],
                        'prompt_hash': digest(prompt),
                        'rubric_hash': digest(case['rubric']), 'rubric': case['rubric'],
                        'evaluation_group': case.get('evaluation_group'),
                        'outputs': blind, 'review_complete': False,
                        'comparison_complete': case['source'] != 'heldout_reply' or any(
                            item['method'] == 'retrieval' for item in labels.values()),
                        '_labels': labels})
    output = Path(output)
    # The mapping is kept in a separate owner-only file, so review can hide it.
    mapping = {r['id']: r.pop('_labels') for r in results}
    private_json(output, {'report_version': 3, 'seq_length': seq_length,
                          'gap_policy': gap_policy, 'gap_policy_hash': digest(gap_policy),
                          'max_input_tokens': max_input_tokens,
                          'retrieval_prompt_version': 'isolated-reference-v1',
                          'rubric_bundle_hash': digest({'heldout': heldout_rubric,
                                                        'fixtures': list(rubric_cases)}),
                          'cases': results, 'complete': True,
                          'comparison_complete': not omissions and bool(results),
                          'omissions': omissions, 'sample_count': len(results),
                          'comparable_abc_count': sum(r['source'] == 'heldout_reply' and r['comparison_complete'] for r in results),
                          'evaluation_group_counts': {kind: sum(r.get('evaluation_group') == kind for r in results)
                              for kind in ('temporal', 'heldout_chat', 'retrospective')},
                          'human_review_complete': False,
                          'metrics': {'role_errors': None, 'fact_errors': None,
                                      'abstain_errors': None, 'preference': None}})
    private_json(output.with_name(output.stem + '-unblind.json'), mapping)
    return str(output)
