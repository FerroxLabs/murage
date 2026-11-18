"""Targeted review regressions; run in the required disposable test container."""
import pathlib,subprocess,json,re,sys
root=pathlib.Path.cwd();out=root/'.afix-evidence/r3/fix4';results=json.loads((out/'mutants.json').read_text()) if (out/'mutants.json').exists() else []
cases=[
 ('B1-reachability','server/drivers/request-delivery.ts',None,None,['pnpm','exec','vitest','run','server/drivers/request-delivery.test.ts','-t','BLOCK1','--maxWorkers=1']),
 ('B1-host-confirm','server/drivers/acp/core.ts','            answerTransport.confirm(threadId, requestId, Promise.resolve(true));','            // mutant: no in-process confirmation',['pnpm','exec','vitest','run','server/drivers/acp/host-action-ask.test.ts','-t','BLOCK1','--maxWorkers=1']),
 ('B2-browser-wrapper','scripts/no-limits-live/readers.mjs','values=rows(root.records).filter', 'values=rows(root).filter',['node','--test','--test-name-pattern=BLOCK2 actual','scripts/no-limits-live/readers.test.mjs']),
 ('B2-mapping','scripts/no-limits-live/readers.mjs',"file:'bots.json',format:'bot-requests'", "file:'queues/bot-access.json',format:'bot-requests'",['node','--test','--test-name-pattern=BLOCK2 actual','scripts/no-limits-live/readers.test.mjs']),
 ('B2-keyless-mcp','scripts/no-limits-live/readers.mjs',"r.enabled===false&&typeof r.rev==='string'||r.pendingEnv?.length", "r.pendingEnv?.length",['node','--test','--test-name-pattern=BLOCK2 disabled','scripts/no-limits-live/readers.test.mjs']),
 ('B3-fixed-request-proof','scripts/no-limits-live/baseline-f-proof.mjs',' if(spec)errors.push(...verifyScenarioRow(row,spec));',' // mutant: accept fixed requests under scenario names',['node','--test','scripts/no-limits-live/baseline-f.test.mjs']),
 ('B3-fixed-native','scripts/no-limits-live/fakes/claude.mjs','for(const [i,step] of plan.steps.entries())','for(const [i,step] of plan.steps.slice(0,1).entries())',['node','--input-type=module','-e',"import {spawnSync} from 'node:child_process';import assert from 'node:assert/strict';const r=spawnSync(process.execPath,['--experimental-strip-types','scripts/no-limits-live/baseline-f.mjs','.afix-evidence/r3/fix4/base-tree','.afix-evidence/r3/fix4/mutant-fixed-native','--rows=two-questions','--engines=claude'],{encoding:'utf8'});assert.equal(r.status,0,r.stdout+r.stderr);"]),
 ('B4-claude-unavailable','server/drivers/claude.ts',"source: accepted ? source : 'unavailable'", "source: accepted ? source : 'user'",['pnpm','exec','vitest','run','server/drivers/native-answer-retry.test.ts','-t','T4b claude','--maxWorkers=1']),
 ('B4-fuigo-unavailable','server/drivers/acp/core.ts',"behavior: accepted && answered ? 'answer' : 'deny', source: accepted ? source : 'unavailable'", "behavior: accepted && answered ? 'answer' : 'deny', source: source",['pnpm','exec','vitest','run','server/drivers/native-answer-retry.test.ts','-t','T4b fuigo','--maxWorkers=1']),
]
for mid,path,before,after,cmd in cases:
 if len(sys.argv)>1 and mid not in sys.argv[1:]:continue
 p=root/path;original=p.read_text()
 if before is not None:assert before in original,mid
 try:
  mutated=(out/'pre-fix/request-delivery.ts').read_text() if before is None else original.replace(before,after,1)
  p.write_text(mutated);r=subprocess.run(cmd,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=100)
 finally:p.write_text(original)
 (out/f'mutant-{mid}.log').write_text('$ '+' '.join(cmd)+'\n'+r.stdout)
 killed=r.returncode!=0 and bool(re.search('AssertionError|ERR_ASSERTION',r.stdout)) and not re.search('Test timed out|no matching event|Cannot find module|Transform failed',r.stdout)
 results=[r for r in results if r['id']!=mid]
 results.append({'id':mid,'killed':killed,'exit':r.returncode});print(mid,'KILLED' if killed else 'SURVIVED',flush=True)
 (out/'mutants.json').write_text(json.dumps(results,indent=2)+'\n')
 if not killed:sys.exit(1)
