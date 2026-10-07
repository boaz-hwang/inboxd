from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import real_gate as g
from independent import seal,digest,write_private,read,GENERATION_POLICY


def judgments(base_use=3,candidate_use=4,candidate_style=4):
    verdicts={};mapping={}
    for i in range(48):
        options={}
        for label,use,style in [('base',base_use,4),('candidate',candidate_use,candidate_style),('prior',5,5)]:
            options[label]={'role':'pass','fact':'pass','consent':'pass','response':'pass',
                'usefulness':use,'style':style,'reason':'fake evidence','output_hash':digest('fake '+label)}
        verdicts[str(i)]={'options':options,'preference':[['prior'],['candidate'],['base']]}
        mapping[str(i)]={label:{'method':method} for label,method in
            [('base','production_base_v4'),('candidate','adapter_v4'),('prior','prior_adapter_v4')]}
    return verdicts,mapping


class RealGateTests(unittest.TestCase):
    def test_prior_better_does_not_add_gate(self):
        v,m=judgments();result=g.calculate(v,m)
        self.assertEqual(result['gate'],'pass')
        self.assertEqual(result['paired']['prior_adapter_v4']['losses'],48)
        self.assertEqual(result['gating_comparators'],['production_base_v4'])
        self.assertFalse(result['activation_authorized'])

    def test_style_only_gain_is_insufficient(self):
        v,m=judgments(4,4,5)
        result=g.calculate(v,m)
        self.assertEqual(result['gate'],'hold')
        self.assertIn('no_meaningful_real_behavior_gain_vs_base',result['gate_reasons'])

    def test_semantic_case_reduction_and_exact_five_net_wins(self):
        v,m=judgments(4,4)
        for i in range(48):v[str(i)]['preference']=[['prior'],['candidate','base']]
        for i in range(5):v[str(i)]['preference']=[['prior'],['candidate'],['base']]
        for i in range(2):v[str(i)]['options']['base']['fact']='fail'
        result=g.calculate(v,m)
        self.assertEqual(result['gate'],'pass')
        self.assertEqual(result['paired']['production_base_v4']['net_wins'],5)
        v['4']['preference']=[['prior'],['candidate','base']]
        self.assertIn('base_paired_net_wins_below5',g.calculate(v,m)['gate_reasons'])

    def test_two_dimensions_in_one_case_are_one_failure_case(self):
        v,m=judgments(4,4)
        v['0']['options']['base'].update(role='fail',fact='fail')
        result=g.calculate(v,m)
        self.assertEqual(result['paired']['production_base_v4']['clear_semantic_failure_case_reduction'],1)
        self.assertEqual(result['gate'],'hold')

    def test_failure_uncertainty_and_floors(self):
        for field,value,expected in [('fact','fail','reject'),('consent','uncertain','hold')]:
            v,m=judgments();v['0']['options']['candidate'][field]=value
            self.assertEqual(g.calculate(v,m)['gate'],expected)
        v,m=judgments(3,5);v['0']['options']['candidate']['usefulness']=2
        self.assertIn('candidate_case_usefulness_below3',g.calculate(v,m)['gate_reasons'])
        v,m=judgments(2,3)
        self.assertIn('candidate_mean_usefulness_below4',g.calculate(v,m)['gate_reasons'])
        v,m=judgments(3,4,3)
        self.assertIn('candidate_mean_style_below3_5',g.calculate(v,m)['gate_reasons'])

    def test_usefulness_regression_blocks_semantic_gain(self):
        v,m=judgments(5,4)
        for i in range(2):v[str(i)]['options']['base']['fact']='fail'
        self.assertIn('usefulness_regresses_vs_production_base_v4',g.calculate(v,m)['gate_reasons'])

    def test_exact48_and_distinct_methods(self):
        v,m=judgments();del v['0']
        with self.assertRaisesRegex(ValueError,'exact48'):g.calculate(v,m)
        v,m=judgments();m['0']['prior']['method']='adapter_v4'
        with self.assertRaisesRegex(ValueError,'three_method'):g.calculate(v,m)

    def fixture_files(self,root):
        protocol=seal({'description':'fake independent protocol'},'protocol_hash')
        cases=[]
        for i in range(48):
            request={'id':str(i)};rubric={'allowed':['fake grounded reply']}
            inputs={m:[{'role':'user','content':'fake input '+str(i)}] for m in g.controller.METHODS}
            cases.append({'id':str(i),'request':request,'rubric':rubric,
                'request_hash':digest(request),'rubric_hash':digest(rubric),
                'inputs':inputs,'input_hashes':{m:digest(v) for m,v in inputs.items()}})
        suite=seal({'split':'sealed_final_real','case_count':48,'compilers':{m:{} for m in g.controller.METHODS},
            'candidate':'adapter_v4','comparators':['production_base_v4','prior_adapter_v4'],
            'cases':cases,'generation_policy':GENERATION_POLICY,
            'evaluation_helper_sha256':g.sha(Path(g.__file__).with_name('independent.py')),
            'raw_hash':g.controller.ADMISSION_HASH,'policy':{'protocol_hash':protocol['protocol_hash']}},'suite_hash')
        v,m=judgments();mapping=seal({'suite_hash':suite['suite_hash'],'mapping':m},'mapping_hash')
        write_private(root/'report-unblind.json',mapping)
        binding=seal({'output':str(root.resolve()),'suite_hashes':{'real':suite['suite_hash'],'synthetic':'synthetic-suite'},'gating_comparators':['production_base_v4'],
            'diagnostic_comparators':['prior_adapter_v4'],'artifacts':{'helper_fingerprints':{'real_gate.py':g.sha(g.__file__)}},
            'selected_identity_hash':'selected','candidate_weight_sha256':'candidate','prior_weight_sha256':'prior'},'run_hash')
        report=seal({'suite_hash':suite['suite_hash'],'case_count':48,
            'cases':[{'id':str(i),'outputs':[{'label':label,'text':'fake '+label,'output_hash':digest('fake '+label)}
                 for label in ('base','candidate','prior')]} for i in range(48)],
            'generation_artifacts':{'frozen_artifacts':{'final_run_hash':binding['run_hash'],
                'selected_identity_hash':'selected','candidate_weight_sha256':'candidate','prior_weight_sha256':'prior'}},
            'generation_settings':{'temperature':0.,'enable_thinking':False,'max_tokens':192,'max_input_tokens':3904},
            'mapping_file_sha256':g.sha(root/'report-unblind.json')},'report_hash')
        for name,value in [('suite',suite),('report',report),('binding',binding),('protocol',protocol)]:
            write_private(root/(name+'.json'),value)
        outputs=seal({'run_hash':binding['run_hash'],'suite_hashes':binding['suite_hashes'],
            'report_hashes':{'real':report['report_hash'],'synthetic':'synthetic-report'}},'outputs_hash')
        write_private(root/'outputs-complete.json',outputs)
        write_private(root/'completion.json',seal({'status':'awaiting_independent_blind_final_review',
            'run_hash':binding['run_hash'],'outputs_hash':outputs['outputs_hash'],
            'daemon_restored_and_readiness_verified':True,'activation_performed':False},'completion_hash'))
        write_private(root/'final-resources.json',{'status':'complete'})
        write_private(root/'judgments.json',{'reviewer':'agent_delegated','mapping_seen_before_freeze':False,'cases':v})
        return protocol

    def test_blind_freeze_then_complete_summary_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);protocol=self.fixture_files(root)
            kwargs={'binding_path':root/'binding.json','protocol_path':root/'protocol.json'}
            original=g.read;seen=[]
            def tracked(path):
                seen.append(Path(path).name);return original(path)
            with patch.object(g.controller,'REAL_PROTOCOL_HASH',protocol['protocol_hash']),patch.object(g,'read',side_effect=tracked):
                g.freeze_real(root/'suite.json',root/'report.json',root/'judgments.json',root/'verdicts.json',**kwargs)
                self.assertNotIn('report-unblind.json',seen)
                result=g.summarize_real(root/'suite.json',root/'report.json',root/'verdicts.json',root/'summary.json',**kwargs)
                self.assertEqual(result['gate'],'pass');self.assertIn('report-unblind.json',seen)
                with self.assertRaisesRegex(ValueError,'no_overwrite'):
                    g.summarize_real(root/'suite.json',root/'report.json',root/'verdicts.json',root/'summary.json',**kwargs)

    def test_incomplete_verdicts_rejected_before_mapping_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);protocol=self.fixture_files(root)
            kwargs={'binding_path':root/'binding.json','protocol_path':root/'protocol.json'}
            with patch.object(g.controller,'REAL_PROTOCOL_HASH',protocol['protocol_hash']):
                g.freeze_real(root/'suite.json',root/'report.json',root/'judgments.json',root/'verdicts.json',**kwargs)
                v=read(root/'verdicts.json');del v['cases']['0']
                v=seal({k:value for k,value in v.items() if k!='verdict_hash'},'verdict_hash')
                write_private(root/'incomplete.json',v)
                original=g.read;seen=[]
                def tracked(path):seen.append(Path(path).name);return original(path)
                with patch.object(g,'read',side_effect=tracked):
                    with self.assertRaisesRegex(ValueError,'before_unblind'):
                        g.summarize_real(root/'suite.json',root/'report.json',root/'incomplete.json',root/'summary.json',**kwargs)
                self.assertNotIn('report-unblind.json',seen)

    def test_changed_mapping_file_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);protocol=self.fixture_files(root)
            kwargs={'binding_path':root/'binding.json','protocol_path':root/'protocol.json'}
            with patch.object(g.controller,'REAL_PROTOCOL_HASH',protocol['protocol_hash']):
                g.freeze_real(root/'suite.json',root/'report.json',root/'judgments.json',root/'verdicts.json',**kwargs)
                (root/'report-unblind.json').write_text('{}')
                with self.assertRaisesRegex(ValueError,'mapping_file_changed'):
                    g.summarize_real(root/'suite.json',root/'report.json',root/'verdicts.json',root/'summary.json',**kwargs)

    def test_failed_guarded_run_cannot_enter_review(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);protocol=self.fixture_files(root)
            write_private(root/'failure.json',{'status':'hold'})
            with patch.object(g.controller,'REAL_PROTOCOL_HASH',protocol['protocol_hash']):
                with self.assertRaisesRegex(ValueError,'successful_complete_final_run'):
                    g.freeze_real(root/'suite.json',root/'report.json',root/'judgments.json',root/'verdicts.json',
                        binding_path=root/'binding.json',protocol_path=root/'protocol.json')


if __name__=='__main__':unittest.main()
