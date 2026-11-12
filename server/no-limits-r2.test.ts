// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { autoVerdict, finalizeNoLimits, type AutoContext } from './auto-approve.ts';
import { noLimitsProtectedWrite } from './no-limits-protected.ts';
import { r2Rows } from './testing/no-limits-r2-cases.ts';
const bot={autoApprove:true,fullAccess:true,noLimits:true};
describe.each(['owner','routine'] as const)('r2 compatibility %s',origin=>{
 it.each(r2Rows)('$id',row=>{
 const ctx:AutoContext={commandCwd:row.cwd,commandText:row.command,fullAccessOrigin:origin,ownerStarted:origin==='owner',outsideRead:null,...(origin==='routine'?{routineLevel:true}:{})};
 const hit=noLimitsProtectedWrite(row.command,ctx,undefined,true);
 const action=autoVerdict(bot,'Bash',row.command,ctx);
 const final=finalizeNoLimits(bot,'Bash',row.command,ctx,{approve:null,source:'unread-call'});
 // Sean 2026-11-12: protected writes run; retain the raw reader evidence.
 // Reader assertion: GNU tar manual §6.10.1
 // https://www.gnu.org/software/tar/manual/html_node/directory.html: cumulative -C.
 // Routine assertion: same MAIN ruling and manual; /etc + ./w = /etc/w,
 // whose unknown archive members fail closed under normal protected policy.
 if(row.protect){expect(hit,row.id).toMatchObject({rule:'protected-path'});expect(action.approve,row.id).toBeTruthy();expect(final.approve,row.id).toBeTruthy();}
 else {expect(hit,row.id).toBeNull();expect(action.approve,row.id).toBeTruthy();expect(final.approve,row.id).toBeTruthy();}
 },30000);
});
