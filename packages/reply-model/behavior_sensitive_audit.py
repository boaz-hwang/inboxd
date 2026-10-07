"""Retrospective exact-source sensitivity scan; persist no identifier values."""
from collections import Counter, defaultdict
import json
from pathlib import Path
import re
from behavior_audit import client, read, write_private, digest
import history as h
import review_sensitive as sensitive


def finalize_eligibility(directory):
    """Separate future source gates from unchanged historical approval."""
    inventory = read(directory/'behavior-inventory.json')
    allocation = read(directory/'sensitive-source-semantic-allocation.json')
    rows = []
    for name in ('sensitive-owner-semantic-review-corrected-v2.json','sensitive-sol-semantic-review.json'):
        rows.extend(read(directory/name)['rows'])
    if len(rows)!=33 or {r['source_index'] for r in rows} != set(range(33)):
        raise ValueError('all_flagged_sources_require_semantic_policy_review')
    for row in rows:
        original = allocation['sources'][row['source_index']]
        if row['source_key'] != original['source_key'] or sorted(row['affected_training_indices']) != sorted(original['example_indices']):
            raise ValueError('sensitivity_source_binding_changed')
    excluded={i for r in rows if r['future_decision']=='exclude' for i in r['affected_training_indices']}
    held={i for r in rows if r['future_decision']=='hold' for i in r['affected_training_indices']}-excluded
    examples=[]
    for index, original in enumerate(inventory['examples']):
        examples.append({'index':index,'id':original['id'],'review_hash':original['review_hash'],
                         'future_policy_gate':'exclude' if index in excluded else 'hold' if index in held else 'not_blocked_by_this_targeted_audit',
                         'source_review_indices':[r['source_index'] for r in rows if index in r['affected_training_indices']],
                         'original_historical_approval_unchanged':True})
    packet={'schema':'future-source-eligibility-targeted-audit-v1','examples':examples,'source_reviews':rows,
            'original_frozen_approved_count':1374,'original_completion_tokens_with_eos':33300,
            'reviewed_flagged_sources':33,'source_decision_counts':dict(Counter(r['future_decision'] for r in rows)),
            'excluded_example_count':len(excluded),'excluded_indices':sorted(excluded),
            'held_example_count':len(held),'held_indices':sorted(held),
            'not_blocked_by_targeted_audit_count':1374-len(excluded|held),
            'confirmed_policy_miss':'One actual personal financial account source was included in one historical training input despite the existing exclusion addendum; the credential-only detector did not cover this category.',
            'scope':'Credential detector scan covered all1374; added numeric cues selected33 sources for semantic policy review. This is not complete whole-context privacy reapproval of all1374.',
            'ordinary_contact_or_delivery_numbers_not_automatically_excluded':True,
            'future_training_dataset_created':False,'identifier_values_persisted':0}
    packet['eligibility_hash']=digest(packet)
    write_private(directory/'future-source-eligibility-final-v3.json',packet)
    return packet


def run(directory):
    grant = read(directory/'owner-grant.json')
    inventory = read(directory/'behavior-inventory.json')
    records = []
    for offset in range(0, len(grant['train_ids']), 20):
        packet = client(grant, {'op': 'records', 'ids': grant['train_ids'][offset:offset+20], 'include_targets': True})
        records.extend(c['record'] for c in packet['cases'])
    known_values = set()
    for r in records:
        for m in (*r['context'], *r['targets']):
            known_values.update(sensitive.credential_values(m.get('body')))
    existing = sensitive.sensitive_source_evidence(records, known_values=known_values)
    contact = re.compile(r'(?<!\d)(?:0(?:1[016789]|2|[3-6][1-5]|70)[- ]?\d{3,4}[- ]?\d{4}|\d{4}-\d{4})(?!\d)')
    financial = re.compile(r'(?:은행|계좌|예금주|입금|송금|보내는.*분|주민|여권|사업자등록|통관).{0,100}(?:\d[- ]?){8,}', re.S)
    rows, flagged_sources = [], defaultdict(set)
    indices = {r['id']: n for n, r in enumerate(inventory['examples'])}
    for r in records:
        messages = [*r['context'], *r['targets']]
        source_codes = {}
        for n, m in enumerate(messages):
            body = m.get('body') or ''
            key = h.source_key(r['chat'], m['message_id'])
            codes = list(existing.get(key, []))
            if contact.search(body):
                codes.append('contact_number_pattern_requires_policy_and_semantic_review')
            neighborhood = '\n'.join(x.get('body') or '' for x in messages[max(0,n-1):n+2])
            if financial.search(neighborhood) and re.search(r'(?:\d[- ]?){8,}', body):
                codes.append('financial_or_identity_number_pattern_requires_semantic_review')
            if codes:
                source_codes[key] = sorted(set(codes))
                flagged_sources[key].update(codes)
        if source_codes:
            rows.append({'index': indices[r['id']], 'id': r['id'], 'review_hash': r['review_hash'],
                         'flagged_source_codes': source_codes,
                         'existing_policy_exact_source_matches': sorted(set(r['source_message_keys']) & set(existing)),
                         'future_training_eligibility': 'quarantine_pending_policy_and_semantic_review',
                         'past_frozen_training_record_unmodified': True})
    records.clear()
    known_values.clear()
    packet = {'schema': 'retrospective-sensitive-source-audit-v1', 'examined_train_examples': 1374,
              'flagged_examples': rows, 'flagged_example_count': len(rows), 'flagged_unique_sources': len(flagged_sources),
              'code_source_counts': dict(Counter(c for cs in flagged_sources.values() for c in cs)),
              'existing_policy_exact_source_match_count': len(existing),
              'method': 'Existing exact policy detector plus explicit contact/financial numeric cues, requiring delegated semantic review. No identifier values saved.',
              'contact_or_payment_account_pattern_alone_is_not_original_policy_violation': True,
              'past_training_history_unchanged': True, 'weights_already_deleted': True, 'identifier_values_persisted': 0}
    packet['audit_hash'] = digest(packet)
    write_private(directory/'retrospective-sensitive-source-audit.json', packet)
    print(json.dumps({k: packet[k] for k in ('examined_train_examples','flagged_example_count','flagged_unique_sources','code_source_counts','existing_policy_exact_source_match_count')}))


if __name__ == '__main__':
    run(Path.home()/'.inboxd/reply-model/learning/behavior-audit-20261006')
