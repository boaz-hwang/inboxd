"""Validate and aggregate all approved context-bound agent behavior judgments."""
from collections import Counter
import hashlib
from pathlib import Path
from behavior_audit import digest, read, write_private, TAXONOMY


def combine(directory, sealed):
    inventory = read(directory/'behavior-inventory.json')
    allocation = read(directory/'full-semantic-review-allocation.json')
    coverage = read(sealed/'final-fullpool-coverage.json')
    metadata = {r['id']:r for r in coverage['entries']}
    judgments, files = {}, []
    for path in sorted(directory.glob('semantic-*-review-*.json')):
        packet = read(path)
        if packet['judgment_hash'] != digest({k:v for k,v in packet.items() if k!='judgment_hash'}) or packet['inventory_hash'] != inventory['inventory_hash']:
            raise ValueError('judgment_seal_or_inventory_changed')
        files.append({'path':str(path),'raw_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'count':packet['count']})
        for row in packet['judgments']:
            if row['index'] in judgments:
                raise ValueError('duplicate_semantic_index')
            original = inventory['examples'][row['index']]
            if row['id'] != original['id'] or row['review_hash'] != original['review_hash']:
                raise ValueError('semantic_source_binding_changed')
            judgments[row['index']] = row
    if set(judgments) != set(range(len(inventory['examples']))):
        raise ValueError('all_1374_new_semantic_reviews_required')
    if len(allocation['behavior_owner_remaining_indices'])+len(allocation['reviewer_sol_remaining_indices']) != 805:
        raise ValueError('full_semantic_allocation_changed')
    corrections, corrected_indices = [], set()
    for path in sorted(directory.glob('semantic-*-corrections-v3.json')):
        packet = read(path)
        if packet['correction_hash'] != digest({k:v for k,v in packet.items() if k!='correction_hash'}):
            raise ValueError('correction_seal_changed')
        corrections.append({'path':str(path),'raw_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'count':packet['count']})
        for fix in packet['corrections']:
            index=fix['index']; old=judgments[index]
            if index in corrected_indices or fix['original_judgment_digest'] != digest(old) or fix['id'] != old['id'] or fix['review_hash'] != old['review_hash']:
                raise ValueError('correction_original_binding_changed')
            corrected_indices.add(index)
            judgments[index]={**old,**{k:fix[k] for k in ('primary','labels','uncertainty_codes','rationale_codes')}}
    rows = []
    for index, original in enumerate(inventory['examples']):
        meta = metadata[original['id']]
        prior = meta['semantic_decision']
        source = judgments[index]
        primary, labels = source['primary'], source['labels']
        uncertainty, rationale = source['uncertainty_codes'], source['rationale_codes']
        provenance = source['classification_provenance']
        if primary not in TAXONOMY or set(labels)-set(TAXONOMY):
            raise ValueError('taxonomy_unknown')
        rows.append({'index':index,'id':original['id'],'review_hash':original['review_hash'],
                     'input_hash':original['input_hash'],'target_hash':original['target_hash'],
                     'completion_tokens_with_eos':original['completion_tokens_with_eos'],
                     'prompt_tokens':original['prompt_tokens'],'primary':primary,'labels':labels,
                     'mixed_actions':len(labels)>1,'uncertainty_codes':uncertainty,'rationale_codes':rationale,
                     'classification_provenance':provenance,'prior_category':original['prior_behavior_category'],
                     'prior_semantic_decision_hash':digest(prior),'rule_primary_suggestion':original['primary'],
                     'originals_unchanged':True})
    primary_counts = Counter(r['primary'] for r in rows)
    labels = Counter(c for r in rows for c in r['labels'])
    completions = Counter()
    for r in rows:
        completions[r['primary']] += r['completion_tokens_with_eos']
    if len(rows)!=1374 or len({r['id'] for r in rows})!=1374 or sum(completions.values())!=33300:
        raise ValueError('final_approved_inventory_changed')
    packet={'schema':'source-bound-semantic-behavior-inventory-v3','examples':rows,
            'taxonomy':TAXONOMY,'example_count':len(rows),'unique_id_count':len({r['id'] for r in rows}),
            'completion_tokens_with_eos':sum(completions.values()),'prompt_tokens':sum(r['prompt_tokens'] for r in rows),
            'new_context_target_agent_judgments':len(judgments),'inherited_exact_agent_category_recode':len(rows)-len(judgments),
            'primary_counts':{k:primary_counts[k] for k in TAXONOMY},'multilabel_counts':{k:labels[k] for k in TAXONOMY},
            'primary_completion_token_counts':{k:completions[k] for k in TAXONOMY},
            'mixed_action_examples':sum(r['mixed_actions'] for r in rows),
            'uncertainty_examples':sum(bool(r['uncertainty_codes']) for r in rows),
            'mixed_primary_convention_flag_examples':sum('mixed_actions_primary_convention' in r['uncertainty_codes'] for r in rows),
            'substantive_uncertainty_or_qualification_examples':sum(bool(set(r['uncertainty_codes'])-{'mixed_actions_primary_convention'}) for r in rows),
            'uncertainty_code_counts':dict(Counter(c for r in rows for c in r['uncertainty_codes'])),
            'rule_primary_changed':sum(r['primary']!=r['rule_primary_suggestion'] for r in rows),
            'review_artifact_provenance':files,'correction_artifact_provenance':corrections,'corrected_examples':len(corrected_indices),
            'supersedes_hybrid_inventory':str(directory/'semantic-behavior-inventory.json'),
            'clarification_definition':'Established missing detail needed for current action or understanding; broad requests, consent negotiation and casual new-topic questions remain question_or_request.',
            'prior_coverage_raw_sha256':hashlib.sha256((sealed/'final-fullpool-coverage.json').read_bytes()).hexdigest(),
            'rule_inventory_hash':inventory['inventory_hash'], 'bodies_persisted':0,'token_arrays_persisted':0,
            'new_human_judgments':0,'new_semantic_all_1374_claimed':True,
            'limitations':['Target speech-act distribution only; input demand was not semantically classified for all1374.',
                           'Opinion/help includes emotional or religious support, not only substantive task help.',
                           'Narrow clarification subtype follows an explicit reviewer convention; question/request labels overlap where a target combines functions.',
                           'Primary action is a reviewer convention for mixed targets; multilabel counts overlap.',
                           'Uncertainty flags include primary-choice conventions, qualifications and unavailable media; they are not all unresolved category judgments.',
                           'New agent review used bounded original recent context, expanded when needed; retained uncertainty is explicit.',
                           'Cross-audit is a sample check by two participating reviewers, not independent human or total review.']}
    packet['inventory_hash']=digest(packet)
    return packet


if __name__=='__main__':
    directory=Path.home()/'.inboxd/reply-model/learning/behavior-audit-20261006'
    sealed=directory.parent/'granite-fullpool-20261006-v1'
    packet=combine(directory,sealed)
    write_private(directory/'semantic-behavior-inventory-final-v4.json',packet)
    import json
    print(json.dumps({k:packet[k] for k in ('example_count','completion_tokens_with_eos','new_context_target_agent_judgments','inherited_exact_agent_category_recode','primary_counts','mixed_action_examples','uncertainty_examples','rule_primary_changed')}))
