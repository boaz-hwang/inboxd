"""Fake-only transport/data: no RPC, real chat, tokenizer, model or final suite."""
import copy
import json
import unittest

import regression_inputs as r


def sealed_quarantine(keys=()):
    return r._sealed({'version': 1, 'source_keys': list(keys)}, 'quarantine_hash')


def fixture():
    rows, cases, entries = [], [], []
    for i in range(22):
        chat = {'platform': 'kakao' if i % 6 < 3 else 'telegram',
                'account': 'fake-owner', 'chat_id': 'fake-room-' + str(i % 6)}
        context = [{'message_id': 'fake-other-' + str(i), 'author_id': 'fake-peer',
                    'author_role': 'other', 'ts': 1000 + 10 * i, 'reply_to': None,
                    'body': 'Invented regression question ' + str(i)}]
        target = {'message_id': 'fake-target-' + str(i), 'ts': 1001 + 10 * i,
                  'body': 'Invented historical target must not enter generation ' + str(i)}
        key = r.h.source_key(chat, target['message_id'])
        row = {'id': 'hist:' + key, 'source': 'history', 'chat': chat,
               'context': context, 'targets': [target], 'timestamp': target['ts'],
               'self_identity': {'state': 'known', 'author_id': 'fake-owner'},
               'incoming_message_ids': None, 'flags': {}}
        compiled, _ = r.worker.compile_prompt(row)
        cases.append({'id': row['id'], 'source': 'heldout_reply',
                      'prompt_hash': r.old_digest(r.worker.build_generation_input(compiled)),
                      'source_hash': r.h.digest(row), 'rubric_hash': r.old_digest({'fake': i}),
                      'evaluation_group': 'heldout_chat'})
        entries.append({'id': row['id'], 'provenance_refs': [key],
                        'example_hash': r.old_digest(row)})
        rows.append(row)
    report = {'cases': cases, 'gap_policy': {'kakao': 64, 'telegram': 115}}
    report['gap_policy_hash'] = r.old_digest(report['gap_policy'])
    manifest = {'splits': {'test': entries}}
    return rows, report, manifest


class FakeOwnerQuery:
    def __init__(self, rows, omitted=(), foreign=False):
        self.rows = copy.deepcopy(rows)
        self.calls = []
        self.omitted = list(omitted)
        self.foreign = foreign

    def __call__(self, request):
        self.calls.append(copy.deepcopy(request))
        self.assert_room_only(request)
        rows = [x for x in self.rows if x['chat'] ==
                {k: request[k] for k in ('platform', 'account', 'chat_id')}]
        offset = int(request.get('cursor', '0'))
        page = rows[offset:offset + 2]
        if self.foreign and page:
            page[0]['chat']['chat_id'] = 'never-authorized-room'
        return {'candidates': copy.deepcopy(page), 'omitted': self.omitted,
                'next_cursor': str(offset + 2) if offset + 2 < len(rows) else None}

    def assert_room_only(self, request):
        assert {'platform', 'account', 'chat_id'} <= set(request)
        assert not (set(request) & {'sql', 'path', 'before', 'after', 'target_ids'})


