// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { requestCwdInventory } from '../testing/no-limits-request-cwd-inventory-1019.ts';
const allow:Record<string,string>={
 'acp/core.ts#1':'Structured question; no local tool process.',
 'acp/core.ts#2':'Folder trust question; no local tool process.',
 'acp/core.ts#4':'Computer MCP mount executes on the host service; not in the ACP process cwd.',
 'claude.ts#1':'Sign-in question; no local tool process.',
 'claude.ts#2':'MCP elicitation question; no local tool process.',
 'muse-code.ts#2':'Structured question; no local tool process.',
};
const rows=requestCwdInventory();
it('I-CWD enumerates production request.opened literals as data',()=>{
 expect(rows.length).toBeGreaterThanOrEqual(12);
 expect(new Set(rows.map(row=>row.id)).size).toBe(rows.length);
 for(const id of Object.keys(allow))expect(rows.some(row=>row.id===id),id).toBe(true);
});
for(const row of rows)it(`I-CWD ${row.id} ${row.scope}`,()=>{
 if(allow[row.id]){expect(allow[row.id].length).toBeGreaterThan(15);if(row.id==='acp/core.ts#4'){expect(row.approvalScope.replace(/[\"']/g,'')).toBe('local-computer');expect(row.scope).toContain('askHostAction');}else expect(row.requestType.replace(/[\"']/g,'')).toBe('question');return;}
 expect(['executionCwd','execEnv','input.cwd'],JSON.stringify(row)).toContain(row.source);
});
