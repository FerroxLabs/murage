// SPDX-License-Identifier: AGPL-3.0-or-later
// 1024 sv10done L0: the owner memory route answers a Forget aimed at a checkpoint head that moved on with 409 MEMORY_CHANGED and the
// settingRef for the card. q1024-weakfix: observed over HTTP on a booted server (the route's own catch block), not by reading index.ts.
import {afterAll,beforeAll,expect,it} from 'vitest';
import {launchVerificationServer,type VerificationServer} from '../scripts/control-murage.ts';
import {decodeSettingRef} from '../src/lib/setting-ref-decode.ts';
let fixture:VerificationServer,desktop:Record<string,string>;
async function api(method:string,path:string,body?:unknown,headers=desktop){
 const response=await fetch(fixture.info.url+path,{method,headers:{...headers,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 return {status:response.status,body:await response.json() as any};
}
beforeAll(async()=>{
 fixture=await launchVerificationServer(process.env);
 const secret=(await api('GET','/api/desktop-secret',undefined,{})).body.secret;
 desktop={'x-murage-surface':'desktop','x-murage-surface-secret':secret};
},120000);
afterAll(async()=>{if(fixture)await fixture.close();});
it('L0 a Forget aimed at a head that is not the current one is refused 409 MEMORY_CHANGED with its settingRef',async()=>{
 const stale={familyId:'family-gone',sequence:1,memberRecordId:'record-gone',memberVersion:1,state:'archived'};
 const got=await api('POST','/api/memory/action',{action:'forget',kind:'record',id:'record-gone',revision:1,expectedHead:stale});
 expect(got.status).toBe(409);
 expect(got.body.error).toBe('MEMORY_CHANGED');
 // the card's settingRef is asserted first so a route that answers 409 without it (the pre-sv10done body) fails here, at the behaviour
 expect(decodeSettingRef(got.body)).toEqual({id:'bot.memory.memory',code:'MEMORY_CHANGED'});
 expect(got.body.code).toBe('MEMORY_CHANGED');
},60000);
