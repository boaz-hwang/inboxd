import pathlib
import sys
import unittest

sys.path.insert(0,str(pathlib.Path(__file__).parents[1]))
from actual_source_manifest import manifest_use_class, walk


class HistoricalExposureEvidenceTests(unittest.TestCase):
    def test_loss_evaluation_does_not_expose_staged_training_split(self):
        manifest={'mode':'evaluate','status':'complete'}
        self.assertEqual(manifest_use_class(manifest,'test'),'completed_loss_evaluation_dataset')
        self.assertEqual(manifest_use_class(manifest,'train'),'staged_unconsumed_evaluation_split')
        self.assertEqual(manifest_use_class(manifest,'valid'),'staged_unconsumed_evaluation_split')

    def test_partial_checkpoint_does_not_prove_complete_training_dataset(self):
        manifest={'mode':'train','status':'complete','iters':535,'saved_checkpoint_step':268}
        self.assertEqual(manifest_use_class(manifest,'train'),'declared_partial_or_failed_runtime_dataset')
        self.assertEqual(manifest_use_class(manifest,'test'),'heldout_declared_not_used_in_train_run')

    def test_keyed_metadata_retains_identity_for_exact_source_resolution(self):
        identity='hist:["fixture","account","room","message"]'
        records=list(walk({identity:{'source_message_keys':['["fixture","account","room","message"]']}}))
        self.assertTrue(any(row.get('id')==identity and row.get('source_message_keys') for row in records))


if __name__=='__main__':
    unittest.main()
