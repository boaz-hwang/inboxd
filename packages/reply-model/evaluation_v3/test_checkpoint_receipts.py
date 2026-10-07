import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch
import checkpoint_dev as d
from independent import seal,write_private
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import personalization as producer

def producer_seal(value,key):
    return {**value,key:producer.digest(value)}

class ReceiptTests(unittest.TestCase):
    def tensor(self,path,dtype,value):
        body=struct.pack('<f',value) if dtype=='F32' else struct.pack('<H',value)
        header=json.dumps({'lora':{'dtype':dtype,'shape':[1],'data_offsets':[0,len(body)]}}).encode()
        path.write_bytes(struct.pack('<Q',len(header))+header+body)
    def test_finite_and_nonfinite_f32_and_bfloat16(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'adapter'
            self.tensor(path,'F32',1.)
            self.assertTrue(d.finite_adapter(path)['all_parameters_finite'])
            self.tensor(path,'F32',float('nan'))
            with self.assertRaisesRegex(ValueError,'nonfinite'):d.finite_adapter(path)
            self.tensor(path,'BF16',0x3f80)
            self.assertTrue(d.finite_adapter(path)['all_parameters_finite'])
            self.tensor(path,'BF16',0x7f80)
            with self.assertRaisesRegex(ValueError,'nonfinite'):d.finite_adapter(path)
    def test_receipt_uses_numbered_artifact_when_alias_overwritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'adapter_config.json').write_text('{}');alias=root/'adapters.safetensors';alias.write_bytes(b'overwritten')
            receipts=[]
            for step in range(1,5):
                weight=root/f'{step:07d}_adapters.safetensors';weight.write_bytes(str(step).encode())
                resource=root/f'resources-{step}.json';write_private(resource,{'status':'complete'})
                c={'checkpoint_iteration':step,'artifact_path':str(alias if step==1 else weight),'artifact_sha256':d.sha(weight),'validation_loss':.2+step/10,'loss_precision':'mlx_lm_three_decimal_log','validation_records_hash':'records','validation_assignments_hash':'assigned','final_test_records_supplied':0,'base_model_id':'base','resource_report_path':str(resource),'resource_report_sha256':d.sha(resource)}
                receipts.append(producer_seal(c,'loss_evaluation_hash'))
            ledger=producer_seal({'status':'complete','final_test_records_supplied':0,'validation_records_hash':'records','validation_assignments_hash':'assigned','evaluations':receipts},'ledger_hash')
            write_private(root/'ledger.json',ledger);write_private(root/'completion.json',{'status':'awaiting_independent_evaluation','plan_hash':'plan','final_test_records_supplied':0,'activation_performed':False,'checkpoint_selection':{'checkpoint_validation_ledger':str((root/'ledger.json').resolve()),'checkpoint_validation_ledger_sha256':d.sha(root/'ledger.json')}})
            with patch.object(d,'model_identity',return_value='base'):
                metadata=d.metadata_from_ledger(root/'ledger.json',root/'completion.json','plan',root)
            first=metadata['checkpoint_methods']['checkpoint_1_v4']
            self.assertEqual(first['weights_path'],str((root/'0000001_adapters.safetensors').resolve()))
            self.assertEqual(first['adapter_artifact_hash'],d.sha(root/'0000001_adapters.safetensors'))
    def test_duplicate_saved_steps_are_rejected(self):
        metadata=seal({'training_complete':True,'loss_measurement_kind':'reevaluated_saved_artifact','validation_set_hash':'v','training_plan_hash':'p','checkpoint_methods':{m:{'step':1,'adapter_artifact_hash':'h','loss_evaluation_hash':'l','validation_loss':.2} for m in ['a','b']}},'artifacts_hash')
        with self.assertRaisesRegex(ValueError,'unique_saved_steps'):d.validate_artifact_metadata(metadata,['a','b'])
    def test_completed_plan_cannot_bind_an_unrelated_ledger(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            write_private(root/'ledger.json',producer_seal({'status':'complete','final_test_records_supplied':0,'evaluations':[]},'ledger_hash'))
            write_private(root/'completion.json',{'status':'awaiting_independent_evaluation','plan_hash':'plan','final_test_records_supplied':0,'activation_performed':False,'checkpoint_selection':{'checkpoint_validation_ledger':str((root/'ledger.json').resolve()),'checkpoint_validation_ledger_sha256':'different'}})
            with self.assertRaisesRegex(ValueError,'completion_exact_ledger_binding'):
                d.metadata_from_ledger(root/'ledger.json',root/'completion.json','plan',root)

    def test_actual_producer_digest_and_wrong_compact_protocol(self):
        payload = {'version':'checkpoint-validation-receipts-v1','evaluations':[{'label':'검증'}]}
        actual = producer_seal(payload,'ledger_hash')
        d.check_producer_digest(actual,'ledger_hash')
        wrong = seal(payload,'ledger_hash')
        self.assertNotEqual(actual['ledger_hash'],wrong['ledger_hash'])
        with self.assertRaisesRegex(ValueError,'producer_digest_protocol_mismatch'):
            d.check_producer_digest(wrong,'ledger_hash')
        d.check_producer_digest(producer_seal({'checkpoint_iteration':76,'validation_loss':.25},'loss_evaluation_hash'),'loss_evaluation_hash')

if __name__=='__main__':unittest.main()
