// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

type Case = { id: string; file: string; pattern: string };
// MAIN supplies the four IDs from RED-TABLE.json PRESERVE/Q3. Do not invent
// private case IDs when that table is absent from a public checkout.
export async function runPrivateCases(file: string | undefined, copy: string, sourceHash: string, smoke: boolean) {
  if (smoke) {
    const db = new DatabaseSync(join(copy,'messages.db'),{readOnly:true});
    try {
      return [
        {id:'smoke-integrity',pass:db.prepare('PRAGMA integrity_check').get()!.integrity_check==='ok'},
        {id:'smoke-reference-only',pass:!db.prepare('PRAGMA table_info(search_intents)').all().some(row=>row.name==='text')},
        {id:'smoke-source-fingerprint',pass:/^[a-f0-9]{64}$/.test(sourceHash)},
        {id:'smoke-copy-open',pass:db.isOpen},
      ];
    } finally { db.close(); }
  }
  if (!file) return [];
  const manifest = JSON.parse(readFileSync(file,'utf8')) as { sourceHash: string; cases: Case[] };
  if (manifest.sourceHash!==sourceHash || manifest.cases.length!==4 || new Set(manifest.cases.map(c=>c.id)).size!==4) throw Error('invalid private-case manifest');
  return manifest.cases.map(c=>{
    if (!c.id || !c.pattern || !/^server\/.+\.test\.ts$/.test(c.file) || !resolve(c.file).startsWith(resolve('server')+'/')) throw Error('invalid private case');
    const child=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run',c.file,'-t',c.pattern,'--reporter=json'],{
      cwd:process.cwd(),env:{...process.env,MURAGE_QUAL_COPY_WORKING_DIR:copy,MURAGE_QUAL_COPY_SOURCE_HASH:sourceHash},encoding:'utf8',maxBuffer:32*1024*1024,timeout:300_000,
    });
    // Keep private assertion strings out of evidence, even on failure.
    let passed=0, failed=0, skipped=0;
    try { const out=JSON.parse(child.stdout),selected=new RegExp(c.pattern); for(const result of out.testResults??[])for(const a of result.assertionResults??[]){if(!selected.test(a.fullName))continue;if(a.status==='passed')passed++;else if(a.status==='failed')failed++;else skipped++;} } catch { failed++; }
    return {id:c.id,pass:child.status===0&&passed>0&&failed===0&&skipped===0,passed,failed,skipped};
  });
}
