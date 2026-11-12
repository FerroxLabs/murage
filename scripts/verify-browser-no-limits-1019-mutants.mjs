// SPDX-License-Identifier: AGPL-3.0-or-later
// Run in an isolated container: each mutation restores its original source even when the test fails.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const evidence='.gnl-browser-evidence';mkdirSync(evidence,{recursive:true});
const mutations=[
 ['F1','server/browser-extension-service.ts','await bind(entry);await persist();return;','await persist();return;'],
 ['F2','server/browser-extension-service.ts','noLimits:()=>serviceOwnerNoLimits(options.authorityFor?.(entry.context)),','noLimits:()=>false,'],
 ['F2-outside','server/browser-extension-service.ts',"!serviceOwnerNoLimits(options.authorityFor?.(entry.context))&&method==='Page.navigate'&&entry.exemptOpen","method==='Page.navigate'&&entry.exemptOpen"],
 ['F3','server/browser-extension-service.ts',"if (serviceOwnerNoLimits(options.authorityFor?.(entry.context))) {\n      entry.sites[origin]", "if (false && serviceOwnerNoLimits(options.authorityFor?.(entry.context))) {\n      entry.sites[origin]"],
 ['F3-runtime','extensions/murage-browser/runtime.mjs',"req.params.noLimits !== true && ((b.bindEpoch ?? 0) !== bindEpoch || !b.approvedOrigins.includes(t.origin))","((b.bindEpoch ?? 0) !== bindEpoch || !b.approvedOrigins.includes(t.origin))"],
 ['F4','server/browser-extension-service.ts','if (serviceOwnerNoLimits(options.authorityFor?.(entry.context))) return;','if (false && serviceOwnerNoLimits(options.authorityFor?.(entry.context))) return;'],
 ['F5','server/browser-extension-service.ts','redactPageOutput(item.text, serviceOwnerNoLimits(options.authorityFor?.(entry.context)))','redactPageOutput(item.text)'],
];
for(const [id,file,from,to] of mutations){
 const original=readFileSync(file,'utf8');if(!original.includes(from))throw Error(`${id}: mutation anchor missing`);
 let run;
 try{
  let mutated=original.replace(from,to);
  // Revert both parts of renewal: the timer exemption and recovery after a timer between turns.
  if(id==='F4')mutated=mutated.replace("if (serviceOwnerNoLimits(options.authorityFor?.(entry.context)) && ['idle', 'limit'].includes(entry.endedFor?.reason ?? '')) entry.endedFor = undefined;",'');
  writeFileSync(file,mutated);
  run=spawnSync('pnpm',['exec','vitest','run','scripts/browser-no-limits-1019.test.mjs','-t',id==='F2-outside'?'outside-result':id==='F3-runtime'?'native arm':id],{encoding:'utf8',timeout:180000,maxBuffer:16*1024*1024});
 }finally{writeFileSync(file,original);}
 writeFileSync(`${evidence}/${id}-mutant.log`,(run.stdout??'')+(run.stderr??''));
 if(run.error||run.signal||run.status!==1||!(/AssertionError/.test(run.stdout+run.stderr)))throw Error(`${id}: mutant was not killed by an assertion (status ${run.status})`);
 console.log(`${id}: KILLED ${file}`);
}
