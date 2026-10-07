"""Transient RAM display and metadata-only explicit agent adjudication helpers."""
import argparse
import json
import re
from pathlib import Path
from behavior_audit import client, read, write_private, TAXONOMY, digest


def safe_display(value):
    if not isinstance(value, str):
        return value
    import review_sensitive
    for credential in review_sensitive.credential_values(value):
        value=value.replace(credential,'[credential_value]')
    value=re.sub(r'(?im)(\b(?:admin|administrator)\s*/\s*)\S+',r'\1[credential_value]',value)
    value=re.sub(r'(?im)((?:아이디.{0,12}(?:비번|비밀번호)|(?:비번|비밀번호).{0,12}아이디)\s*\n)[^\n]+',r'\1[credential_line]',value)
    # Display-only protection: owner source, hashes and actual training inputs
    # stay exact. Contact/account-like numbers do not aid speech-act judgment.
    value = re.sub(r'(?<!\d)(?:\d{2,6}[- ]?){2,}\d{3,8}(?!\d)', '[identifier_number]', value)
    value = re.sub(r'(?<!\d)\d{4}-\d{4}(?!\d)', '[contact_number]', value)
    value = re.sub(r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}', '[email]', value)
    return value


def show(directory, indices, *, recent=5):
    grant = read(directory / 'owner-grant.json')
    rules = read(directory / 'behavior-inventory.json')
    selected = [rules['examples'][index] for index in indices]
    cases = []
    for offset in range(0, len(selected), 20):
        subset = selected[offset:offset+20]
        packet = client(grant, {'op': 'records', 'ids': [r['id'] for r in subset], 'include_targets': True})
        for index, suggestion, case in zip(indices[offset:offset+20], subset, packet['cases']):
            record = case['record']
            cases.append({'index': index, 'prior': suggestion['prior_behavior_category'],
                          'rule': suggestion['primary'], 'rule_labels': suggestion['labels'],
                          'ambiguity': suggestion['ambiguity_codes'],
                          'context': [[m['author_role'], safe_display(m.get('body')), m.get('content_kind'), m.get('reply_to')]
                                      for m in record['context'][-recent:]],
                          'target': [safe_display(m['body']) for m in record['targets']],
                          'display_only_identifier_numbers_protected': True,
                          'reply_linkage': record.get('reply_linkage')})
    return cases


def commit(directory, name, judgments):
    inventory = read(directory / 'behavior-inventory.json')
    rows = []
    for index, primary, labels, uncertainty_codes, rationale_codes in judgments:
        if primary not in TAXONOMY or set(labels) - set(TAXONOMY) or primary not in labels:
            raise ValueError('taxonomy_labels_invalid')
        original = inventory['examples'][index]
        rows.append({'index': index, 'id': original['id'], 'review_hash': original['review_hash'],
                     'primary': primary, 'labels': labels, 'uncertainty_codes': uncertainty_codes,
                     'rationale_codes': rationale_codes, 'classification_provenance': 'new_agent_context_target_semantic_judgment',
                     'reviewer': 'agent_delegated', 'originals_unchanged': True})
    if len(set(r['index'] for r in rows)) != len(rows):
        raise ValueError('unique_judgment_indices_required')
    packet = {'schema': 'reply-behavior-agent-semantic-adjudication-v1', 'judgments': rows,
              'count': len(rows), 'inventory_hash': inventory['inventory_hash'], 'bodies_persisted': 0}
    packet['judgment_hash'] = digest(packet)
    write_private(directory / name, packet)


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--directory', type=Path, required=True)
    p.add_argument('--indices', required=True)
    p.add_argument('--recent', type=int, default=5)
    a = p.parse_args()
    print(json.dumps(show(a.directory, [int(x) for x in a.indices.split(',')], recent=a.recent), ensure_ascii=False))
