// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { fixture } from './fixture.ts';
import { wiring } from '../decision-wiring/fixture.ts';
import { serviceOwnerNoLimits } from '../narrow-denials.ts';

it('the authenticated service producer carries the exact live turn into the shared policy observation', async () => {
 const f=fixture();const token={threadId:'t',botId:'b',generation:'g'};
 const api=wiring(['issueDecisionAuthority'],{issueDecisionClaim:()=>f.claim,saveContinuation:async()=>{},internalCapabilities:{isActive:(candidate:unknown)=>candidate===token},decisionAuthorities:new Map()});
 const a=await api.issueDecisionAuthority(token);
 expect(a.claim).toBe(f.claim);expect(a.identity).toEqual({threadId:'t',generation:'g'});expect(Object.isFrozen(a.identity)).toBe(true);
 expect(serviceOwnerNoLimits(a)).toBe(true);f.setLevel('full');expect(serviceOwnerNoLimits(a)).toBe(false);
});
