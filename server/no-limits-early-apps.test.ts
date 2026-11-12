import {expect,it} from 'vitest';
import {Store} from './store.ts';
import {botAccessPolicy} from './bot-access-role.ts';
import {assertConnectedAppCall,assertStoredConnectedAppAccess,restrictedConnectorTools,connectedAppsListScope} from './bot-access.ts';
it.each(['request-denied','grant-revoked'] as const)('EARLY-APP saved %s runs at No limits and keeps lower policy intact',source=>{
 const store=new Store(),bot=store.createBot({name:'Fixture'},{seedMessages:false});bot.composio=true;
 const current=botAccessPolicy(bot),account='fixture-account';
 bot.connectedAppAccess={...current,mode:'restricted',allowWrites:false,grants:[],denials:[{id:'fixture-denial',toolkit:'gmail',accountId:account,tools:['GMAIL_SEND_EMAIL'],ops:['write'],source,at:1,revision:current.revision}]};
 const call={jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'COMPOSIO_MULTI_EXECUTE_TOOL',arguments:{tools:[{tool_slug:'GMAIL_SEND_EMAIL',account,arguments:{to:'fixture@example.invalid',body:'fixture'}}]}}};
 const before=JSON.stringify(bot.connectedAppAccess);
 expect(()=>assertConnectedAppCall(bot,call,{noLimits:true})).not.toThrow();
 expect(()=>assertStoredConnectedAppAccess(bot,{complete:true,requirements:[{tool:'GMAIL_SEND_EMAIL',account}]},{noLimits:true})).not.toThrow();
 expect(restrictedConnectorTools(bot,1,true)).toBeNull();expect(connectedAppsListScope(bot,0,true)).not.toHaveProperty('initialTools');
 expect(()=>assertConnectedAppCall(bot,call)).toThrow();expect(JSON.stringify(bot.connectedAppAccess)).toBe(before);
 bot.composio=false;expect(()=>assertConnectedAppCall(bot,call,{noLimits:true})).toThrow('disabled');
});
