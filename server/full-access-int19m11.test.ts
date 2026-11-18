// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { autoVerdict } from './auto-approve.ts';
import { r2Rows, physicalFullAccessRows } from './testing/no-limits-r2-cases.ts';
import { segmentDesignRows } from './testing/no-limits-segment-design-cases.ts';
import { y3bRows } from './testing/no-limits-y3b-cases.ts';
import baseline from './testing/int19m11-full-access.fixture.json' with { type: 'json' };
// MAIN RULING 2026-11-13 MM-1: fixture regenerated for approved reason metadata
// Regenerate through scripts/update-int19m11-full-access-fixture.mjs.
// Keep every serialized verdict field, including omission and insertion order.
it('M1 Full access verdict bytes equal integration start for all G-NL inputs', () => {
  const rows=[...r2Rows,...physicalFullAccessRows,...segmentDesignRows.map(row=>({...row,cwd:'/work'})),...y3bRows];
  const actual=rows.map((row,index)=>({index,id:row.id,verdict:autoVerdict({autoApprove:true,fullAccess:true,noLimits:false},'tool' in row ? row.tool??'Bash' : 'Bash',row.command,{ownerStarted:true,fullAccessOrigin:'owner',outsideRead:null,commandText:row.command,commandCwd:row.cwd,workFolder:row.cwd,unseen:{platform:'posix'},promptFacts:{cwd:row.cwd,home:'/home/fixture'}})}));
  expect(actual).toHaveLength(319);
  const reasons = actual.map(row => row.verdict.reason ?? '<absent>');
  expect(Object.fromEntries([...new Set(reasons)].sort().map(reason => [reason, reasons.filter(value => value === reason).length]))).toEqual({
    '<absent>': 48, 'protected-path': 46, tokenizer: 212, unreadable: 3, 'value-path': 10,
  });
  expect(JSON.stringify(actual)).toBe(JSON.stringify(baseline));
},180000);
