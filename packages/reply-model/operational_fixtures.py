"""Re-run the four observed rubric situations with the full production prompt.

Call compare_operational inside the pilot's guarded child. This module neither
collects messenger data nor activates adapters or reads prior output mappings.
"""
import argparse
import gc
import json
from pathlib import Path
import random
import time

from personalization import digest, private_json
from training_curriculum import compile_prompt, build_generation_input, PROMPT_VERSION

VERSION = 'observed-operational-four-v1'
SITUATIONS = (
    ('other_made_app', (('other','제가 만든 앱입니다. 한번 써보세요.'),
                        ('self','직접 만드셨다니 대단하시네요!'),
                        ('other','그냥 한번 만들어본 데 의의를 두고 있어요.'))),
    ('unknown_schedule', (('other','내일 오후 3시에 통화 가능하세요?'),)),
    ('approved_schedule', (('self','내일 오후 3시에 통화 가능합니다.'),
                           ('other','그럼 내일 오후 3시 맞죠?'))),
    ('preserve_refusal', (('self','그 파일은 보내지 마세요. 승인하지 않습니다.'),
                         ('other','지금 보내도 될까요?'))),
)


def inputs():
    cases = []
    for number, (identity, turns) in enumerate(SITUATIONS, 1):
        context = [{'message_id':f'm{i}', 'author_role':role, 'author_id':role,
                    'ts':100+i, 'reply_to':None, 'body':body}
                   for i, (role, body) in enumerate(turns)]
        compiled, omitted = compile_prompt({'context':context,
            'chat':{'platform':'telegram','account':'synthetic','chat_id':identity},
            'incoming_message_ids':None})
        preflight = json.loads(compiled[-1]['content'])['preflight']
        if omitted or preflight['status'] != 'ready':
            raise ValueError('operational_fixture_preflight_failed')
        cases.append({'number':number,'id':identity,'synthetic':True,
                      'context':context,'input':build_generation_input(compiled),
                      'preflight':preflight})
    return cases


def compare_operational(model, adapter, output, *, engine_factory=None):
    """Generate eight outputs without stdout bodies/methods; caller provides guard."""
    actual_engine = engine_factory is None
    if actual_engine:
        from continual import ReplyWorker
        engine_factory = ReplyWorker
    cases = inputs()
    methods = ({}, {})
    # Release each model before loading the next; no concurrent model cache.
    for index, adapter_path in enumerate((None, str(adapter))):
        engine = engine_factory()
        engine.path = Path(model)
        for case in cases:
            started = time.monotonic()
            answer = engine.generate_text(case['input'], adapter_path=adapter_path,
                                          max_tokens=192, temperature=0.0)
            methods[index][case['id']] = {'text':answer,
                                         'latency_seconds':time.monotonic()-started}
        del engine
        gc.collect()
        if actual_engine:
            # Actual MLX engine path; fake test engines need no MLX dependency.
            try:
                import mlx.core as mx
                mx.clear_cache()
            except ImportError:
                pass
    mapping = {}
    for case in cases:
        order = [0, 1]
        random.SystemRandom().shuffle(order)
        case['outputs'] = []
        mapping[case['id']] = {}
        for label_number, method_index in enumerate(order, 1):
            result = methods[method_index][case['id']]
            label = f'option_{label_number}'
            case['outputs'].append({'label':label,'text':result['text'],
                                    'output_hash':digest(result['text'])})
            mapping[case['id']][label] = {'method':('base','selected_adapter')[method_index],
                                         'latency_seconds':result['latency_seconds']}
    output = Path(output)
    output.mkdir(mode=0o700, parents=True, exist_ok=True)
    private_json(output/'blind-report.json', {'version':VERSION,'prompt_version':PROMPT_VERSION,
                                            'complete':True,'cases':cases})
    private_json(output/'mapping.json', mapping)
    private_json(output/'metadata.json', {'version':VERSION,'synthetic':True,
        'observed_regression':True,'case_count':4,'output_count':8,'max_tokens':192,
        'temperature':0.0,'prompt_version':PROMPT_VERSION,
        'input_hash':digest(inputs()),'guard_required':True})
    return str(output/'blind-report.json')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model',type=Path,required=True)
    parser.add_argument('--adapter',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args = parser.parse_args()
    print(json.dumps({'report':compare_operational(args.model,args.adapter,args.output)}))


if __name__ == '__main__':
    main()
