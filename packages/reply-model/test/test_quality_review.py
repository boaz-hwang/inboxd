import json
import contextlib
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import quality_review as q


def comparison():
    prompt = [{'role':'user','content':'상대가 앱을 만들었다고 했습니다.'}]
    rubric = {'role':'상대가 만들었다','fact':'사용한 적 없다','abstain':'답장 가능'}
    case = {'id':'hist:case','source':'heldout_reply','source_hash':'source-v1',
            'prompt_hash':q.digest(prompt),'rubric_hash':q.digest(rubric),
            'rubric':rubric,'outputs':[
                {'label':'option_1','text':'대단하시네요.','output_hash':q.digest('대단하시네요.')},
                {'label':'option_2','text':'제가 만들었어요.','output_hash':q.digest('제가 만들었어요.')}],
            'comparison_complete':True}
    report = {'report_version':2,'complete':True,'comparison_complete':True,'cases':[case],
              'rubric_bundle_hash':q.digest(q._rubric_bundle())}
    source = {'source_hash':'source-v1','prompt':prompt,'rubric':rubric}
    return report, source


def verdict():
    return {'options':{
        'option_1':{'role':'pass','fact':'pass','abstain':'pass','usefulness':5,'style':4},
        'option_2':{'role':'fail','fact':'fail','abstain':'pass','usefulness':1,'style':1}},
        'preference':'option_1'}


