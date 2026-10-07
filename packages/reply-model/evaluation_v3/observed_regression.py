"""Small observed-only orchestration utilities; no collection, GPU CLI or gate.

The owner must resolve old real inputs after restoration, freeze provenance,
then call these utilities inside the existing bounded daemon lifecycle.
"""
from collections import defaultdict, deque
import gc
import hashlib
import json

from independent import digest


COUNTS={'real22':22,'synthetic24':24,'operational4':4}
OUTPUT_TOKENS={'real22':192,'synthetic24':128,'operational4':192}


def legacy_prompt_hash(messages):
    return hashlib.sha256(json.dumps(messages,sort_keys=True,ensure_ascii=False).encode()).hexdigest()


def preflight(groups,expected_ids,real_entries,tokenizer):
    if set(groups) != set(COUNTS) or set(expected_ids) != set(COUNTS):
        raise ValueError('three_observed_groups_required_no_fresh_pooling')
    if (len(real_entries) != 22 or len({e['id'] for e in real_entries}) != 22
            or {e['id'] for e in real_entries} != set(expected_ids['real22'])):
        raise ValueError('all22_original_availability_entries_required')
    available=set()
    for entry in real_entries:
        if entry['status'] == 'ready':
            messages=groups['real22'].get(entry['id'])
            if (messages is None or entry.get('original_prompt_hash') != entry.get('current_prompt_hash')
                    or entry.get('original_prompt_hash') != legacy_prompt_hash(messages)):
                raise ValueError('exact_old_prompt_hash_required_for_ready_observation')
            available.add(entry['id'])
        elif entry['status'] != 'unavailable' or not entry.get('reason'):
            raise ValueError('explicit_unavailable_reason_required')
    result={}
    for group,inputs in groups.items():
        if len(expected_ids[group]) != COUNTS[group] or len(set(expected_ids[group])) != COUNTS[group]:
            raise ValueError('exact_original_observed_id_set_required')
        expected=available if group == 'real22' else set(expected_ids[group])
        if set(inputs) != expected:
            raise ValueError('no_silent_missing_or_substituted_observed_case')
        maximum=0
        for messages in inputs.values():
            count=len(tokenizer.apply_chat_template(messages,add_generation_prompt=True,
                enable_thinking=False,return_dict=False))
            if count > 3904:
                raise ValueError('observed_input_over_budget_no_truncation_or_omission')
            maximum=max(maximum,count)
        result[group]={'original_case_count':COUNTS[group],'ready_case_count':len(inputs),
            'unavailable_case_count':COUNTS[group]-len(inputs),'method_count':2,
            'max_input_tokens':maximum,'max_output_tokens':OUTPUT_TOKENS[group],
            'fresh_gate_evidence':False}
    return result


class Cache:
    def __init__(self,max_tokens):
        self.max_tokens=max_tokens;self.values=defaultdict(deque);self.remaining=0
    def put(self,messages,adapter,text):
        self.values[(digest(messages),adapter)].append(text);self.remaining+=1
    def generate_text(self,messages,*,adapter_path=None,max_tokens=192,temperature=0.):
        values=self.values[(digest(messages),adapter_path)]
        if max_tokens != self.max_tokens or temperature != 0 or not values:
            raise ValueError('observed_cache_policy_or_input_mismatch')
        self.remaining-=1;return values.popleft()


def generate_cached(engine,inputs,selected_adapter,group,clear_cache):
    if group not in COUNTS or not selected_adapter:
        raise ValueError('observed_group_and_single_quality_winner_required')
    cache=Cache(OUTPUT_TOKENS[group])
    try:
        for adapter in (None,str(selected_adapter)):
            engine.models.clear();gc.collect();clear_cache()
            for messages in inputs.values():
                text=engine.generate_text(messages,adapter_path=adapter,
                    max_tokens=OUTPUT_TOKENS[group],temperature=0.).strip()
                if not text:raise ValueError('empty_observed_generation_hold')
                cache.put(messages,adapter,text)
    finally:
        engine.models.clear();gc.collect();clear_cache()
    return cache


def publish_existing_synthetic(fresh_helper,cache,tokenizer,selected_adapter,output,suite_path):
    result=fresh_helper.generate(cache,tokenizer,selected_adapter,output,
        suite_path=suite_path,max_tokens=128,max_input_tokens=3904)
    if cache.remaining:raise ValueError('incomplete_observed_synthetic_publication')
    if result['case_count'] != 24 or result['comparison_complete'] is not True:
        raise ValueError('incomplete_observed_synthetic24_report')
    return result


def publish_existing_operational(helper,cache,model,selected_adapter,output):
    result=helper.compare_operational(model,selected_adapter,output,engine_factory=lambda:cache)
    if cache.remaining:raise ValueError('incomplete_observed_operational_publication')
    return result
