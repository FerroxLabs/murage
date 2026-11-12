// SPDX-License-Identifier: AGPL-3.0-or-later
// Run in an isolated container: each mutation restores its original source even when the test fails.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const evidence='.gnl-browser-evidence';mkdirSync(evidence,{recursive:true});
const mutations=[
 ['F1','server/browser-extension-service.ts','await bind(entry);await persist();return;','await persist();return;'],
 ['F2','server/browser-extension-service.ts','noLimits:()=>serviceOwnerNoLimits(options.authorityFor?.(entry.context)),','noLimits:()=>false,'],
 ['F2-outside','server/browser-extension-service.ts',"!serviceOwnerNoLimits(options.authorityFor?.(entry.context))&&method==='Page.navigate'&&entry.exemptOpen","method==='Page.navigate'&&entry.exemptOpen"],
 ['F2-handoff','server/browser-extension-service.ts',"const resumeNoLimitsHandoff = async (entry: Entry) => {\n    if (","const resumeNoLimitsHandoff = async (entry: Entry) => {\n    if (true || "],
 ['F3','server/browser-extension-service.ts',"if (serviceOwnerNoLimits(options.authorityFor?.(entry.context))) {\n      entry.sites[origin]", "if (false && serviceOwnerNoLimits(options.authorityFor?.(entry.context))) {\n      entry.sites[origin]"],
 ['F3-runtime','extensions/murage-browser/runtime.mjs',"req.params.noLimits !== true && ((b.bindEpoch ?? 0) !== bindEpoch || !b.approvedOrigins.includes(t.origin))","((b.bindEpoch ?? 0) !== bindEpoch || !b.approvedOrigins.includes(t.origin))"],
 ['F4','server/browser-extension-service.ts','if (serviceOwnerNoLimits(options.authorityFor?.(entry.context))) return;','if (false && serviceOwnerNoLimits(options.authorityFor?.(entry.context))) return;'],
 ['F5','server/browser-extension-service.ts','redactPageOutput(item.text, serviceOwnerNoLimits(options.authorityFor?.(entry.context)))','redactPageOutput(item.text)'],
 ['F2-executor','server/browser-extension-executor.ts','if(this.options.noLimits?.())return null;','if(false && this.options.noLimits?.())return null;'],
 ['F2-native','server/browser-control.ts','const before = !noLimits() && await native.protected();','const before = await native.protected();'],
 ['F2-clipboard','extensions/murage-browser/runtime.mjs',"if (req.params.noLimits !== true && isClipboardInput(method, params)) fail('clipboard_denied');","if (isClipboardInput(method, params)) fail('clipboard_denied');"],
 ['owner-takeover','server/browser-control.ts','if (e.held) throw browserRefusal("browser_held");','if (e.held && !noLimits()) throw browserRefusal("browser_held");'],
 ['owner-handoff','server/browser-extension-service.ts',"if (!entry.handoffRule || entry.state !== 'paused'","if (entry.state !== 'paused'"],
 ['capacity','server/browser-extension-service.ts',"if (access === 'allow' && entry.sites[origin] !== 'allow' && Object.values(entry.sites).filter(value => value === 'allow').length >= MAX_STORED_GRANTS)","if (false && access === 'allow' && entry.sites[origin] !== 'allow' && Object.values(entry.sites).filter(value => value === 'allow').length >= MAX_STORED_GRANTS)"],

];
for(const [id,file,from,to] of mutations){
 const original=readFileSync(file,'utf8');if(!original.includes(from))throw Error(`${id}: mutation anchor missing`);
 let run;
 try{
  let mutated=original.replace(from,to);
  // Revert both parts of renewal: the timer exemption and recovery after a timer between turns.
  if(id==='F4')mutated=mutated.replace("if (serviceOwnerNoLimits(options.authorityFor?.(entry.context)) && ['idle', 'limit'].includes(entry.endedFor?.reason ?? '')) entry.endedFor = undefined;",'');
  writeFileSync(file,mutated);
  const pattern=({'F2-outside':'outside-result','F2-handoff':'existing handoff','F3-runtime':'native arm','F2-executor':'executes payment','F2-native':'native No limits observes','F2-clipboard':'executes clipboard','owner-takeover':'owner live take-over','owner-handoff':'existing.*owner handoff','capacity':'Allow always capacity'})[id]??id;
  run=spawnSync('pnpm',['exec','vitest','run','scripts/browser-no-limits-1019.test.mjs','-t',pattern,'--reporter=default','--reporter=json',`--outputFile=${evidence}/${id}-mutant.json`],{encoding:'utf8',timeout:180000,maxBuffer:16*1024*1024});
 }finally{writeFileSync(file,original);}
 writeFileSync(`${evidence}/${id}-mutant.log`,(run.stdout??'')+(run.stderr??''));
 const report=JSON.parse(readFileSync(`${evidence}/${id}-mutant.json`,'utf8'));
 if(!(report.numFailedTests>0)||report.numTotalTests===report.numPendingTests)throw Error(`${id}: pattern selected no failing test`);
 if(run.error||run.signal||run.status!==1||!report.testResults.some(suite=>suite.assertionResults.some(test=>test.status==='failed'&&test.failureMessages.some(message=>/AssertionError|_Assertion/.test(message)))))throw Error(`${id}: mutant was not killed by an assertion (status ${run.status})`);
 console.log(`${id}: KILLED ${file}`);
}
