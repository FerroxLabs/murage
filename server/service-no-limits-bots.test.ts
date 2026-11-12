// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { decide, BOT_MANAGEMENT } from './outside-authority.ts';
import { Row } from './turn-settle.ts';
import { bindServiceTurn } from './service-no-limits.ts';
it.each([...BOT_MANAGEMENT])('S5 No limits %s applies immediately after outside content on any engine', tool=>{
 const gen=randomUUID(),thread=randomUUID();let noLimits=true;
 bindServiceTurn(gen,thread,'bot',()=>true,()=>({ownerAudience:true,origin:'webhook',noLimits}));
 const row=new Row(gen,thread,'customAcp','content');row.marked=true;
 const action={kind:'bot' as const,tool,gen,digest:'fixture',eff:'fixture'};
 const context={passes:[],origin:'content',live_read:'web page',row,driver_ok:false};
 expect(decide(action,context)).toEqual(['active',null]);
 noLimits=false;expect(decide(action,context)[0]).toBe('refuse');
});
it('S5 an explicit lower level and an expired generation retain review behavior',()=>{
 const gen=randomUUID();let active=true;
 bindServiceTurn(gen,'thread','bot',()=>active,()=>({ownerAudience:true,origin:'owner',noLimits:true}));
 const action={kind:'bot' as const,tool:'create_bot',gen,digest:'fixture',eff:'fixture'};
 const ctx={passes:[],origin:'own',live_read:'web page',row:null,driver_ok:false};
 expect(decide(action,ctx)).toEqual(['active',null]);
 active=false;expect(decide(action,ctx)).toEqual(['staged','outside']);
});