class BlindReviewTest(unittest.TestCase):
    def test_show_requires_current_source_prompt_rubric_and_output_hash(self):
        report, source = comparison()
        shown = q.verify_case(report,'hist:case',lambda _:source)
        self.assertEqual(shown['status'],'ready')
        self.assertEqual(shown['input'],source['prompt'])
        for changed in ({**source,'source_hash':'changed'},
                        {**source,'prompt':[{'role':'user','content':'edited'}]},
                        {**source,'rubric':{'role':'changed'}},):
            self.assertEqual(q.verify_case(report,'hist:case',lambda _, x=changed:x)['status'],'stale')
        report['cases'][0]['outputs'][0]['text']='altered'
        self.assertEqual(q.verify_case(report,'hist:case',lambda _:source)['status'],'stale')

    def test_fixed_report_policy_reconstructs_the_exact_reviewed_source(self):
        import continual
        report, source=comparison()
        report.update(report_version=3,gap_policy={'telegram':60},gap_policy_hash=q.digest({'telegram':60}))
        record={'id':'hist:case','source':'history','review_hash':'source-v1',
                'messages':source['prompt']+[{'role':'assistant','content':'original target'}],
                'eligible_for_review':True,'reasons':[]}
        with tempfile.TemporaryDirectory() as directory:
            reviews=Path(directory)/'reviews.json'
            q.private_json(reviews,{'hist:case':{'hash':'source-v1','decision':'approve'}})
            with patch.dict(sys.modules,{'mlx_lm.utils':SimpleNamespace(load_tokenizer=lambda _:object())}), \
                 patch.object(continual,'collect',return_value=([],[{'id':'omitted-send'}])), \
                 patch.object(continual,'prepare_candidates',return_value=([],[])), \
                 patch.object(q.history,'collect',return_value=([],[])), \
                 patch.object(q.history,'prepare_candidates',return_value=([record],[])) as prepare:
                candidates=q._candidate_records(report,'/unused','/unused')
                shown=q.verify_case(report,'hist:case',lambda case:q._lookup_source(case,report,
                    inboxd='/unused',model='/unused',reviews_path=reviews,candidate_records=candidates))
            self.assertEqual(shown['status'],'ready')
            self.assertEqual(prepare.call_args.kwargs['gap_policy'],{'telegram':60})
            self.assertEqual(prepare.call_args.kwargs['session_rows'],[{'id':'omitted-send'}])

    def test_malformed_or_modified_report_policy_fails_before_source_reads(self):
        report, source=comparison()
        report.update(report_version=3,gap_policy={'telegram':60},gap_policy_hash=q.digest({'telegram':60}))
        for policy in (None,[],{'telegram':True},{'telegram':float('inf')},{'telegram':64}):
            changed={**report,'gap_policy':policy}
            with self.subTest(policy=policy), patch.object(q,'_candidate_records') as reads:
                self.assertEqual(q.verify_case(changed,'hist:case',lambda _:source)['status'],'stale')
                with self.assertRaises(ValueError): q.report_gap_policy(changed)
                reads.assert_not_called()

    def test_changed_valid_policy_invalidates_prior_human_verdict(self):
        report,source=comparison()
        report.update(report_version=3,gap_policy={'telegram':60},gap_policy_hash=q.digest({'telegram':60}))
        shown=q.verify_case(report,'hist:case',lambda _:source)
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'blind.json'
            q.save_verdict(path,shown,verdict())
            saved=json.loads(path.with_name('blind-verdicts.json').read_text())
        self.assertEqual(q.status(report,saved)['reviewed_count'],1)
        report.update(gap_policy={'telegram':64},gap_policy_hash=q.digest({'telegram':64}))
        self.assertEqual(q.status(report,saved)['reviewed_count'],0)

    def test_fixture_is_loaded_from_packaged_rubric(self):
        fixture=q._rubric_bundle()['fixtures'][0]
        case={'id':fixture['id'],'source':'rubric_fixture'}
        source=q._lookup_source(case,{'rubric_bundle_hash':q.digest(q._rubric_bundle())},
                                inboxd='/unused',model='/unused',reviews_path='/unused')
        self.assertEqual(source['prompt'],fixture['messages'])
        self.assertEqual(source['source_hash'],q.digest({k:fixture[k] for k in ('id','messages','rubric')}))
        with self.assertRaisesRegex(ValueError,'stale_rubric_bundle'):
            q._lookup_source(case,{'rubric_bundle_hash':'old'},inboxd='/unused',model='/unused',reviews_path='/unused')

    def test_exact_anonymous_judgments_and_preference_required(self):
        report, source = comparison()
        shown=q.verify_case(report,'hist:case',lambda _:source)
        self.assertEqual(q.validate_verdict(shown,verdict())['preference'],'option_1')
        for bad in ({'options':{'option_1':verdict()['options']['option_1']},'preference':'option_1'},
                    {**verdict(),'preference':'base'},
                    {**verdict(),'options':{**verdict()['options'],'option_1':{**verdict()['options']['option_1'],'role':'yes'}}}):
            with self.assertRaises(ValueError):
                q.validate_verdict(shown,bad)

    def test_verdict_file_stores_only_hashes_scores_and_completes_aggregate(self):
        report, source = comparison()
        shown=q.verify_case(report,'hist:case',lambda _:source)
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'blind-review.json'
            path.write_text(json.dumps(report))
            q.save_verdict(path,shown,verdict())
            review_path=Path(directory)/'blind-review-verdicts.json'
            saved=json.loads(review_path.read_text())
            serialized=json.dumps(saved,ensure_ascii=False)
            self.assertNotIn('상대가 앱을',serialized)
            self.assertNotIn('대단하시네요',serialized)
            self.assertEqual(q.status(report,saved)['reviewed_count'],1)
            self.assertEqual(q.status(report,saved,lambda _:{'status':'stale'})['stale_review_count'],1)
            mapping={'hist:case':{'option_1':{'method':'trained'},'option_2':{'method':'base'}}}
            summary=q.summary(report,saved,mapping)
            self.assertEqual(summary['methods']['trained']['role_pass'],1)
            self.assertEqual(summary['methods']['base']['fact_fail'],1)
            self.assertEqual(summary['preferences'],{'trained':1})
            report['cases'][0]['outputs'][0]['output_hash']='changed'
            self.assertEqual(q.status(report,saved)['reviewed_count'],0)
            with self.assertRaisesRegex(ValueError,'quality_review_incomplete'):
                q.summary(report,saved,mapping)

    def test_delegated_review_requires_authorization_and_never_claims_human_review(self):
        report,source=comparison()
        shown=q.verify_case(report,'hist:case',lambda _:source)
        mapping={'hist:case':{'option_1':{'method':'trained'},'option_2':{'method':'base'}}}
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'blind.json'
            for authorization in (None, '', '   ', 123):
                with self.assertRaisesRegex(ValueError,'authorization_required'):
                    q.save_verdict(path,shown,verdict(),reviewer='agent_delegated',authorization=authorization)
            q.save_verdict(path,shown,verdict(),reviewer='agent_delegated',
                           authorization='User explicitly delegated quality judgments.')
            saved=json.loads(path.with_name('blind-verdicts.json').read_text())
            self.assertEqual(saved['cases']['hist:case']['reviewer'],'agent_delegated')
            self.assertIn('authorization',saved['cases']['hist:case'])
            state=q.summary(report,saved,mapping)
            self.assertTrue(state['quality_review_complete'])
            self.assertFalse(state['human_review_complete'])
            self.assertEqual(state['human_reviewed_count'],0)
            self.assertEqual(state['reviewer_counts']['agent_delegated'],1)
            saved['cases']['hist:case'].pop('authorization')
            self.assertFalse(q.status(report,saved)['quality_review_complete'])

    def test_legacy_verdict_remains_summarizable_without_inferred_human_provenance(self):
        report,source=comparison()
        shown=q.verify_case(report,'hist:case',lambda _:source)
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'blind.json'
            q.save_verdict(path,shown,verdict())
            saved=json.loads(path.with_name('blind-verdicts.json').read_text())
        self.assertTrue(q.status(report,saved)['human_review_complete'])
        saved['cases']['hist:case'].pop('reviewer')
        state=q.summary(report,saved,{'hist:case':{'option_1':{'method':'trained'},'option_2':{'method':'base'}}})
        self.assertTrue(state['quality_review_complete'])
        self.assertFalse(state['human_review_complete'])
        self.assertEqual(state['legacy_unknown_reviewed_count'],1)

    def test_fixture_cli_show_review_and_summary_without_provider(self):
        fixture = q._rubric_bundle()['fixtures'][0]
        output = '답장을 해볼게요.'
        case = {'id':fixture['id'],'source':'rubric_fixture',
                'source_hash':q.digest({k:fixture[k] for k in ('id','messages','rubric')}),
                'prompt_hash':q.digest(fixture['messages']),
                'rubric_hash':q.digest(fixture['rubric']), 'rubric':fixture['rubric'],
                'outputs':[{'label':'option_1','text':output,'output_hash':q.digest(output)}],
                'comparison_complete':True}
        report={'report_version':2,'complete':True,'comparison_complete':True,'cases':[case],
                'rubric_bundle_hash':q.digest(q._rubric_bundle())}
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'blind-review.json'
            q.private_json(path,report)
            q.private_json(path.with_name('blind-review-unblind.json'),
                           {fixture['id']:{'option_1':{'method':'base'}}})
            submission=Path(directory)/'judgment.json'
            submission.write_text(json.dumps({'options':{'option_1':{
                'role':'pass','fact':'pass','abstain':'pass','usefulness':4,'style':4}},
                'preference':'option_1'}))
            stream=io.StringIO()
            with contextlib.redirect_stdout(stream):
                q.main(['show','--report',str(path),'--id',fixture['id']])
            self.assertEqual(json.loads(stream.getvalue())['input'],fixture['messages'])
            stream=io.StringIO()
            with contextlib.redirect_stdout(stream):
                q.main(['review','--report',str(path),'--id',fixture['id'],
                        '--verdict-file',str(submission),'--reviewer','agent_delegated',
                        '--authorization','User explicitly delegated all judgments.'])
            self.assertEqual(json.loads(stream.getvalue())['status'],'reviewed')
            stream=io.StringIO()
            with contextlib.redirect_stdout(stream):
                q.main(['summary','--report',str(path)])
            result=json.loads(stream.getvalue())
            self.assertEqual(result['preferences'],{'base':1})
            self.assertTrue(result['quality_review_complete'])
            self.assertFalse(result['human_review_complete'])
            self.assertEqual(result['agent_delegated_reviewed_count'],1)


if __name__=='__main__':
    unittest.main()
