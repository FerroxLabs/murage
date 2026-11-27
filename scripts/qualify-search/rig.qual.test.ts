// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runRig } from './rig.mjs';
import { Report, smoke } from './support.ts';
it.runIf(process.env.MURAGE_QUAL==='rig-smoke')('rig wrapper invokes gate, base and tip eight ways', {tags:['qual']}, async()=>{
  expect(smoke).toBe(true);
  const dir=join(process.env.MURAGE_QUAL_FIXTURE_ROOT!,'rig');
  const tools=join(dir,'tools'),registry=join(dir,'registry');mkdirSync(tools,{recursive:true});
  const gate=`#!/bin/bash\nset -eu\nmkdir -p '${tools}/gate-out/'"$(basename "$1")"\nprintf '0\\n' > '${tools}/gate-out/'"$(basename "$1")"/gates.rc\n`;
  const shard=`#!/bin/bash\nset -eu\ntest "$3" = --shards\ntest "$4" = 8\ntest "$MAXC" = 2\nmkdir -p '${registry}/'"$2"/out\n`;
  writeFileSync(join(tools,'hz-gate.sh'),gate,{mode:0o755});writeFileSync(join(tools,'vt-shard.sh'),shard,{mode:0o755});
  for(const sha of ['base','tip']){
    const out=join(registry,sha,'out');mkdirSync(out,{recursive:true});
    writeFileSync(join(out,'FAILS.txt'),sha==='tip'&&process.env.MURAGE_QUAL_FAIL_BAR==='new-fails'?'server/synthetic.test.ts :: regression\n':'');
    writeFileSync(join(out,'SUMMARY.md'),'# synthetic shard summary\n');
    writeFileSync(join(out,'s1.json'),JSON.stringify({testResults:[{name:'/work/server/synthetic.test.ts',assertionResults:[{fullName:'synthetic corpus search',status:'passed'}]}]}));
  }
  const result=await runRig({worktree:process.cwd(),tip:'tip',base:'base',tools,registry,out:process.env.MURAGE_QUAL_EVIDENCE,smoke:true});
  const report=new Report('rig-smoke');report.raw=result.raw;
  for(const [id,pass]of Object.entries(result.pass))report.bar(id,pass as boolean);
  report.bar('invocations',result.raw.commands.length===3);report.finish();
});
