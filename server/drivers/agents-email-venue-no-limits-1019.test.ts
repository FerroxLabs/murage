// SPDX-License-Identifier: AGPL-3.0-or-later
import { runBoundBridge } from '../testing/bound-proxy-fixture.ts';
import { expect, it } from 'vitest';

it.each(['lead','member','proposal'])('R1 real MCP proxy lists mounted email and venue tools on No limits %s turns only',async role=>{
 for(const noLimits of [false,true]){
  const frames=await runBoundBridge(
   `await import(${JSON.stringify(new URL('./agents-proxy.ts',import.meta.url).href)});`,
   [JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})],1,false,
   {role:'agents',env:{MURAGE_PROJECT_ROLE:role,MURAGE_EMAIL:'send',MURAGE_VENUE_POST:'1',MURAGE_NO_LIMITS:noLimits?'1':'0'}});
  const names=JSON.parse(frames[0]!).result.tools.map((t:{name:string})=>t.name);
  for(const name of ['email_list','email_read','email_send','email_reply','email_trust_offer','venue_post'])expect(names.includes(name),name).toBe(noLimits);
 }
});
