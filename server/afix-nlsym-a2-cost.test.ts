// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
it.each([false,true])('A2 production root inspection ordinary=%s completes within a bounded container budget',{tags:['perf-budget'],timeout:30000},ordinary=>{
 const result=spawnSync(process.execPath,['--max-old-space-size=768','--experimental-strip-types','evidence/afix-nlsym-A2/root-probe.mjs',ordinary?'ordinary':'root'],{encoding:'utf8',timeout:20000,maxBuffer:1024*1024});
 mkdirSync('evidence/afix-nlsym-A2',{recursive:true});
 writeFileSync(`evidence/afix-nlsym-A2/root-cost-${ordinary?'ordinary':'root'}.json`,JSON.stringify({status:result.status,signal:result.signal,error:result.error?.message,stdout:result.stdout,stderr:result.stderr},null,2)+'\n');
 expect(result.status,result.stderr||result.error?.message).toBe(0);
 expect(JSON.parse(result.stdout)).toMatchObject({verdict:ordinary?'run':'hold'});
});
