// Harness transport consumer owner: gnl-harness-r9. Decision/browser owner: MAIN.
import {expect,it} from 'vitest';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {Store} from '../../server/store.ts';
import {serviceDecisionFixture} from '../../server/testing/service-decision-fixture.ts';
import {createBrowserExtensionService} from '../../server/browser-extension-service.ts';
import {startBrowserExtensionBroker} from '../../server/browser-extension-broker.ts';
import {BrowserExtensionSites} from '../../server/browser-extension-sites.ts';
import {BrowserExtensionApprovals} from '../../server/browser-extension-approvals.ts';
import {removeTempDir} from '../../server/testing/cleanup.ts';
import {attachFixtureExtension,fixtureExtensionEngine} from './browser-fixture.mjs';
it('the selected fixture profile executes through the real browser service with its saved Never rule intact',async()=>{
 const root=mkdtempSync(join(tmpdir(),'nolim-live-browser-'));let broker,service,hits=0;
 const site=createServer((_req,res)=>{hits++;res.end('Fixture service page');});
 await new Promise(resolve=>site.listen(0,'127.0.0.1',resolve));
 try{
  const url=`http://127.0.0.1:${site.address().port}/stored-rule/service`,origin=new URL(url).origin;
  const store=new Store(),bot=store.createBot({name:'Browser fixture'},{seedMessages:false});
  store.patchBot(bot.id,{autoApprove:true,fullAccess:true,noLimits:true,permissionExplicit:true});
  const authority=serviceDecisionFixture(store,{botId:bot.id,threadId:bot.threadId,generation:'fixture-generation'},()=> 'unlimited');
  const approvals=new BrowserExtensionApprovals({store,broadcast(){},authorityFor:()=>authority});
  const sites=new BrowserExtensionSites(join(root,'sites.json'));sites.set(bot.id,'default',origin,'never');
  const directory=join(root,'native');mkdirSync(directory,{mode:0o700});
  broker=await startBrowserExtensionBroker({stateDir:directory});await attachFixtureExtension(broker);
  service=await createBrowserExtensionService({broker,workspaceId:'fixture',stateFile:join(root,'state.json'),createEngine:fixtureExtensionEngine,protectedOrigins:[],
   ownerInstruction:()=>({id:'fixture-message',text:`Open ${url}`}),authorityFor:()=>authority,
   siteSetting:(context,requested)=>sites.list(context.botId,context.profileId).find(s=>s.origin===requested),
   savedNever:context=>sites.list(context.botId,context.profileId).filter(s=>s.rule==='never').map(s=>s.origin),
   askSite:async(context,requested,binding)=>await approvals.ask({bot,threadId:bot.threadId,bindingId:context.bindingId,generation:context.generation,digest:binding.actionDigest,summary:'Fixture site access',binding,kind:'site',call:{tool:'browser_site',input:{origin:requested}}})==='allow'?'allow':'never',
   askAction:async(context,action,binding)=>await approvals.ask({bot,threadId:bot.threadId,bindingId:context.bindingId,generation:context.generation,digest:action.digest,summary:'Fixture browser action',binding,kind:'action',call:{tool:action.name,input:action}})==='allow',
  });
  const binding=await service.ensureBinding({botId:bot.id,threadId:bot.threadId,profileId:'default'});
  const result=await service.dispatch(binding.bindingId,'agent_browser_open',{url},()=>true);
  expect(JSON.stringify(result)).toContain('Fixture service page');expect(hits).toBe(1);
  expect(sites.list(bot.id,'default')).toEqual([{origin,rule:'never'}]);
  expect(service.status().bindings.find(b=>b.bindingId===binding.bindingId).profileId).toBe('default');
  expect(store.messagesFor(bot.threadId).filter(m=>m.kind==='options')).toEqual([]);
 }finally{await service?.close();await broker?.close();site.closeAllConnections();await new Promise(resolve=>site.close(resolve));await removeTempDir(root);}
});
