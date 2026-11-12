// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect,it } from 'vitest';
it('F6 Full access frozen artifacts match the independent int19m12b recapture',()=>{
 const proof=JSON.parse(readFileSync('evidence/gnl/frozen-recapture.json','utf8'));
 expect(proof.commit).toBe('49f91a80733d03aba0c3b7a422283ee05703c911');
 expect(proof.exitCode).toBe(0);
 expect(proof.files).toHaveLength(2);
 for(const row of proof.files){
  expect(createHash('sha256').update(readFileSync(row.file)).digest('hex'),row.file).toBe(row.sha256);
  expect(readFileSync(row.diff,'utf8'),row.file).toBe('');
 }
});
