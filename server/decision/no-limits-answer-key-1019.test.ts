// SPDX-License-Identifier: AGPL-3.0-or-later
import {spawnSync} from 'node:child_process';
import {readFileSync,mkdirSync,mkdtempSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {beforeAll,afterAll,expect,it} from 'vitest';
import {removeTempDirSync} from '../testing/cleanup.ts';
let evidence:any;
const dir=process.env.A4_KEY_DIR??mkdtempSync(join(tmpdir(),'a4-keys-'));
beforeAll(()=>{
 mkdirSync(dir,{recursive:true});
 const r=spawnSync(process.execPath,['--experimental-strip-types',resolve('evidence/nlsym-A4/answer-key-fixture.mjs')],{env:{...process.env,A4_KEY_DIR:dir},encoding:'utf8',timeout:180000,maxBuffer:16*1024*1024});
 expect(r.signal,r.stdout+r.stderr).toBe(null);expect(r.status,r.stdout+r.stderr).toBe(0);
 evidence=JSON.parse(readFileSync(join(dir,'results.json'),'utf8'));expect(evidence.ok,evidence.error).toBe(true);expect(evidence.cleaned).toBe(true);
},190000);
afterAll(()=>{if(!process.env.A4_KEY_DIR)removeTempDirSync(dir);});
const row=()=>evidence.rows.normal;
const outcome=(post:any)=>post.result.outcome;
it('KEY-1 exact first POST replay cannot release refreshed evidence',()=>{
 const r=row();expect(r.replay.bytes).toBe(r.first.bytes);expect(outcome(r.replay)).toBe('unavailable');expect(r.afterReplay.answers).toHaveLength(0);expect(r.referentsUnchanged).toBe(true);expect(r.afterReplay.open).toHaveLength(1);expect(r.afterReplay.open[0].chatMessageId).toBe(r.replacement.id);
});
it('KEY-2 fresh card own requestId releases exactly once',()=>{
 const r=row();expect(r.replacement.card.requestId).not.toBe(r.original.card.requestId);expect(r.freshPost.bytes).not.toBe(r.first.bytes);expect(outcome(r.freshPost)).toBe('allowed-once');expect(r.final.status).toBe('settled');expect(r.answers).toHaveLength(1);expect(r.decisionLog).toHaveLength(1);expect(r.messages.messages.some((m:any)=>m.id===r.replacement.id&&m.card?.answered==='Allowed')).toBe(true);
});
it('KEY-3 durable lookup after volatile request map is cleared rejects old key',()=>{
 const r=evidence.rows.restart;expect(r.afterReplay.lookups.some((lookup:any)=>lookup.requestId===r.original.card.requestId&&lookup.id===r.original.id&&lookup.answered==='Permission changed before release')).toBe(true);expect(outcome(r.replay)).toBe('unavailable');expect(r.afterReplay.answers).toHaveLength(0);expect(r.afterReplay.open).toHaveLength(1);expect(r.referentsUnchanged).toBe(true);
});
it('KEY-4 service queue twin replay cannot release refreshed evidence',()=>{
 const r=evidence.rows.service;expect(outcome(r.replay)).toBe('unavailable');expect(r.afterReplay.open).toHaveLength(1);expect(r.serviceDeliveries).toBe(1);expect(r.referentsUnchanged).toBe(true);
});
it('KEY-5 ref issued before refresh cannot release new evidence',()=>{
 const r=row();expect(r.staleRef.open).toHaveLength(1);expect(r.staleRef.error??r.staleRef.outcome?.kind).toMatch(/unissued-approval-ref|card/);expect(r.staleRef.open[0].chatMessageId).toBe(r.replacement.id);
});
it('KEY-6 two refreshes require card three own key',()=>{
 const r=evidence.rows.twice;expect(r.third.id).not.toBe(r.replacement.id);expect(outcome(r.firstReplayAgain)).toBe('unavailable');expect(outcome(r.secondReplay)).toBe('unavailable');expect(outcome(r.freshPost)).toBe('allowed-once');expect(r.answers).toHaveLength(1);
});
it('KEY-7 old Telegram mirror and old action hash cannot authorize refreshed presentation',()=>{
 const r=row();expect(r.mirror.valid).toBe(false);expect(r.hybrid.valid).toBe(false);expect(r.current.actionHash).not.toBe(r.captured.row.actionHash);
});
it('KEY-8 stale deny cannot settle the replacement card',()=>{
 const r=row();expect(outcome(r.staleDeny)).toBe('unavailable');expect(r.afterDeny.cards.filter((m:any)=>!m.card?.answered)).toHaveLength(1);expect(r.afterDeny.answers).toHaveLength(0);
});
