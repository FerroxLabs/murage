import { expect, it } from 'vitest';
import { autoVerdict } from '../../server/auto-approve.ts';
import { noLimits, context, protectedTarget } from './mandatory-fixture.mjs';
import { resolve } from 'node:path';
import { predicateInventory } from './predicate-inventory.mjs';
it('one noLimitsAppliesTo implementation decides both policy entry points',()=>{
  const inventory=predicateInventory(resolve('.'));
  expect(inventory.definitions).toHaveLength(1);
  expect(inventory.callers).toContain('server/auto-approve.ts');
  expect(inventory.callers).toContain('server/decision/implementation.ts');
});
// Replaces the superseded protected-path and outside-content No limits
// assertions in server/nolimits-means-it.test.ts. No input is executed.
it.each(['owner','routine','webhook','owner-channel'])('%s non-wipe protected writes RUN, also on marked turns',origin=>{
  const command=`printf fixture > '${protectedTarget()}'`;
  const c=context(command,{noLimitsOrigin:origin,fullAccessOrigin:origin==='webhook'?'other':origin,ownerStarted:origin==='owner'||origin==='owner-channel',
    unattended:origin==='routine'||origin==='webhook',automated:origin==='routine'||origin==='webhook',
    routineLevel:origin==='routine',channelOwner:origin==='owner-channel',outsideRead:['web page'],channelMessages:true});
  const v=autoVerdict(noLimits,'Bash',command,c);expect(v.approve).not.toBeNull();
});
it.each(['full','unlimited'])('other humans remain at Ask on legacy %s bots',level=>{
  const bot={...noLimits,noLimits:level==='unlimited'};delete bot.permissionExplicit;
  const command='touch fixture';
  expect(autoVerdict(bot,'Bash',command,context(command,{fullAccessOrigin:'other',ownerStarted:false,unattended:true,channelOwner:false})).approve).toBeNull();
});
