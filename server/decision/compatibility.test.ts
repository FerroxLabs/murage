// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { finalDecision, cutRead, cleanRead } from '../../shared/no-limits-decision.ts';
import { autoVerdict, finalizeNoLimits, noLimitsInitiator } from '../auto-approve.ts';

it('legacy actor-shaped calls hold without throwing or becoming authority', () => {
  for (const kind of ['owner', 'owner-routine', 'other']) {
    expect(finalDecision({autoApprove:true,fullAccess:true,noLimits:true}, {kind}, {
      tool:'fixture',base:{verdict:'run',cls:'',approve:'candidate'},
    })).toEqual({verdict:'card',cls:'cut',approve:null});
  }
});
it('legacy corpus labels preserve conservative reads and exact BASE identity', () => {
  const base = {approve:null,source:'no-grant'};
  expect(finalDecision([cleanRead('fixture')], 'fixture', {kind:'base',verdict:base})).toBe(base);
  expect(finalDecision([cutRead('fixture')], 'fixture', {kind:'clean-owner'}).verdict).toBe('card');
});
it('legacy finalizer observations and origin metadata cannot change BASE', () => {
  const bot = {autoApprove:true,fullAccess:true,noLimits:true};
  const context = {fullAccessOrigin:'owner' as const,ownerStarted:true,commandText:'rm -rf /'};
  const base = autoVerdict(bot,'Bash','rm -rf /',{...context,commandText:'rm -rf /'});
  expect(finalizeNoLimits(bot,'Bash','fixture',context,base,[cleanRead('fixture')])).toMatchObject({approve:null,rule:'delete-root'});
  expect(noLimitsInitiator(bot,{ownerStarted:true})).toBe('unproven');
});

it('legacy origin metadata validates stored owner, routine and channel facts', () => {
 const bot = {autoApprove:true,fullAccess:true,noLimits:true};
 expect(noLimitsInitiator(bot,{fullAccessOrigin:'owner'})).toBe('owner');
 expect(noLimitsInitiator(bot,{fullAccessOrigin:'owner',unattended:true})).toBe('unproven');
 expect(noLimitsInitiator(bot,{fullAccessOrigin:'routine',routineLevel:true,automated:true})).toBe('routine');
 expect(noLimitsInitiator(bot,{fullAccessOrigin:'routine'})).toBe('unproven');
 expect(noLimitsInitiator(bot,{fullAccessOrigin:'owner-channel',channelOwner:true})).toBe('owner-channel');
 expect(noLimitsInitiator(bot,{fullAccessOrigin:'owner-channel'})).toBe('unproven');
});
