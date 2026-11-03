"""Read-only connected A/B benchmark; credentials never enter argv or output.

Runs selected configured Slack accounts through both the installed Bun worker and
local release Rust worker. Keeps every connection alive through a heartbeat cycle.
No sends, uploads, read receipts, or leave operations. All spawned workers cleaned.
"""
import argparse, collections, json, os, queue, re, subprocess, threading, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def footprint(pid):
    p = subprocess.run(['vmmap', '-summary', str(pid)], capture_output=True, text=True, timeout=15)
    m = re.search(r'^Physical footprint:\s+([\d.]+)([KMG])', p.stdout, re.M)
    if not m: raise RuntimeError('physical footprint unavailable')
    return round(float(m[1]) * {'K': 1/1024, 'M': 1, 'G': 1024}[m[2]], 2)

class Worker:
    def __init__(self, binary, config):
        self.events = collections.Counter()
        self.replies = queue.Queue()
        self.process = subprocess.Popen([str(binary)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, env={'PATH':'/usr/bin:/bin', 'INBOXD_ACCOUNT_CONFIG':json.dumps(config), 'INBOXD_ACCOUNT_STREAM':'1', 'INBOXD_ACCOUNT_LIVE':'1'})
        def replies():
            for line in self.process.stdout:
                try: self.replies.put(json.loads(line))
                except Exception: self.replies.put({'ok':False, 'error':'invalid frame'})
        def events():
            for line in self.process.stderr:
                try:
                    event=json.loads(line)
                    key=event.get('state') if event.get('event')=='state' else event.get('event')
                    if key in ['connected','disconnected','unsupported','changed','deleted','gap']:self.events[key]+=1
                except Exception: self.events['invalid_frame']+=1
        for target in [replies,events]:threading.Thread(target=target, daemon=True).start()
    def call(self, request):
        self.process.stdin.write(json.dumps(request)+'\n');self.process.stdin.flush()
        reply=self.replies.get(timeout=90)
        if not reply.get('ok'):raise RuntimeError('provider read failed')
        return reply['result']
    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:self.process.kill();self.process.wait(timeout=5)
        for stream in [self.process.stdin,self.process.stdout,self.process.stderr]:stream.close()

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--accounts',type=int,default=3);parser.add_argument('--seconds',type=int,default=45);parser.add_argument('--output',type=Path)
    args=parser.parse_args()
    configs=[{k:v for k,v in p.items() if k in ['kind','bot_token','session_cookie','team_id','user_id']} for p in json.loads((Path.home()/'.inboxd/config.json').read_text())['providers'] if p['kind']=='slack'][:args.accounts]
    report=[]
    for index,config in enumerate(configs):
        workers={}
        try:
            workers['bun']=Worker(Path.home()/'.inboxd/product/release/inboxd-account-worker',config)
            workers['rust']=Worker(ROOT/'target/release/inboxd-slack-native',config)
            outcomes={}
            for variant,worker in workers.items():
                result=worker.call({'op':'slack.client.counts','params':{}})
                info=worker.call({'op':'slack.users.info','params':{'user':config['user_id']}})
                outcomes[variant]={'counts_ok':result.get('data',{}).get('ok') is True,'self_identity_matches':info.get('data',{}).get('user',{}).get('id')==config['user_id']}
            print(json.dumps({'account_index':index+1,'reads':outcomes}),flush=True)
            started=time.monotonic();snapshots=[]
            for target in [5,20,args.seconds]:
                time.sleep(max(0,target-(time.monotonic()-started)))
                values={variant:footprint(worker.process.pid) for variant,worker in workers.items()}
                snapshot={'elapsed_seconds':round(time.monotonic()-started,1),'footprint_mib':values}
                snapshots.append(snapshot);print(json.dumps({'account_index':index+1,**snapshot}),flush=True)
            entry={'account_index':index+1,'reads':outcomes,'snapshots':snapshots,'events':{v:dict(w.events) for v,w in workers.items()}}
            report.append(entry);print(json.dumps({'account_index':index+1,'events':entry['events']}),flush=True)
        finally:
            for worker in workers.values():worker.close()
    if args.output:
        args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(report,indent=2)+'\n')

if __name__=='__main__':main()
