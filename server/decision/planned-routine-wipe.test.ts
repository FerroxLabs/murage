// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { fixture, d, baseCard } from './fixture.ts';

it('a scheduled literal wipe remains evidence while content-only memory stays data',()=>{
 const f=fixture();const call={tool:'schedule_routine',input:{action:'create',routine:{instructions:'rm -rf ~'}}};
 expect(d.describeAction(call).deletes).toContainEqual({path:'home',op:'delete'});
 const handle=d.openRequest({kind:'service',service:'routine',claim:f.claim,call:{...call,approval:{queueRef:'wipe-proposal',epoch:'e',action:{routineRequest:{id:'wipe-proposal'},options:['Allow','Deny']}}}});
 expect(d.decide(handle,baseCard).kind).toBe('card');
 expect(d.describeAction({tool:'memory_save',input:{text:'rm -rf ~'}}).deletes).toHaveLength(0);
});
