import unittest
from unittest.mock import patch
import development_selection as d

class SelectionTests(unittest.TestCase):
    def fixtures(self):
        candidates=['a','b','c','d'];rule={'suite_hash':'s','candidate_methods':candidates,'diagnostic_methods':['base'],'selection_rule_hash':'r'}
        metrics={m:dict(count=24,clear_semantic_failure_cases=0,unresolved_semantic_cases=0,usefulness_mean=4,style_mean=4) for m in candidates+['base']}
        summary={'suite_hash':'s','methods':metrics,'summary_hash':'q'}
        metadata={'development_case_count':24,'checkpoint_metadata_hash':'h','loss_measurement_kind':'reevaluated_saved_artifact','validation_set_hash':'valid', 'checkpoints':{m:dict(step=i+1,validation_loss=0.5+i/10,adapter_artifact_hash=m,loss_evaluation_hash=m+'loss') for i,m in enumerate(candidates)}}
        return summary,metadata,rule
    def select(self,values):
        with patch.object(d,'read',side_effect=values),patch.object(d,'check_seal'):
            return d.select_checkpoint('s','m','r')
    def test_quality_precedes_loss(self):
        summary,meta,rule=self.fixtures();summary['methods']['a']['clear_semantic_failure_cases']=1
        result=self.select([summary,meta,rule]);self.assertEqual(result['selected_method'],'b');self.assertEqual(result['minimum_validation_loss_method'],'a')
    def test_incomplete_candidate_cannot_be_selected(self):
        summary,meta,rule=self.fixtures();summary['methods']['c']['count']=23
        with self.assertRaisesRegex(ValueError,'incomplete'):self.select([summary,meta,rule])
    def test_uncertainty_precedes_style(self):
        summary,meta,rule=self.fixtures();summary['methods']['a'].update(unresolved_semantic_cases=1,style_mean=5)
        self.assertEqual(self.select([summary,meta,rule])['selected_method'],'b')
    def test_earlier_step_breaks_exact_quality_and_loss_tie(self):
        summary,meta,rule=self.fixtures()
        for c in meta['checkpoints'].values():c['validation_loss']=.5
        result=self.select([summary,meta,rule]);self.assertEqual(result['selected_method'],'a');self.assertEqual(len(result['exact_quality_and_loss_ties']),4)
    def test_training_log_loss_is_not_saved_artifact_loss(self):
        summary,meta,rule=self.fixtures();meta['loss_measurement_kind']='training_log_intraval'
        with self.assertRaisesRegex(ValueError,'exact_saved_artifact'):self.select([summary,meta,rule])

if __name__=='__main__':unittest.main()
