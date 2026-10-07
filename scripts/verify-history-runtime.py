#!/usr/bin/env python3
"""Opt-in real MLX verification using synthetic conversations only; never activate production."""
import argparse
import gc
import json
import os
from pathlib import Path
import re
import resource
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'packages/reply-model'))
from personalization import (private_json, prepare_examples, run_local,
    select_validation_checkpoint, stage_training_model, activate, rollback)
from learning_split import key
from worker import ReplyWorker, build_generation_input, compile_prompt


def examples(tokenizer, seq_length):
    def record(index, chat_id, desired):
        ts = 1700000000 + index * 86400
        chat = {'platform': 'kakao', 'account': 'synthetic-owner', 'chat_id': chat_id}
        count = min(40, max(2, (desired - 650) // 125))
        def build(repetitions):
            context = [{'message_id': f'{index}-{j}', 'author_id': 'me' if j % 2 else 'other',
                        'author_role': 'self' if j % 2 else 'other', 'ts': ts-count+j-1,
                        'body': '예시 일정과 문서를 확인하는 대화입니다.', 'reply_to': None}
                       for j in range(count)]
            context[0]['body'] += ' 이전 대화의 합성 맥락입니다.' * repetitions
            context[-1].update(author_id='other', author_role='other', body='제가 만든 예시 앱입니다. 한번 써보세요.')
            compiled, omitted = compile_prompt({'chat':chat, 'context':context, 'incoming_message_ids':None})
            assert not omitted
            messages = build_generation_input(compiled) + [{'role':'assistant','content':'직접 만드셨군요. 어떤 기능이 있는지 궁금하네요.'}]
            return context, messages
        low, high = 0, 700
        while low < high:
            mid = (low+high+1)//2
            _, messages = build(mid)
            size = len(tokenizer.apply_chat_template(messages, return_dict=False, enable_thinking=False))
            if size <= desired: low = mid
            else: high = mid-1
        context, messages = build(low)
        target = f'{index}-reply'
        return {'id':f'synthetic-{index}', 'chat':chat, 'conversation_id':chat_id, 'timestamp':ts,
                'reviewed':True, 'linkage':'reviewed_turn','target_role':'self', 'target_message_id':target,
                'context_message_ids':[m['message_id'] for m in context],
                'context_timestamps':[m['ts'] for m in context], 'provenance_refs':[f'synthetic:{index}'],
                'source_message_keys':[key('kakao','synthetic-owner',chat_id,m['message_id']) for m in context] +
                                      [key('kakao','synthetic-owner',chat_id,target)],
                'target_source_keys':[key('kakao','synthetic-owner',chat_id,target)], 'messages':messages}
    rows = [record(1,'usual-chat',int(seq_length*.9)), record(2,'usual-chat',900),
            record(3,'usual-chat',900), record(4,'heldout-chat',900)]
    rows[2]['evaluation_group']='temporal'; rows[3]['evaluation_group']='heldout_chat'
    return rows, {r['id']: name for r,name in zip(rows,('train','valid','test','test'))}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model',type=Path,default=Path.home()/'.inboxd/reply-model/models/Qwen3.5-9B-4bit')
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--seq-length',type=int,default=1024)
    parser.add_argument('--iters',type=int,default=2)
    parser.add_argument('--concurrent-inference',action='store_true')
    parser.add_argument('--full',action='store_true',help='Select checkpoint, test loss, blind A/B/C and isolated registry roundtrip')
    parser.add_argument('--child',action='store_true',help=argparse.SUPPRESS)
    args=parser.parse_args()
    from mlx_lm.utils import load_tokenizer
    tokenizer=load_tokenizer(args.model)
    rows, assignments=examples(tokenizer,args.seq_length)
    output=args.output.resolve()
    if args.child:
        run_local(rows,args.model,output/'adapter',iters=args.iters,seq_length=args.seq_length,
                  epochs=1,batch_size=1,save_every=1,assignments=assignments)
        return
    output.mkdir(mode=0o700,parents=True,exist_ok=False)
    os.umask(0o077)
    report={'synthetic_only':True,'production_activation':False,'seq_length':args.seq_length,
            'iterations':args.iters,'status':'running','pid':os.getpid()}
    private_json(output/'verification.json',report)
    try:
        from mlx_lm.tuner.datasets import ChatDataset
        with tempfile.TemporaryDirectory(prefix='inboxd-training-') as tmp:
            staged=stage_training_model(args.model,Path(tmp),rows,tokenizer)
            dataset=ChatDataset([{'messages':r['messages']} for r in rows],load_tokenizer(staged),mask_prompt=True)
            masks=[]
            for index,r in enumerate(rows):
                tokens,offset=dataset.process(dataset[index])
                prefix=tokenizer.apply_chat_template(r['messages'][:-1],add_generation_prompt=True,
                                                     return_dict=False,enable_thinking=False)
                assert tokens[:offset] == prefix
                assert tokenizer.decode(tokens[offset:]).startswith(r['messages'][-1]['content'])
                masks.append({'id':r['id'],'total_tokens':len(tokens),'masked_tokens':offset,'loss_tokens':len(tokens)-offset})
            report['mask_checks']=masks
        splits,manifest=prepare_examples(rows,assignments=assignments)
        report['split_counts']={n:len(v) for n,v in splits.items()}
        engine=ReplyWorker(); engine.path=args.model
        latency=[]
        prompt=rows[2]['messages'][:-1]
        if args.concurrent_inference:
            # Warm the same runtime used by the daemon before measuring latency.
            engine.generate_text(prompt,max_tokens=32)
            for _ in range(3):
                started=time.monotonic(); engine.generate_text(prompt,max_tokens=32)
                latency.append(time.monotonic()-started)
            report['idle_inference_seconds']=latency
        started=time.monotonic()
        log=output/'orchestrator.log'
        with log.open('w') as stream:
            command=[sys.executable,str(Path(__file__).resolve()),'--child','--model',str(args.model),
                     '--output',str(output),'--seq-length',str(args.seq_length),'--iters',str(args.iters)]
            child=subprocess.Popen(command,stdout=stream,stderr=subprocess.STDOUT)
            report['training_pid']=child.pid; private_json(output/'verification.json',report)
            samples=[]
            if args.concurrent_inference:
                runtime=output/'adapter/runtime.log'
                while child.poll() is None:
                    if runtime.exists() and 'Starting training' in runtime.read_text():
                        break
                    time.sleep(.2)
                for _ in range(3):
                    if child.poll() is not None: break
                    tick=time.monotonic(); engine.generate_text(prompt,max_tokens=32)
                    samples.append({'seconds':time.monotonic()-tick,'training_live_after':child.poll() is None})
                    report['concurrent_inference']=samples
                    private_json(output/'verification.json',report)
                report['concurrent_inference']=samples
                engine.models.clear()
                gc.collect()
                import mlx.core as mx
                mx.clear_cache()
            code=child.wait()
        report['training_seconds']=time.monotonic()-started
        report['child_peak_rss_bytes']=resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
        if code: raise RuntimeError('synthetic_training_failed_see_private_logs')
        runtime=(output/'adapter/runtime.log').read_text()
        report['mlx_peak_gb']=[float(x) for x in re.findall(r'Peak mem\s+([\d.]+)\s+GB',runtime)]
        engine.models.clear()
        if args.full:
            report['selection']=select_validation_checkpoint(rows,args.model,output/'adapter',assignments=assignments,
                                                              seq_length=args.seq_length)
            for name,adapter in [('base',None),('trained',output/'adapter')]:
                run_local(rows,args.model,output/(name+'-test'),evaluate=True,adapter=adapter,
                          assignments=assignments,seq_length=args.seq_length)
            from learning_evaluation import compare
            rubrics=json.loads((Path(__file__).resolve().parents[1]/'packages/reply-model/fixtures/learning_evaluation_rubrics.json').read_text())
            compare(engine,tokenizer,splits['train'],splits['test'],output/'adapter',output/'blind-review.json',
                    heldout_rubric=rubrics['heldout'],rubric_cases=rubrics['fixtures'],
                    max_input_tokens=max(8192,args.seq_length*2),max_tokens=64,seq_length=args.seq_length)
            blind=json.loads((output/'blind-review.json').read_text())
            report['comparison']={k:blind[k] for k in ('sample_count','comparable_abc_count','comparison_complete','human_review_complete')}
            # An isolated registry proves load/rollback without changing the production registry.
            metadata=json.loads((output/'adapter/manifest.json').read_text())
            registry=output/'synthetic-active-adapter.json'
            activate(registry,output/'adapter',metadata['base_model_id'],reviewed=True)
            chosen=engine.personal_adapter({'adapter_registry':str(registry)})
            assert chosen[2]=='active'
            rollback(registry)
            assert engine.personal_adapter({'adapter_registry':str(registry)})[1]=='base'
            report['isolated_registry_roundtrip']=True
        report['status']='complete'
    except Exception as error:
        report.update(status='failed',error_type=type(error).__name__)
        raise
    finally:
        private_json(output/'verification.json',report)
        print(json.dumps(report,ensure_ascii=False),flush=True)


if __name__=='__main__': main()
