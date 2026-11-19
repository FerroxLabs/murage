// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: port-b owns this Sable adapter; port-a owns runtime-fixture.ts.
export const strictFakeAdapterInstrumentation = `
// Strict fake capability for the fixture's fake CLI only; production S4 never adapts a legacy result.
const fixtureGet=ProviderRegistry.prototype.get;
ProviderRegistry.prototype.get=function(id){const instance=fixtureGet.call(this,id);if(instance&&!instance.decisionAdapter){Object.defineProperty(instance.adapter,'capabilities',{value:{...instance.adapter.capabilities,queueing:false}});const answered=new Map();Object.defineProperty(instance,'decisionAdapter',{value:{respondToRequest:async(t,r,a,o)=>{if(answered.has(r))return {state:answered.get(r)===o.answerId?'already':'failed'};const value=await instance.adapter.respondToRequest(t,r,a);if(value==='unavailable')return {state:'failed'};answered.set(r,o.answerId);return {state:'accepted'};},interruptTurn:(...args)=>instance.adapter.interruptTurn(...args),onPostureChange:async()=>{}}});}return instance;};
`;
