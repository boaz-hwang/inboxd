"""Verify body-free collection claims against their canonical source ledgers."""
import json
from pathlib import Path

def verify_source_assertions(rows, inventory, ledger):
    candidates={e['id']:e for e in inventory['entries']}
    actual=set(ledger['actual_used_rooms'])|set(ledger['uncertain_runtime_rooms'])
    missing=set(ledger['actual_or_runtime_missing_source_rooms'])|set(ledger['prior_assessed_missing_full_source_rooms'])
    if not set(ledger['actual_or_runtime_missing_source_rooms'])<=actual:
        raise ValueError('actual_missing_room_outside_actual_use_scope')
    for row in rows:
        candidate=candidates[row['id']]
        room=candidate['chat']
        parts=json.loads(room)
        if len(parts)!=4 or parts[-1]!='':
            raise ValueError('noncanonical_room_identity')
        if json.loads(candidate['id'][5:])[:3]!=parts[:3]:
            raise ValueError('candidate_id_and_room_disagree')
        expected={'actual_used_room':room in actual,
                  'unresolved_lineage_relevant_to_case':room in missing}
        for key,value in expected.items():
            if row.get(key) is not value:
                raise ValueError('case_membership_assertion_disagrees_with_ledger')
    return len(rows)

def verify_collection_summary(summary, receipt):
    expected={'kakao_imported_absent_records':receipt['kakao']['new_records_selected'],
              'kakao_existing_baseline_count':receipt['kakao']['existing_live_baseline_count'],
              'telegram_pages_read':sum(x['page_count'] for x in receipt['telegram']),
              'telegram_unique_records_per_room_read':sum(x['message_count'] for x in receipt['telegram'])}
    if any(summary.get(k)!=v for k,v in expected.items()):
        raise ValueError('summary_count_disagrees_with_canonical_receipt')

def main(root):
    def read(name):return json.loads((root/name).read_text())
    n=verify_source_assertions(read('primary-source-disjointness-receipt.json')['entries'],
                             read('primary-context-inventory.json'),read('source-exposure-axis-ledger-v2.json'))
    verify_collection_summary(read('collection-summary.json'),read('additional-collection-receipt.json'))
    print(json.dumps({'source_cases_verified':n,'collection_counts_verified':True}))

if __name__=='__main__':
    import argparse
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('root',type=Path)
    main(p.parse_args().root)
