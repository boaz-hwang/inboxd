from pathlib import Path
import subprocess,tempfile,os,time,json,re
root=Path(__file__).resolve().parents[1]
bun=subprocess.check_output(['which','bun'],text=True).strip()
base=(root/'packages/accounts/src/worker.ts').read_text()
lazy=base
for name,path in [('createSlackAccount','../../../platforms/slack/src/account.ts'),('createTelegramAccount','../../../platforms/telegram/src/account.ts'),('createKakaoAccount','../../../contrib/kakao/src/account.ts')]:
 lazy=lazy.replace(f'import {{ {name} }} from "{path}";\n','')
 lazy=lazy.replace(name+'(',f'(await import("{path}")).{name}(')
# Pre-import selected adapter so this measures ready provider modules, not an empty worker.
lazy=lazy.replace('const config = JSON.parse(raw);','''const config = JSON.parse(raw);
if (config.kind === "slack") await import("../../../platforms/slack/src/account.ts");
if (config.kind === "telegram") await import("../../../platforms/telegram/src/account.ts");
if (config.kind === "kakao_personal") await import("../../../contrib/kakao/src/account.ts");''')
probe=root/'packages/accounts/src/.memory-probe.ts'
results=[]
with tempfile.TemporaryDirectory(prefix='inboxd-memory-') as tmp:
 try:
  for name,source,flags in [('static',base,[]),('lazy',lazy,[]),('lazy-smol',lazy,['--compile-exec-argv=--smol'])]:
   probe.write_text(source); binary=str(Path(tmp)/name)
   build=subprocess.run([bun,'build','--compile','--no-compile-autoload-dotenv','--no-compile-autoload-bunfig','--outfile',binary,*flags,str(probe)],cwd=root,capture_output=True,text=True)
   if build.returncode: print(name,build.stderr);continue
   for kind in ['slack','telegram','kakao_personal'] * 2:
    proc=subprocess.Popen([binary],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,env={'PATH':'/usr/bin:/bin','INBOXD_ACCOUNT_CONFIG':json.dumps({'kind':kind}),'INBOXD_ACCOUNT_STREAM':'1'})
    try:
     time.sleep(1)
     if proc.poll() is not None:
      print(name,kind,"EXIT",proc.returncode,proc.stderr.read().decode()[:1200],flush=True);continue
     report=subprocess.run(['vmmap','-summary',str(proc.pid)],capture_output=True,text=True).stdout
     match=re.search(r'Physical footprint:\s+(\S+)',report)
     item={'variant':name,'provider_imported':kind,'footprint':match.group(1) if match else 'failed'}
     results.append(item);print(json.dumps(item),flush=True)
    finally:
     proc.terminate();proc.wait(timeout=5)
 finally: probe.unlink(missing_ok=True)
print(json.dumps({'results': results}, indent=2))
