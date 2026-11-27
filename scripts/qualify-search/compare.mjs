import { assertExternalEvidencePath, evidencePath } from '../evidence-path.mjs';
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const dir=assertExternalEvidencePath(resolve(process.argv[2]??evidencePath('evidence/r4')));
const output=evidencePath('q1-combined.json',dir);
const legs=['q1-103k','q1-1m'].map(leg=>JSON.parse(readFileSync(join(dir,leg+'.json'),'utf8')));
const bounds=legs.map(x=>x.raw.bound);
const signature=b=>b.map(x=>[x.statements,x.frames]);
const pass={
  'both-qualified':legs.every(x=>x.qualification===true&&Object.values(x.pass).every(Boolean)),
  'bound-equalities':JSON.stringify(signature(bounds[0]))===JSON.stringify(signature(bounds[1])),
  'no-history-scan':bounds.every(b=>b.length===100&&b.every(x=>x.scans.length===0)),
};
writeFileSync(output,JSON.stringify({pass,raw:legs.map(x=>({leg:x.leg,owner:x.raw.owner,bound:signature(x.raw.bound)}))},null,2)+'\n');
if(!Object.values(pass).every(Boolean))process.exitCode=1;
