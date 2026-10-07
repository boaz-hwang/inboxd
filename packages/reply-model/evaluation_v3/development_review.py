"""Split only development outputs into two sealed, case-disjoint blind packets."""
from pathlib import Path

from checkpoint_dev import dev_suite
from independent import (review_view, read, check_seal, seal, now, write_private,
                         freeze_verdicts, summarize)


def prepare_packets(suite_path, report_path, output):
    dev_suite(suite_path)  # Reject a final filename before reading any suite.
    suite, report, views = review_view(suite_path, report_path)
    if len(views) != 24:
        raise ValueError('frozen_development_twenty_four_required')
    output = Path(output)
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    packets = []
    for name, reviewer, cases in [('root', '/root', views[:12]),
                                  ('dataset', '/root/dataset_expansion', views[12:])]:
        packet = seal({'schema': 'blind-development-review-packet-v1',
            'frozen_at_utc': now(), 'suite_hash': suite['suite_hash'],
            'report_hash': report['report_hash'], 'assigned_reviewer': reviewer,
            'reviewer_class': 'agent_delegated', 'development_only': True,
            'baseline_previously_observed': True, 'mapping_included': False,
            'case_count': len(cases), 'cases': cases,
            'instructions': 'Judge all five options on role/fact/consent/response and usefulness/style1–5; rank preference tiers allowing ties. Freeze all judgments before mapping access.'},
            'packet_hash')
        write_private(output / (name + '-packet.json'), packet)
        template = {'reviewer': 'agent_delegated', 'assigned_reviewer': reviewer,
            'packet_hash': packet['packet_hash'], 'mapping_seen_before_freeze': False,
            'cases': {c['id']: {'options': {o['label']: {'output_hash': o['output_hash'],
                'role': None, 'fact': None, 'consent': None, 'response': None,
                'usefulness': None, 'style': None, 'reason': ''} for o in c['outputs']},
                'preference': []} for c in cases}}
        write_private(output / (name + '-judgments-template.json'), template)
        packets.append({'reviewer': reviewer, 'case_count': len(cases),
                        'packet_hash': packet['packet_hash']})
    return {'suite_hash': suite['suite_hash'], 'report_hash': report['report_hash'],
            'packets': packets, 'mapping_read': False}


def merge_and_freeze(suite_path, report_path, root_packet_path, dataset_packet_path,
                     root_judgments_path, dataset_judgments_path, output):
    suite = dev_suite(suite_path)
    merged = {}
    hashes = []
    for owner, packet_path, judgments_path in [('/root', root_packet_path, root_judgments_path),
            ('/root/dataset_expansion', dataset_packet_path, dataset_judgments_path)]:
        packet, judgments = read(packet_path), read(judgments_path)
        check_seal(packet, 'packet_hash')
        if (packet['suite_hash'] != suite['suite_hash']
                or packet['assigned_reviewer'] != owner
                or judgments.get('assigned_reviewer') != owner
                or judgments.get('reviewer') != 'agent_delegated'
                or judgments.get('mapping_seen_before_freeze') is not False
                or judgments.get('packet_hash') != packet['packet_hash']):
            raise ValueError('blind_assignment_binding_required')
        ids = {c['id'] for c in packet['cases']}
        if set(judgments['cases']) != ids or merged.keys() & ids:
            raise ValueError('complete_disjoint_review_required')
        merged.update(judgments['cases'])
        hashes.append(packet['packet_hash'])
    output = Path(output)
    combined = output.with_name(output.stem + '-combined.json')
    write_private(combined, {'reviewer': 'agent_delegated', 'mapping_seen_before_freeze': False,
                             'packet_hashes': hashes, 'cases': merged})
    return freeze_verdicts(suite_path, report_path, combined, output)


def freeze_summary_after_review(suite_path, report_path, verdicts_path, output):
    dev_suite(suite_path)
    # summarize is the first mapping read and requires all24 complete verdicts.
    result = summarize(suite_path, report_path, verdicts_path)
    result.update(development_only=True, final_evidence=False,
        checkpoint_selection_gate_unused=True, candidate_field_is_structural_placeholder=True,
        selection_rule='Use frozen development selection rule across all four methods; ignore this placeholder gate.')
    result = seal(result, 'summary_hash')
    write_private(output, result)
    return {'summary_hash': result['summary_hash'], 'case_count': 24,
            'activation_authorized': False}
