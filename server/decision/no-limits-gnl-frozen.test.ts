import { archivedEvidencePath } from '../../scripts/evidence-path.mjs';
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect,it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { hash } from './bounds.ts';
function snapshots(source:string):Record<string,string>{
 const exports:Record<string,string>={};runInNewContext(source,{exports});return exports;
}
function captured(snapshot:string){
 const parts=snapshot.match(/"bytes": "([\s\S]*?)",\n\s+"sha256": "([a-f0-9]+)"/);
 if(!parts)throw Error('Frozen serialized registration moved');
 return {value:JSON.parse(parts[1]),sha256:parts[2]};
}
it('F6 Full access frozen artifacts match the independent int19m12b recapture',()=>{
 const proof=JSON.parse(readFileSync(archivedEvidencePath('evidence/gnl/frozen-recapture.json'),'utf8'));
 expect(proof.commit).toBe('49f91a80733d03aba0c3b7a422283ee05703c911');
 expect(proof.exitCode).toBe(0);
 expect(proof.files).toHaveLength(2);
 for(const row of proof.files){
  if(row.file==='server/decision/__snapshots__/no-limits-y3b-full-access.test.ts.snap'){
   const original=readFileSync('server/testing/fixtures/no-limits-y3b-before-owner-turn-ruling.snap','utf8');
   expect(createHash('sha256').update(original).digest('hex'),row.file).toBe(row.sha256);
   const before=snapshots(original),after=snapshots(readFileSync(row.file,'utf8'));
   expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
   for(const key of Object.keys(before)){
    if(!key.startsWith('H1 unproven ')){expect(after[key],key).toBe(before[key]);continue;}
    // MAIN RULING 2026-11-13 authenticated owner turn: only the unproven level and its derived hashes change to Ask; every other captured byte remains frozen.
    const old=captured(before[key]),current=captured(after[key]),expected=old.value;
    expect(expected.registration).toMatchObject({actor:'unproven',level:'unlimited'});
    expected.registration.level='ask';
    const {key:requestKey,actor,level,action,denyRev,inputHash}=expected.registration;
    expected.registration.registrationHash=hash({key:requestKey,actor,level,action,denyRev,inputHash});
    expect(current.value,key).toEqual(expected);expect(current.sha256,key).toBe(hash(expected));
   }
  }else expect(createHash('sha256').update(readFileSync(row.file)).digest('hex'),row.file).toBe(row.sha256);
  expect(readFileSync(archivedEvidencePath(row.diff),'utf8'),row.file).toBe('');
 }
});