class RegressionInputsTests(unittest.TestCase):
    def setUp(self):
        self.rows, self.report, self.manifest = fixture()
        self.q = sealed_quarantine()
        self.grant = r.build_grant(self.report, self.manifest,
                                   self.q['quarantine_hash'], 'explicit_fake_test_authorization')

    def resolve(self, rows=None, quarantine=None, grant=None, **kwargs):
        query = FakeOwnerQuery(self.rows if rows is None else rows, **kwargs)
        result = r.resolve_inputs(query, self.grant if grant is None else grant,
                                  self.q if quarantine is None else quarantine)
        return result, query

    def test_exact_original_inputs_only_and_all22_metadata(self):
        before = copy.deepcopy(self.rows)
        result, query = self.resolve()
        self.assertEqual(result['metadata']['ready_count'], 22)
        self.assertEqual(len(result['metadata']['entries']), 22)
        self.assertTrue(result['metadata']['exact_all22_reproduced'])
        self.assertFalse(result['metadata']['original_timestamp_bounds_available'])
        self.assertEqual(len(result['metadata']['reads']), 6)
        self.assertEqual(self.rows, before)
        for row in self.rows:
            messages = result['inputs'][row['id']]
            self.assertNotIn(row['targets'][0]['body'], json.dumps(messages))
            self.assertEqual(r.old_digest(messages),
                             next(e['original_prompt_hash'] for e in self.grant['entries'] if e['id'] == row['id']))
        proof = json.dumps(result['metadata'])
        self.assertNotIn('Invented regression question', proof)
        self.assertNotIn('Invented historical target', proof)
        self.assertTrue(all(q['chat_id'].startswith('fake-room-') for q in query.calls))
        r._check(result['metadata'], 'proof_hash')

    def test_changed_grant_or_quarantine_rejected_before_transport(self):
        query = FakeOwnerQuery(self.rows)
        changed = copy.deepcopy(self.grant)
        changed['room_keys'][0] = 'different'
        with self.assertRaisesRegex(ValueError, 'seal'):
            r.resolve_inputs(query, changed, self.q)
        wrong_q = sealed_quarantine([r.h.source_key(self.rows[0]['chat'], 'other-key')])
        with self.assertRaisesRegex(ValueError, 'policy_changed'):
            r.resolve_inputs(query, self.grant, wrong_q)
        self.assertEqual(query.calls, [])

    def test_original_prompt_hash_missing_is_not_guessed(self):
        self.report['cases'][0]['prompt_hash'] = None
        grant = r.build_grant(self.report, self.manifest, self.q['quarantine_hash'], 'fake')
        result, _ = self.resolve(grant=grant)
        self.assertEqual(result['metadata']['ready_count'], 21)
        self.assertEqual(result['metadata']['entries'][0]['reason'], 'original_prompt_hash_missing')

    def test_prompt_change_is_explicit_unavailable(self):
        self.rows[0]['context'][0]['body'] += ' changed'
        result, _ = self.resolve()
        entry = result['metadata']['entries'][0]
        self.assertEqual(entry['status'], 'unavailable')
        self.assertEqual(entry['reason'], 'original_prompt_hash_mismatch')
        self.assertNotEqual(entry['original_prompt_hash'], entry['current_prompt_hash'])

    def test_missing_and_omitted_target_not_silently_dropped(self):
        absent = self.rows[0]['id']
        rows = self.rows[1:]
        result, _ = self.resolve(rows=rows)
        self.assertEqual(result['metadata']['entries'][0]['reason'], 'original_target_missing')
        result, _ = self.resolve(rows=rows, omitted=[{'id': absent, 'reason': 'candidate_too_large'}])
        self.assertEqual(result['metadata']['entries'][0]['reason'], 'original_target_export_omitted')
        self.assertEqual(len(result['metadata']['entries']), 22)

    def test_exact_source_quarantine_and_pattern_target_screen(self):
        key = r.h.source_key(self.rows[0]['chat'], self.rows[0]['context'][0]['message_id'])
        quarantine = sealed_quarantine([key])
        grant = r.build_grant(self.report, self.manifest, quarantine['quarantine_hash'], 'fake')
        result, _ = self.resolve(quarantine=quarantine, grant=grant)
        self.assertEqual(result['metadata']['entries'][0]['reason'], 'quarantined_sensitive_source')
        self.assertNotIn(self.rows[0]['id'], result['inputs'])
        self.rows[1]['targets'][0]['body'] = 'password: inventedFakeValue4930'
        result, _ = self.resolve()
        self.assertEqual(result['metadata']['entries'][1]['reason'], 'quarantined_sensitive_source')
        self.assertNotIn('inventedFakeValue4930', json.dumps(result['metadata']))

    def test_target_timestamp_and_identity_are_enforced(self):
        self.rows[0]['targets'][0]['ts'] = self.rows[0]['context'][0]['ts']
        result, _ = self.resolve()
        self.assertEqual(result['metadata']['entries'][0]['reason'], 'context_target_time_boundary_invalid')
        self.rows[0]['self_identity']['state'] = 'unknown'
        self.rows[0]['targets'][0]['ts'] += 1
        result, _ = self.resolve()
        self.assertEqual(result['metadata']['entries'][0]['reason'], 'self_identity_unverified')

    def test_room_escape_is_unavailable_without_returned_bodies(self):
        result, _ = self.resolve(foreign=True)
        self.assertEqual(result['inputs'], {})
        self.assertTrue(all(e['reason'] == 'scoped_source_read_failed' for e in result['metadata']['entries']))

    def test_grouped_old_targets_are_pinned_without_current_regrouping(self):
        extra = copy.deepcopy(self.rows[0])
        extra['id'] += '-changed-group-id'
        extra['targets'][0] = {'message_id': 'fake-second-target', 'ts': 1002,
                              'body': 'Invented second historical target'}
        self.rows.append(extra)
        self.manifest['splits']['test'][0]['provenance_refs'].append(
            r.h.source_key(extra['chat'], 'fake-second-target'))
        grant = r.build_grant(self.report, self.manifest, self.q['quarantine_hash'], 'fake')
        result, _ = self.resolve(grant=grant)
        self.assertEqual(result['metadata']['ready_count'], 22)
        self.assertNotIn('Invented second historical target', json.dumps(result['inputs']))

    def test_wrong_hash_scheme_would_not_pass_original_input_proof(self):
        compiled, _ = r.worker.compile_prompt(self.rows[0])
        messages = r.worker.build_generation_input(compiled)
        self.assertNotEqual(r.old_digest(messages), r.h.digest(messages))
        self.report['cases'][0]['prompt_hash'] = r.h.digest(messages)
        grant = r.build_grant(self.report, self.manifest, self.q['quarantine_hash'], 'fake')
        result, _ = self.resolve(grant=grant)
        self.assertEqual(result['metadata']['entries'][0]['reason'], 'original_prompt_hash_mismatch')


if __name__ == '__main__':
    unittest.main()
