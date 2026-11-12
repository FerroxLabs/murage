// Sean 2026-11-12: independently describe the changed cells of the immutable
// r13b fixture. Every lower-level and unproven byte remains compared verbatim.
import {expect} from 'vitest';
import {WIPE_RULES} from './no-limits-1019.ts';
export function expectRulingForPinnedRow(row:any,actual:{approve:string|null;rule?:string}):boolean {
 if(!row.bot.autoApprove||!row.bot.fullAccess||!row.bot.noLimits||row.id.startsWith('unproven'))return false;
 const wipe=WIPE_RULES.has(row.expected.rule);
 expect(actual.approve===null,row.id).toBe(wipe);
 if(wipe)expect(actual.rule,row.id).toBe(row.expected.rule);
 return true;
}
