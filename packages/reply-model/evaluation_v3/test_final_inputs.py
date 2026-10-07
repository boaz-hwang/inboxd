import json
import unittest
from unittest.mock import patch
import final_inputs as f
from independent import digest,seal

class Socket:
    def __init__(self,packet):self.data=json.dumps(packet).encode()+b'\n'
    def __enter__(self):return self
    def __exit__(self,*args):pass
    def settimeout(self,*args):pass
    def connect(self,*args):pass
    def sendall(self,*args):pass
    def recv(self,*args):data,self.data=self.data,b'';return data

class InputBoundaryTests(unittest.TestCase):
    def fixtures(self):
        context=[{'body':'Synthetic preceding context'}];targets=[{'body':'Synthetic historical target'}]
        messages=[{'role':'user','content':'Request'},{'role':'assistant','content':'Historical target must stay out'}]
        e={'id':'case','hash':'record','chat':'room','raw_content_hash':digest({'context':context,'targets':targets}),'input_hash':digest(messages[:-1]),'target_hash':digest(messages[-1:])}
        a=seal({'allowlist_hash':'a','selection_freeze_hash':'s','snapshot_hash':'snap','latest_quarantine_hash':'q','entries':[e]},'admission_hash')
        g=seal({'split':'test','selected_allowlist_hash':'a','selection_freeze_hash':'s','snapshot_hash':'snap','quarantine_hash':'q','historical_targets_model_input':False,'model_input_field':'messages[:-1]','count':1,'entries':[{k:e[k] for k in ['id','hash','chat']}],'max_batch':10,'shard_index':0,'shard_hash':'h','socket_path':'socket','max_response_bytes':50000},'grant_hash')
        p={'split':'test','snapshot_hash':'snap','cases':[{'id':'case','review_hash':'record','context':context,'targets':targets,'messages':messages}]}
        return g,a,p
    def test_target_is_verified_but_never_returned(self):
        g,a,p=self.fixtures()
        with patch.object(f,'read',side_effect=[g,a]),patch.object(f.socket,'socket',return_value=Socket(p)):
            inputs=f.fetch_inputs('review-grant-final48-only.json','admission')
        self.assertEqual(inputs,{'case':[{'role':'user','content':'Request'}]})
    def test_changed_historical_target_is_rejected(self):
        g,a,p=self.fixtures();p['cases'][0]['messages'][-1]['content']='changed'
        with patch.object(f,'read',side_effect=[g,a]),patch.object(f.socket,'socket',return_value=Socket(p)):
            with self.assertRaisesRegex(ValueError,'source_hash_mismatch'):f.fetch_inputs('review-grant-final48-only.json','admission')
    def test_unscoped_grant_rejected_before_read(self):
        with patch.object(f,'read') as read:
            with self.assertRaisesRegex(ValueError,'before_read'):f.fetch_inputs('review-grant-train-0.json','admission')
            read.assert_not_called()

if __name__=='__main__':unittest.main()
