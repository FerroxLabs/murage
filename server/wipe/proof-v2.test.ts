// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync,readFileSync } from 'node:fs';
import { expect,it } from 'vitest';
it('DELTA11 expected matrix names assertion failures and every commit cell',()=>{
 const matrix=JSON.parse(readFileSync(new URL('./red/expected.json',import.meta.url),'utf8'));
 for(const row of Object.values(matrix) as Record<string,string>[])for(const sha of ['df48','b8e1','c1','head'])expect(['FAIL-assert','PASS','observed','n/a']).toContain(row[sha]);
 expect(matrix['R2-H3'].c1).toBe('FAIL-assert');
});
it('DELTA12 removes the equivalent mutant and names the v2 killers',()=>{
 const source=readFileSync(new URL('./mutants.mjs',import.meta.url),'utf8');
 expect(source).not.toMatch(/\['MU4',/);for(const n of [37,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53])expect(source).toMatch(new RegExp(`[\"']MU${n}[\"']`));
 // MAIN RULING WIPE-V3 S9/mutation plan: harmless F7 faults now run; MU31 retains a catastrophic double-fault killer.
 expect(source).toMatch(/MU31[^\n]*V3-G6/);expect(source).toMatch(/MU38 retired:[^\n]*S9/);
});
it('DELTA14 English card inventory accompanies the isolated verification recipe',()=>expect(existsSync(new URL('../../docs/verification/narrow-wipe.md',import.meta.url))).toBe(true));
