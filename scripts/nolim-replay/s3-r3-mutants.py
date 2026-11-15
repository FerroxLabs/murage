#!/usr/bin/env python3
"""Runs only inside the network-none lane container. Restores each exact source in finally."""
import json, pathlib, subprocess, sys, re
root=pathlib.Path.cwd(); out=root/'.afix-evidence/r3/mutants';out.mkdir(parents=True,exist_ok=True)
A='server/drivers/answer-delivery.ts'; R='server/drivers/request-delivery.ts';N='server/drivers/native-ask.ts';C='server/drivers/codex.ts';CL='server/drivers/claude.ts';P='server/drivers/pi.ts';ACP='server/drivers/acp/core.ts'
cases=[
('M74',A,"  const key = JSON.stringify([generation, requestId]), hash = inputHash(answer);","  if(this.openCount>=512)return Promise.resolve({state:'failed'});\n  const key = JSON.stringify([generation, requestId]), hash = inputHash(answer);",'answer-idempotency','T3a'),
('M75',R,"   const k = key(event.threadId,event.requestId);","   if(open.size>=1536)return;\n   const k = key(event.threadId,event.requestId);",'request-delivery','T3b'),
('M76',A,'  entry.retire?.();',"  if(this.openCount+this.terminal.size>=1024){const first=this.active.entries().next().value;if(first){const [g,b]=first;const id=b.keys().next().value;if(id!==undefined){b.delete(id);this.openCount--;}}}\n  entry.retire?.();",'answer-idempotency','T3c'),
('M77',A,"   if (entry.state === 'pending') return entry.done;","   if (entry.state === 'pending') return entry.done;\n   if(entry.attempts>=2)return Promise.resolve({state:'failed'});",'answer-idempotency','T3d'),
('M78',R,' const retire = (g: string) => {',' const retire = (g: string) => {\n  for(const k of closed.keys()){__visits.count++; open.get(k);}', 'request-delivery','T3e'),
('M79',A,'  entry.retire?.();','  // mutant: pending callers are never settled', 'answer-idempotency','T3f'),
('M80',C,'          const frame = { jsonrpc:', '          asks.delete(requestId);\n          const frame = { jsonrpc:', 'native-answer-retry','T4a codex'),
('M81',CL,"        const frame = JSON.stringify({ t: 'answer'", "        pending.delete(askId);\n        const frame = JSON.stringify({ t: 'answer'", 'native-answer-retry','T4a claude'),
('M82',P,'                const frame=response();','                pending.delete(reqId);\n                const frame=response();', 'native-answer-retry','T4a pi'),
('M83',C,"source: accepted ? source : 'unavailable'", "source: source", 'native-answer-retry','T4c codex'),
('M84',N,'!writable()','false /* mutant: always writable */', 'native-ask','M84'),
('M85',N,' if (slot.writing) {',' if (false && slot.writing) {', 'native-answer-retry','T4d'),
('M86',ACP,'          postureEpoch++; postureFailures = 0;',"          if(postureEpoch>=1){failPosture('posture-recovery-exhausted');throw Error('turn-wide counter');}\n          postureEpoch++; postureFailures = 0;",'acp-posture-switch','T5a'),
('M87',ACP,'              postureFailures=0;','              // mutant: no failure reset on ack', 'acp-posture-switch','T5d'),
('M88',ACP,'postureFailures >= MAX_POSTURE_RECOVERY_FAILURES','false', 'acp-posture-switch','T5c'),
('M89',ACP,'              if (appliedPosture !== askStop()) { postureEpoch++; continue; }','              // mutant: latest level ignored', 'acp-posture-switch','T5e'),
('M90','scripts/no-limits-live/readers.mjs',"snapshot.complete=false;snapshot.errors.push(`missing surface: ${name}`);return undefined;","if(name==='records'){snapshot.records=[];return [];}snapshot.complete=false;snapshot.errors.push(`missing surface: ${name}`);return undefined;",None,None),
('M96','scripts/no-limits-live/run.mjs','  if (release) assertReleaseReady();', '  // mutant: release ignores dependency markers',None,None),
]
summary=json.loads((out/'summary.json').read_text()) if (out/'summary.json').exists() else []
for mid,path,before,after,test,name in cases:
 if len(sys.argv)>1 and mid not in sys.argv[1:]:continue
 p=root/path;original=p.read_text();assert before in original,(mid,'mutation anchor absent')
 cmd=['pnpm','exec','vitest','run',f'server/drivers/{test}.test.ts','-t',name,'--maxWorkers=1'] if test else ['node','--test', 'scripts/no-limits-live/readers.test.mjs' if mid=='M90' else 'scripts/no-limits-live/field.test.mjs']
 try:
  p.write_text(original.replace(before,after,1))
  proc=subprocess.run(cmd,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=110)
  log=proc.stdout;code=proc.returncode
 finally:p.write_text(original)
 (out/f'{mid}.log').write_text('$ '+' '.join(cmd)+'\n'+log)
 killed=code!=0 and bool(re.search(r'AssertionError|Test timed out|ERR_ASSERTION|testTimeout|Tests\s+\d+ failed',log)) and not re.search(r'Failed to load url|Cannot find module|Transform failed',log)
 summary=[row for row in summary if row['id']!=mid]
 summary.append(dict(id=mid,killed=killed,exit=code,evidence=f'.afix-evidence/r3/mutants/{mid}.log'))
 (out/'summary.json').write_text(json.dumps(summary,indent=2)+'\n');print(mid,'KILLED' if killed else 'SURVIVED',flush=True)
 if not killed:sys.exit(1)
