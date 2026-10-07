"""Materialize the one global development winner; never activate it."""
from pathlib import Path
import shutil

from independent import read, check_seal, seal, write_private, now
from checkpoint_dev import sha, finite_adapter, verify_binding


def stage_selected(selection_path, bindings_path, output):
    selected, binding = read(selection_path), read(bindings_path)
    check_seal(selected, 'checkpoint_selection_hash')
    verify_binding(binding)
    if (selected['activation_authorized'] is not False or selected['final_outputs_seen'] is not False
            or selected['selection_rule_hash'] != binding['selection_rule_hash']):
        raise ValueError('pre_final_global_selection_required')
    method = selected['selected_method']
    receipt = binding['artifacts']['checkpoint_receipts'][method]
    if (selected['selected_checkpoint'] != receipt
            or receipt['adapter_path'] != binding['method_adapters'][method]):
        raise ValueError('selected_checkpoint_binding_mismatch')
    source, output = Path(receipt['adapter_path']), Path(output).resolve()
    if sha(source / 'adapters.safetensors') != receipt['adapter_artifact_hash']:
        raise ValueError('selected_weights_changed')
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    hashes = {}
    for name in ('adapters.safetensors', 'adapter_config.json'):
        dest = output / name
        shutil.copyfile(source / name, dest)
        dest.chmod(0o600)
        hashes[name] = sha(dest)
    if hashes['adapters.safetensors'] != receipt['adapter_artifact_hash']:
        raise ValueError('selected_copy_identity_mismatch')
    finite_adapter(output / 'adapters.safetensors')
    manifest = read(source / 'manifest.json')
    manifest.update(selection_required=True, final_evaluation_required=True,
        development_quality_selection_complete=True,
        selection={'criterion': 'global_development_semantic_quality_then_saved_artifact_loss',
            'checkpoint_iteration': receipt['step'], 'artifact_sha256': receipt['adapter_artifact_hash'],
            'validation_loss': receipt['validation_loss'],
            'development_selection_hash': selected['checkpoint_selection_hash'],
            'loss_only_winner': selected['minimum_validation_loss_method']})
    write_private(output / 'manifest.json', manifest)
    hashes['manifest.json'] = sha(output / 'manifest.json')
    identity = seal({'schema': 'pre_final_selected_adapter_identity-v1', 'frozen_at_utc': now(),
        'path': str(output), 'method': method, 'step': receipt['step'], 'file_hashes': hashes,
        'base_model_identity': binding['artifacts']['base_model_identity'],
        'binding_hash': binding['binding_hash'],
        'checkpoint_selection_hash': selected['checkpoint_selection_hash'],
        'selection_rule_hash': selected['selection_rule_hash'],
        'activation_authorized': False, 'final_evaluation_required': True}, 'identity_hash')
    write_private(output / 'selected-adapter-identity.json', identity)
    return identity
