// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdirSync, readdirSync, lstatSync, unlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import * as copy from './copy-tools.ts';
import * as support from './support.ts';
import * as rig from './rig.mjs';
import { searchMessages, searchMessagesWithMeta } from '../../server/message-db.ts';

const active = process.env.MURAGE_QUAL === 'review';
afterEach(async () => { await support.stop(); for (const name of readdirSync(support.DATA_DIR)) { const file=join(support.DATA_DIR,name); if(lstatSync(file).isFile()) unlinkSync(file); } });
const root = () => process.env.MURAGE_QUAL_FIXTURE_ROOT!;
const oracle = (id: number) => 'ORACLE:BLOCK-' + id;

it.runIf(active)('BLOCK-1 negative controls measure violations instead of overriding bars', {tags:['qual']}, async () => {
  const report = new support.Report('review');
  report.bar('integrity', true);
  expect(report.pass.integrity, oracle(1)).toBe(true);
  const db = await support.fresh(), trace = support.capture();
  try {
    db.exec('CREATE VIRTUAL TABLE messages_fts USING fts5(t)');
    db.prepare('INSERT INTO messages_fts(t) VALUES(?)').run('synthetic main thread violation');
    expect(trace.mainFTS.length > 0, oracle(1)).toBe(true);
    const file = join(root(), 'broken.db');
    writeFileSync(file, Buffer.alloc(8192, 0x61));
    expect(support.integrity(file), oracle(1)).toBe(false);
  } finally { trace.restore(); }
});

it.runIf(active)('BLOCK-2 parity includes matches older than the 2000 candidate cap', {tags:['qual']}, async () => {
  const db = await support.fresh(); support.seed(db, 2105);
  await support.start(db); await support.until(() => support.healthy(db), 'review-parity');
  const a = support.observer();
  try {
    // The old path really returns a silently capped subset on this fixture.
    expect(searchMessagesWithMeta('canary', 3000).partial, oracle(2)).toBe(true);
    const enumerate = (copy as Record<string, unknown>).completeParity as typeof copy.completeParity | undefined;
    const result = enumerate ? Reflect.apply(enumerate, undefined, [db, ['canary'], a, support.search.trigramQuery, searchMessagesWithMeta]) : Reflect.apply((copy as Record<string, unknown>).parity as (...args:unknown[])=>ReturnType<typeof copy.completeParity>, undefined, [db, ['canary'], (q:string, n:number) => searchMessages(q,n)]);
    expect(result[0].count, oracle(2)).toBe(2105);
    a.prepare('DELETE FROM messages_fts WHERE rowid=1').run();
    const changed = enumerate ? Reflect.apply(enumerate, undefined, [db, ['canary'], a, support.search.trigramQuery, searchMessagesWithMeta]) : Reflect.apply((copy as Record<string, unknown>).parity as (...args:unknown[])=>ReturnType<typeof copy.completeParity>, undefined, [db, ['canary'], (q:string,n:number)=>searchMessages(q,n)]);
    expect(changed[0].rowidHash, oracle(2)).not.toBe(result[0].rowidHash);
  } finally { a.close(); }
});

it.runIf(active)('BLOCK-3 original rows lost before atFull fail preservation', {tags:['qual']}, async () => {
  const db = await support.fresh(); db.exec('DELETE FROM messages'); support.seed(db,32);
  const factory = (support as Record<string, unknown>).preservationLedger as ((db:DatabaseSync)=>{hash:()=>unknown;dropThread:(thread:string)=>void;add:(db:DatabaseSync,id:number)=>void}) | undefined;
  const ledger = factory?.(db);
  support.send(1); ledger?.add(db,1);
  support.deleteThread('drop-0'); ledger?.dropThread('drop-0');
  db.exec("DELETE FROM messages WHERE id='seed-31'");
  const atFull = support.hashRows(db);
  expect(JSON.stringify(ledger?.hash() ?? atFull) === JSON.stringify(support.hashRows(db)), oracle(3)).toBe(false);
});

it.runIf(active)('BLOCK-4 a healthy copied index must undergo history rebuild', {tags:['qual']}, async () => {
  const db = await support.fresh(); db.exec('DELETE FROM messages'); support.seed(db,300);
  await support.start(db); await support.until(()=>support.healthy(db),'review-warm'); await support.search.stopSearchIndex();
  const begin = (support as Record<string, unknown>).beginRebuild as ((db:DatabaseSync)=>Promise<unknown>) | undefined;
  if(begin) await begin(db); else { support.hooks.halted=true; await support.start(db); }
  const a = support.observer();
  try {
    expect(support.state(a,'built') !== undefined, oracle(4)).toBe(true);
    expect(Number(a.prepare('SELECT COUNT(*) AS n FROM docs').get()!.n), oracle(4)).toBe(0);
  } finally { a.close(); }
  support.hooks.halted=false; await support.until(()=>support.healthy(db),'review-rebuilt');
});

