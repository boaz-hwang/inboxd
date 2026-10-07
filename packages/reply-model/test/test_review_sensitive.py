import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import history
from review_sensitive import (SensitiveReviewProxy,credential_rules,credential_values,sensitive_source_evidence,
                              sensitive_admission_report,assert_no_sensitive_sources)


class SensitiveTests(unittest.TestCase):
    def case(self,body='safe message'):
        return {'id':'synthetic:isolated-credential-fixture','review_hash':'hash',
                'chat':{'platform':'kakao','account':'synthetic','chat_id':'fixture'},
                'context':[{'message_id':'source','body':body}],'targets':[{'message_id':'target','body':'hello'}]}

    def quarantine(self,keys=()):
        value={'version':'fixture','source_keys':list(keys),'values_retained':False}
        return {**value,'quarantine_hash':history.digest(value)}

    def test_actual_values_match_but_keyword_discussion_and_placeholders_do_not(self):
        for body in ('비밀번호: synthetic-value-42','비번은 synthetic-value-42 입니다','synthetic-value-42 (비밀번호)','password is synthetic-value-42',
                     'https://example.invalid/join?pwd=synthetic-access-42',
                     'https://example.invalid/download?accessKey=synthetic-access-42',
                     '비밀번호 : 합성암호4! 추가 설명',
                     '<https://example.invalid/download?token=synthetic-access-token-42|다운로드>',
                     'PIN: 987 654 321#',
                     '입장코드 : 987654',
                     'passcode: synthetic-pass-42',
                     'https://tel.meet.example.invalid/synthetic?pin=987654321',
                     'Bearer synthetic-access-token-42'):
            self.assertTrue(credential_rules(body))
        for body in ('password reset guidance','비밀번호 변경 방법이 궁금합니다',
                     'password: YOUR_PASSWORD','https://example.invalid/?pwd=<password>',
                     'https://example.invalid/?pwd=%3Cpassword%3E'):
            self.assertEqual(credential_rules(body),[])

    def test_repeated_known_values_and_messages_only_synthetic_targets_fail_closed(self):
        labeled=self.case('비밀번호 : 합성암호4!');values=credential_values(labeled['context'][0]['body'])
        repeated=self.case('합성암호4!')
        self.assertEqual(list(sensitive_source_evidence([repeated],known_values=values).values()),
                         [['repeated_known_credential_value']])
        self.assertNotIn('합성암호4!',json.dumps(sensitive_source_evidence([repeated],known_values=values)))
        synthetic={'id':'synthetic:messages-only','review_hash':'hash','chat':{},
                   'messages':[{'role':'assistant','content':'password: synthetic-value-42'}]}
        kept,excluded=sensitive_admission_report([synthetic],self.quarantine())
        self.assertEqual(kept,[])
        self.assertEqual(excluded[0]['source_keys'],[])
        self.assertTrue(excluded[0]['message_rules'])

    def test_known_source_intersection_and_actual_value_are_mandatory_admission_exclusions(self):
        case=self.case();key=history.source_key(case['chat'],'source')
        kept,excluded=sensitive_admission_report([case],self.quarantine([key]))
        self.assertEqual(kept,[])
        self.assertEqual(excluded[0]['reason'],'sensitive_credential_context')
        with self.assertRaisesRegex(ValueError,'admitted_record'):
            assert_no_sensitive_sources([case],self.quarantine([key]))
        secret=self.case('password: synthetic-value-42')
        evidence=sensitive_source_evidence([secret])
        self.assertNotIn('synthetic-value-42',json.dumps(evidence))
        self.assertEqual(sensitive_admission_report([secret],self.quarantine())[0],[])
        with self.assertRaisesRegex(ValueError,'hash_mismatch'):
            sensitive_admission_report([case],dict(self.quarantine(),values_retained=True))

    def test_scoped_proxy_passes_originals_or_metadata_only_never_masked_approval(self):
        case=self.case('password: synthetic-value-42');before=copy.deepcopy(case)
        grant={'split':'train','snapshot_hash':'snapshot','shard_index':0,'shard_hash':'shard',
               'entries':[{'id':case['id'],'hash':'hash'}]}
        grant['grant_hash']=history.digest(grant)
        request={'shard_index':0,'shard_hash':'shard','entries':grant['entries']}
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary)/'quarantine.json';path.write_text(json.dumps(self.quarantine()))
            proxy=SensitiveReviewProxy(grant,path)
            response={'split':'train','snapshot_hash':'snapshot','cases':[case]}
            with patch('review_sensitive.original_packet',return_value=response):
                packet=json.loads(proxy.packet(request))
                self.assertFalse(packet['cases'][0]['approvable'])
                self.assertNotIn('synthetic-value-42',json.dumps(packet))
                self.assertEqual(case,before)
                case['context'][0]['body']='safe message'
                self.assertEqual(json.loads(proxy.packet(request))['cases'][0],case)
                with self.assertRaises(ValueError):proxy.packet(dict(request,shard_hash='other'))
                with self.assertRaises(ValueError):proxy.packet(dict(request,entries=['invalid']))


if __name__=='__main__':unittest.main()
