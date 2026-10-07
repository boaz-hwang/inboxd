import copy
import unittest
from collection_evidence_verify import verify_source_assertions,verify_collection_summary

class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.room='["kakao","owner","room",""]'
        self.identifier='hist:["kakao","owner","room","msg"]'
        self.inventory={'entries':[{'id':self.identifier,'chat':self.room}]}
        self.ledger={'actual_used_rooms':[],'uncertain_runtime_rooms':[],
                     'actual_or_runtime_missing_source_rooms':[],
                     'prior_assessed_missing_full_source_rooms':[self.room]}
        self.rows=[{'id':self.identifier,'actual_used_room':False,'unresolved_lineage_relevant_to_case':True}]

    def test_reviewed_source_gap_does_not_mean_actual_model_use(self):
        self.assertEqual(verify_source_assertions(self.rows,self.inventory,self.ledger),1)

    def test_false_case_membership_claim_rejected(self):
        bad=copy.deepcopy(self.rows);bad[0]['unresolved_lineage_relevant_to_case']=False
        with self.assertRaisesRegex(ValueError,'membership'):
            verify_source_assertions(bad,self.inventory,self.ledger)

    def test_actual_missing_outside_actual_room_union_rejected(self):
        bad=copy.deepcopy(self.ledger);bad['actual_or_runtime_missing_source_rooms']=[self.room]
        with self.assertRaisesRegex(ValueError,'outside'):
            verify_source_assertions(self.rows,self.inventory,bad)

    def test_room_alias_mismatch_rejected(self):
        bad=copy.deepcopy(self.inventory);bad['entries'][0]['chat']='["kakao","alias","room",""]'
        with self.assertRaisesRegex(ValueError,'disagree'):
            verify_source_assertions(self.rows,bad,self.ledger)

    def test_manual_sum_typo_rejected(self):
        receipt={'kakao':{'new_records_selected':6,'existing_live_baseline_count':43199},
                 'telegram':[{'page_count':4,'message_count':120},{'page_count':2,'message_count':1}]}
        summary={'kakao_imported_absent_records':6,'kakao_existing_baseline_count':43199,
                 'telegram_pages_read':6,'telegram_unique_records_per_room_read':121}
        verify_collection_summary(summary,receipt)
        summary['telegram_unique_records_per_room_read']=221
        with self.assertRaisesRegex(ValueError,'count'):
            verify_collection_summary(summary,receipt)

if __name__=='__main__':unittest.main()
