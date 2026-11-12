// SPDX-License-Identifier: AGPL-3.0-or-later
// Mandatory HANDOFF S1 gate. A missing, skipped, failed or uncollected file fails.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
export const GATE_FILES=Object.freeze([
 'server/always-ask.test.ts','server/nolimits-means-it.test.ts','server/stop-line-bypass-corpus.test.ts',
 'server/always-ask-protected-path.test.ts','server/nlmi-marks-r16-rows.test.ts',
 'server/always-ask-protected-path-attached.test.ts','server/always-ask-text-tool-options.test.ts',
 'server/full-deny-1018.test.ts','server/full-access-unreadable-d-108.test.ts',
 'server/powershell-fail-closed-104.test.ts','server/marks-deny-class-1018.test.ts',
 'server/full-access-env-unchecked-108.test.ts','server/marks-nolimits-narrow-1018.test.ts',
 'server/marks-owner-reads-1018.test.ts','server/drivers/codex-edit-contract.test.ts',
 'server/nlmi-marks-r13-rows.test.ts','server/nolimits-means-it-1020.test.ts',
 'server/nolimits-walk-crit.test.ts','server/drivers/acp/issue-perms-1010.test.ts',
 'server/always-ask-mirror.test.ts',
]);
export function gateResult(report){
 const rows=GATE_FILES.map(file=>{
  const results=report.testResults.filter(r=>r.name.replaceAll('\\','/').endsWith('/'+file));
  const tests=results.flatMap(r=>r.assertionResults??[]);
  return {file,passed:tests.filter(t=>t.status==='passed').length,failed:tests.filter(t=>t.status==='failed').length,
   complete:results.length===1&&results[0].status==='passed'&&tests.length>0&&tests.every(t=>t.status==='passed')};
 });
 const complete=rows.every(r=>r.complete);
 return {complete:complete&&report.success===true,rows};
}
export function runGate(){
 const dir=resolve(process.env.DECISION_EVIDENCE||'.afix-evidence/gate-final');mkdirSync(dir,{recursive:true});
 const args=['run',...GATE_FILES,'--reporter=json','--outputFile='+dir+'/results.json'];
 const run=spawnSync('node_modules/.bin/vitest',args,{encoding:'utf8',timeout:600000});
 writeFileSync(dir+'/command.log','S1 TIP '+(process.env.S1_TIP??'uncommitted candidate')+'\nCOMMAND vitest '+args.join(' ')+'\n'+run.stdout+run.stderr+'\nSTATUS '+run.status+'\n');
 const result=gateResult(JSON.parse(readFileSync(dir+'/results.json','utf8')));
 writeFileSync(dir+'/summary.json',JSON.stringify(result,null,2));
 console.log(JSON.stringify(result,null,2));process.exitCode=run.status===0&&result.complete?0:1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)runGate();