it.runIf(active)('BLOCK-5 merged evidence requires explicit C16 and C18 and forwarded marker', {tags:['qual']}, async () => {
  const dirs=['base','tip'].map(x=>join(root(),'merged-'+x));
  for(const dir of dirs){mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'FAILS.txt'),'');writeFileSync(join(dir,'SUMMARY.md'),'complete');writeFileSync(join(dir,'s1.json'),JSON.stringify({testResults:[{name:'/work/server/synthetic.test.ts',assertionResults:[{fullName:'synthetic',status:'passed'}]}]}));}
  const result=rig.compareRig(dirs[0],dirs[1],0,{merged:true});
  expect(Object.values(result.pass).every(Boolean),oracle(5)).toBe(false);
  const adapt=(rig as Record<string,unknown>).mergedShardSource as ((source:string)=>string)|undefined;
  const source='docker run --network none -e HOME=/tmp/home node:24-bookworm';
  expect(adapt?.(source)??source,oracle(5)).toContain('-e MURAGE_FTS_MERGED_SHA=');
  expect((adapt?.(source+'\n'+source)??'').match(/-e MURAGE_FTS_MERGED_SHA=/g)?.length,oracle(5)).toBe(2);
  const plan=(rig as Record<string,unknown>).mergedShardArgs as ((out:string)=>string[])|undefined;
  expect(plan?.(root())??[],oracle(5)).toContain('--force');
  expect(plan?.(root())??[],oracle(5)).toContain('--out');
  // Execute the wrapper against a fake shard entry with the same Docker env
  // anchor as the shared tool. Its Docker function records the received env;
  // it creates no containers and refuses the stale SHA-only output.
  const tools=join(root(),'merged-tools'),registry=join(root(),'merged-registry'),out=join(root(),'merged-out');
  mkdirSync(tools,{recursive:true});
  writeFileSync(join(tools,'hz-gate.sh'),`mkdir -p '${tools}/gate-out/'"$(basename "$1")"
printf '0\\n' > '${tools}/gate-out/'"$(basename "$1")"/gates.rc
`);
  const payload=JSON.stringify({testResults:[{name:'/work/server/synthetic.test.ts',assertionResults:[{fullName:'synthetic',status:'passed'},{fullName:'C16: merged',status:'passed'},{fullName:'C18: merged',status:'passed'}]}]});
  writeFileSync(join(tools,'vt-shard.sh'),`set -eu
output='${registry}/'"$2"/out
shift 2
forced=0
while [ "$#" -gt 0 ]; do case "$1" in --out) output=$2; shift 2;; --force) forced=1; shift;; *) shift;; esac; done
mkdir -p "$output"
docker() {
  if [ "\${MURAGE_FTS_MERGED_SHA:-}" != '' ]; then
    test "$forced" = 1
    test "$output" != '${registry}/tip/out'
    case " $* " in *' MURAGE_FTS_MERGED_SHA=tip '*) ;; *) exit 44;; esac
    printf 'tip\\n' > "$output/forwarded-marker"
  fi
}
docker run --network none -e HOME=/tmp/home node:24-bookworm
printf '' > "$output/FAILS.txt"
printf 'fresh synthetic result\\n' > "$output/SUMMARY.md"
printf '%s' '${payload}' > "$output/s1.json"
`);
  const previous=process.env.MURAGE_FTS_MERGED_SHA;
  try {
    process.env.MURAGE_FTS_MERGED_SHA='tip';
    // Base is run without the merged marker, matching the real invocation.
    const merged=await rig.runRig({worktree:process.cwd(),base:'base',tip:'tip',tools,registry,out,smoke:true});
    expect(Object.values(merged.pass).every(Boolean),oracle(5)).toBe(true);
    const evidence=merged.raw.merged as {output:string};
    expect(readFileSync(join(evidence.output,'forwarded-marker'),'utf8').trim(),oracle(5)).toBe('tip');
  } finally { if(previous===undefined)delete process.env.MURAGE_FTS_MERGED_SHA;else process.env.MURAGE_FTS_MERGED_SHA=previous; }

});

it.runIf(active)('BLOCK-6 OS jobs independently require handshake and both C15 crash barriers', {tags:['qual']}, () => {
  const common=['T-RESET-HANDSHAKE', 'T-REC-RESET','T-REC-PERSISTENT','T-REC-WINDOW','T-REC-DEFER','T-REC-ONCE','T-SCRUB-BACKOFF','T-SCRUB-NOSTARVE','T-SCRUB-RECOVER','T-SCRUB-CAP'];
  const crash=["C15': SIGKILL reset-before-delete", "C15': SIGKILL reset-after-wal-delete"];
  const check=(names:string[])=>{const file=join(root(),'reset.json');writeFileSync(file,JSON.stringify({testResults:[{assertionResults:names.map(fullName=>({fullName,status:'passed'}))}]}));return spawnSync(process.execPath,['scripts/qualify-search/check-reset-set.mjs',file]).status;};
  for(const missing of [common[0],...crash]) expect(check([...common,...crash].filter(x=>x!==missing)),oracle(6)).not.toBe(0);
  expect(check([...common,...crash]),oracle(6)).toBe(0);
  for(const file of ['macos-ci-try.yml','windows-copy-job.ps1'])expect(readFileSync('scripts/qualify-search/'+file,'utf8'),oracle(6)).toContain('server/search-index-r3-crash.test.ts');
});

it.runIf(active)('BLOCK-7 English diagnostic inventory is generated and documented', {tags:['qual']}, () => {
  const generator='scripts/qualify-search/english-inventory.mjs';
  expect(existsSync(generator),oracle(7)).toBe(true);
  const output=join(root(),'inventory.json');
  expect(spawnSync(process.execPath,[generator,output]).status,oracle(7)).toBe(0);
  const entries=JSON.parse(readFileSync(output,'utf8')) as Array<{file:string;literal:string;class:string}>;
  expect(entries.some(x=>x.file.endsWith('copy-tools.ts')&&x.literal==='copy gate refuses symbolic links'&&x.class==='internal-error'),oracle(7)).toBe(true);
  expect(readFileSync('docs/verification/search-qualification-amend.md','utf8'),oracle(7)).toContain('search-qualification-english.json');
});
