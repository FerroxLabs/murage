// SPDX-License-Identifier: AGPL-3.0-or-later
// OWNER checker facade: wipe-v3. OWNER corpus consumer: wipe-v3-tests.
import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {wipeBreaker} from '../wipe-breaker.ts';
import {corpusContext,type CorpusRow} from './corpus/v3-context.fixture.ts';
const corpus=JSON.parse(readFileSync(new URL('./corpus/wipe-corpus-v3.json',import.meta.url),'utf8')) as CorpusRow[];
it('V3 corpus has unique IDs and both verdict sections',()=>{
 expect(new Set(corpus.map(r=>r.id)).size).toBe(corpus.length);
 expect(corpus.filter(r=>r.tier==='gating'&&r.expect==='card').length).toBeGreaterThan(150);
 expect(corpus.filter(r=>r.tier==='gating'&&r.expect==='run').length).toBeGreaterThan(300);
});
it.each(corpus.filter(r=>r.tier==='gating'))('$id $expect: $cmd',row=>{
 const hit=wipeBreaker(row.cmd,corpusContext(row));
 if(row.expect==='run')expect(hit,row.note).toBeNull();
 else {expect(hit,row.note).not.toBeNull();expect(hit?.rule).not.toBe('wipe-check-fault');if(row.rule)expect(hit?.rule).toBe(row.rule);}
});
it('KNOWN-DISGUISED: observe every row without making it a release gate',()=>{
 const observations=corpus.filter(r=>r.tier==='disguised').map(row=>({id:row.id,expect:row.expect,actual:wipeBreaker(row.cmd,corpusContext(row))?.rule??'run'}));
 expect(observations.length).toBeGreaterThan(0);
 console.log('KNOWN-DISGUISED',JSON.stringify(observations));
});
