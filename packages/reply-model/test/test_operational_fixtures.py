import json
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import operational_fixtures as fixtures


class OperationalFixtureTests(unittest.TestCase):
    def test_exact_observed_four_use_structured_production_prompt(self):
        cases=fixtures.inputs()
        self.assertEqual(len(cases),4)
        for case, (identity, turns) in zip(cases,fixtures.SITUATIONS):
            self.assertEqual(case['id'],identity)
            self.assertEqual([(m['author_role'],m['body']) for m in case['context']],list(turns))
            self.assertEqual(case['input'][0]['role'],'system')
            self.assertEqual(case['preflight']['status'],'ready')
            self.assertEqual(case['preflight']['unseen_state'],'unknown')
        self.assertEqual(cases[-1]['context'][0]['body'],'그 파일은 보내지 마세요. 승인하지 않습니다.')

    def test_eight_generation_calls_are_blinded_and_privately_saved(self):
        calls=[]
        class Engine:
            def generate_text(self,prompt,**kwargs):
                calls.append(kwargs)
                return '합성 테스트 답장'
        with tempfile.TemporaryDirectory() as root:
            path=Path(fixtures.compare_operational('/model','/adapter',Path(root)/'out',engine_factory=Engine))
            report=json.loads(path.read_text())
            self.assertEqual(len(calls),8)
            self.assertEqual(sum(x['adapter_path'] is None for x in calls),4)
            self.assertTrue(all(x['max_tokens']==192 and x['temperature']==0 for x in calls))
            self.assertTrue(report['complete'])
            for case in report['cases']:
                self.assertEqual(len(case['outputs']),2)
                self.assertTrue(all('method' not in o for o in case['outputs']))
            for name in ('blind-report.json','mapping.json','metadata.json'):
                self.assertEqual((path.parent/name).stat().st_mode & 0o777,0o600)
