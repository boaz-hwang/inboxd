import copy
import sys
from pathlib import Path
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import history

class PersistenceTests(unittest.TestCase):
    def test_additive_exact_budget_variants_preserve_prior_and_reject_stale(self):
        old={'hist:source':{'hash':'old-2k','decision':'approve','acknowledged_reasons':[],'review_provenance':'agent_delegated'}}
        previous=copy.deepcopy(old)
        new={'hist:source':{'hash':'new-4k','decision':'hold','acknowledged_reasons':[],'review_provenance':'agent_delegated'},'new':{'hash':'new-2k','decision':'approve','acknowledged_reasons':[]}}
        merged=history.merge_review_registry(old,new)
        self.assertEqual(old,previous)
        self.assertEqual({k:v for k,v in merged['hist:source'].items() if k!='review_variants'},previous['hist:source'])
        self.assertEqual(history.review_for_hash(merged,'hist:source','new-4k')['decision'],'hold')
        self.assertEqual(history.review_for_hash(merged,'hist:source','stale'),{})
        record={'id':'hist:source','eligible_for_review':True,'reasons':[],'review_hash':'new-4k'}
        self.assertEqual(history.reviewed_records([record],merged),[])
        record['review_hash']='old-2k'
        self.assertEqual(history.reviewed_records([record],merged)[0]['reviewed'],True)
        self.assertEqual(history.merge_review_registry(merged,new),merged)
        with self.assertRaisesRegex(ValueError,'conflicting_exact_hash'):
            history.merge_review_registry(merged,{'hist:source':dict(new['hist:source'],decision='approve')})

if __name__=='__main__':unittest.main()
