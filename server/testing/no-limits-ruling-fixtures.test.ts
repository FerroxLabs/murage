// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect,it } from 'vitest';
import { expectRulingForPinnedRow } from './no-limits-ruling-fixtures.ts';
const bot={autoApprove:true,fullAccess:true,noLimits:true};
it.each(['guest','room'])('F5 frozen %s row remains compared even when its bot has No limits flags',id=>{
 const row={id,bot,context:{fullAccessOrigin:'other'},expected:{approve:null,rule:'sensitive-file'}};
 expect(expectRulingForPinnedRow(row,{approve:null,rule:'sensitive-file'})).toBe(false);
});
it('F5 a pinned owner row receives only the wipe-only ruling',()=>{
 expect(expectRulingForPinnedRow({id:'owner',bot,context:{fullAccessOrigin:'owner'},expected:{approve:null,rule:'sensitive-file'}},{approve:'run'})).toBe(true);
});
