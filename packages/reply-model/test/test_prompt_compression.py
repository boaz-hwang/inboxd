import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from prompt_compression import compact_metadata, expand_metadata


class CompressionTests(unittest.TestCase):
    def test_author_time_role_reply_and_unknown_state_round_trip(self):
        original = {'turn_fields': ['message_id', 'author_role', 'author_id', 'ts', 'reply_to', 'unseen'],
            'preflight': {'reply_target_id': 2, 'unseen_state': 'unknown'},
            'turn_metadata': [
                [0, 'self', 'owner-original-id', 1700000000.125, None, None],
                [1, 'other', 'other-original-id', 1700000020.75, 0, False],
                [2, 'unknown', 'other-original-id', 1700000021.0, 1, None]]}
        unchanged = copy.deepcopy(original)
        compact = compact_metadata(original)
        self.assertEqual(expand_metadata(compact), original)
        self.assertEqual(original, unchanged)
        self.assertEqual(compact['author_ids'], ['owner-original-id', 'other-original-id'])
        self.assertEqual(compact['ts_origin'], 1700000021.0)
        self.assertIsNone(compact['turn_metadata'][2][-1])
        self.assertIs(compact['turn_metadata'][1][-1], False)

    def test_missing_time_stays_unknown_without_synthesized_offset(self):
        metadata = {'turn_fields': ['author_id', 'ts'], 'turn_metadata': [['them', None], ['self', 3]]}
        compact = compact_metadata(metadata)
        self.assertEqual(compact['ts_encoding'], 'absolute_seconds')
        self.assertNotIn('ts_origin', compact)
        self.assertEqual(expand_metadata(compact), metadata)

    def test_empty_context_round_trips(self):
        metadata = {'turn_fields': ['author_id', 'ts'], 'turn_metadata': []}
        self.assertEqual(expand_metadata(compact_metadata(metadata)), metadata)


if __name__ == '__main__':
    unittest.main()
