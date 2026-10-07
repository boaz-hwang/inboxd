import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch
import selected_adapter as s
from independent import seal,write_private,read
from checkpoint_dev import sha

class SelectedArtifactTests(unittest.TestCase):
    def test_winner_is_separate_immutable_and_requires_final_gate(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);source=root/'checkpoint';source.mkdir()
            header=json.dumps({'lora':{'dtype':'F32','shape':[1],'data_offsets':[0,4]}}).encode()
            (source/'adapters.safetensors').write_bytes(struct.pack('<Q',len(header))+header+struct.pack('<f',1.))
            (source/'adapter_config.json').write_text('{}');write_private(source/'manifest.json',{'status':'complete','selection_required':True})
            receipt={'adapter_path':str(source),'adapter_artifact_hash':sha(source/'adapters.safetensors'),'step':76,'validation_loss':.2}
            binding={'selection_rule_hash':'r','binding_hash':'b','method_adapters':{'checkpoint_1_v4':str(source)},'artifacts':{'checkpoint_receipts':{'checkpoint_1_v4':receipt},'base_model_identity':'base'}}
            selected=seal({'selected_method':'checkpoint_1_v4','selected_checkpoint':receipt,'selection_rule_hash':'r','minimum_validation_loss_method':'checkpoint_4_v4','activation_authorized':False,'final_outputs_seen':False},'checkpoint_selection_hash')
            write_private(root/'binding.json',binding);write_private(root/'selected.json',selected)
            with patch.object(s,'verify_binding'):
                identity=s.stage_selected(root/'selected.json',root/'binding.json',root/'winner')
            self.assertEqual(identity['file_hashes']['adapters.safetensors'],receipt['adapter_artifact_hash'])
            self.assertEqual(sha(source/'adapters.safetensors'),receipt['adapter_artifact_hash'])
            manifest=read(root/'winner/manifest.json')
            self.assertTrue(manifest['selection_required']);self.assertTrue(manifest['final_evaluation_required'])
            self.assertEqual(manifest['selection']['loss_only_winner'],'checkpoint_4_v4')
            with patch.object(s,'verify_binding'):
                with self.assertRaises(FileExistsError):s.stage_selected(root/'selected.json',root/'binding.json',root/'winner')

if __name__=='__main__':unittest.main()
