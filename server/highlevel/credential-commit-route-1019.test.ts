import {expect,it} from 'vitest';
import {existsSync,mkdirSync,readFileSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {launchVerificationServer,runControlMurage,controlResultSucceeded} from '../../scripts/control-murage.ts';
import {createHighLevelCredentialBridge} from '../../electron/highlevel-credentials.mjs';
const credential='a'.repeat(64);
const connection={connectionId:'conn-fixture',credentialVersion:1,grantId:'grant-fixture',enrollmentId:'home-fixture',runtimeCapability:Buffer.alloc(32,7).toString('base64url'),grantCapability:Buffer.alloc(32,8).toString('base64url')};
const stage={flowId:'flow-fixture',versionId:'version-fixture',expectedRevision:0,expectedEpoch:0,connection,metadata:{connectionId:connection.connectionId,credentialVersion:1,grantId:connection.grantId,locationId:'location-fixture',connectionEpoch:1,scopes:['contacts.readonly','contacts.write'],provenance:'oauth-token-response'}};
function electronRequest(sandbox:object) {
 const source=readFileSync(new URL('../../electron/main.mjs',import.meta.url),'utf8'),tree=ts.createSourceFile('main.mjs',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 let request:ts.Expression|undefined;
 const walk=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&node.name.getText(tree)==='highlevelCredentials'&&node.initializer&&ts.isCallExpression(node.initializer)){
  const options=node.initializer.arguments[0];if(options&&ts.isObjectLiteralExpression(options)){const property=options.properties.find(p=>ts.isPropertyAssignment(p)&&p.name.getText(tree)==='request');if(property&&ts.isPropertyAssignment(property))request=property.initializer;}
 }ts.forEachChild(node,walk);};walk(tree);expect(request).toBeDefined();
 return runInNewContext('('+request!.getText(tree)+')',sandbox);
}
it.each(['normal','interrupted'] as const)('D8 real Electron credential caller reaches prepare and commit on an isolated server (%s disconnect)',async(mode)=>{
 const fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:`
  const {EventEmitter}=await import('node:events'),fs=await import('node:fs'),path=await import('node:path');
  const events=new EventEmitter();
  const port={on(event,listener){events.on(event,listener);return port;},removeListener(event,listener){events.removeListener(event,listener);return port;},postMessage(message){
   if(message.type==='murage:desktop-secret')fs.writeFileSync(path.join(process.env.MURAGE_DATA_DIR,'fixture-desktop-secret'),message.secret);
   if(message.type==='murage:highlevel-bootstrap-request'){events.emit('message',{data:{type:'murage:highlevel-bootstrap',requestId:message.requestId,bootstrap:{schema:1,commitCredential:${JSON.stringify(credential)},bank:fs.existsSync(path.join(process.env.MURAGE_DATA_DIR,'fixture-bank.json'))?JSON.parse(fs.readFileSync(path.join(process.env.MURAGE_DATA_DIR,'fixture-bank.json'),'utf8')):null}}});}
  }};
  const data=process.env.MURAGE_DATA_DIR,ask=path.join(data,'ask');fs.mkdirSync(ask,{recursive:true});
  const {BUILT_IN_DRIVERS}=await import(${JSON.stringify(new URL('../drivers/builtIn.ts',import.meta.url).href)});
  const {makeAskDriver}=await import(${JSON.stringify(new URL('../testing/fake-ask-driver.ts',import.meta.url).href)});
  const driver=makeAskDriver(),create=driver.create;
  driver.create=async function(input){const instance=await create.call(this,input),send=instance.adapter.sendTurn;
   instance.adapter.sendTurn=async turn=>{if(turn.integrations?.highlevel)fs.writeFileSync(path.join(ask,turn.threadId+'.json'),JSON.stringify(turn.integrations.highlevel.env));return send.call(instance.adapter,turn);};return instance;};BUILT_IN_DRIVERS.push(driver);
  const {PHONE_JOBS_ENGINES}=await import(${JSON.stringify(new URL('../phone-jobs-engines.ts',import.meta.url).href)});PHONE_JOBS_ENGINES.fakeAsk={mounts:true,where:'isolated D8 fixture'};
  const configFile=path.join(data,'config.json'),config=JSON.parse(fs.readFileSync(configFile,'utf8'));
  config.instances.queues={driver:'fakeAsk',displayName:'D8 fixture',environment:{FAKE_ASK_DIR:ask,FAKE_ASK_TOOLS:'1'}};fs.writeFileSync(configFile,JSON.stringify(config));
  const realFetch=globalThis.fetch;globalThis.fetch=async(input,init)=>{
   const url=new URL(input instanceof Request?input.url:String(input));
   if(url.origin==='https://services.leadconnectorhq.com'){
    if(init.headers.authorization!=='Bearer fixture-access-only')throw Error('Wrong provider credential');
    fs.appendFileSync(path.join(data,'provider.jsonl'),JSON.stringify({method:init?.method??'GET',path:url.pathname})+'\\n');
    return Response.json({contact:{id:'contact_1',locationId:'location-fixture',name:'Fixture'}});
   }
   if(url.origin!=='https://connect.murage.ai')return realFetch(input,init);
   if(url.pathname==='/v1/crm/lease'||url.pathname==='/v1/crm/disconnect'){
    const body=JSON.parse(init.body),env=JSON.parse(Buffer.from(init.headers['x-murage-runtime'],'base64url'));
    const {createHmac,createHash}=await import('node:crypto');
    const {canonicalRuntimeMessage}=await import(${JSON.stringify(new URL('../../cloudflare/crm-broker/src/runtime-auth.ts',import.meta.url).href)});
    const {signature,...unsigned}=env;
    if(signature!==createHmac('sha256',Buffer.from(${JSON.stringify(connection.runtimeCapability)},'base64url')).update(canonicalRuntimeMessage(url.pathname,'POST',unsigned,createHash('sha256').update(init.body).digest('hex'))).digest('base64url')
     ||init.headers['x-murage-grant']!==${JSON.stringify(connection.grantCapability)}||body.grantId!=='grant-fixture'||body.grantVersion!==1||body.connectionEpoch!==1||body.homeId!==env.homeId)throw Error('Invalid broker authorization');
    fs.appendFileSync(path.join(data,'broker.jsonl'),JSON.stringify({path:url.pathname})+'\\n');
    if(fs.existsSync(path.join(data,'fixture-revoked')))return Response.json({error:'revoked'},{status:401});
    if(url.pathname.endsWith('/disconnect')){fs.writeFileSync(path.join(data,'fixture-revoked'),'');return Response.json({revoked:true});}
    return Response.json({grantId:'grant-fixture',credentialVersion:1,grantVersion:1,connectionEpoch:1,provenance:'oauth-token-response',userType:'Location',locationId:'location-fixture',scopes:['contacts.readonly','contacts.write'],accessToken:'fixture-access-only',expiresAt:Date.now()+3600000});
   }
   if(url.pathname==='/v1/crm/begin'&&fs.existsSync(path.join(data,'fixture-revoked'))&&init.headers['x-murage-runtime'])return Response.json({error:'revoked'},{status:401});
   if(url.pathname==='/v1/crm/begin')return Response.json({flowId:'flow-fixture',authorizationUrl:'https://marketplace.leadconnectorhq.com/v2/oauth/chooselocation?state=fake',completionCapability:'completion-fixture-'.repeat(4),expiresAt:Date.now()+600000},{status:201});
   if(url.pathname==='/v1/crm/complete'&&init?.method==='GET')return Response.json({status:'held',locationId:'location-fixture',locationName:'Fixture',scopes:['contacts.readonly','contacts.write'],missing:[]});
   if(url.pathname==='/v1/crm/complete'&&init?.method==='POST')return Response.json({grant:{grantId:'grant-fixture',credentialVersion:1,grantVersion:1,connectionEpoch:1,provenance:'oauth-token-response',userType:'Location',locationId:'location-fixture',scopes:['contacts.readonly','contacts.write']},enrollmentId:JSON.parse(init.body).homeId,runtimeCapability:${JSON.stringify(connection.runtimeCapability)},grantCapability:${JSON.stringify(connection.grantCapability)}});
   throw Error('Unexpected fake broker request');
  };Object.defineProperty(process,'parentPort',{value:port,configurable:true});
 `});
 try {
  let secret=readFileSync(join(fixture.info.dataDir,'fixture-desktop-secret'),'utf8'),statuses:number[]=[];
  const request=electronRequest({SERVER_PORT:Number(new URL(fixture.info.url).port),serverProc:{},ensureDesktopSurfaceSecret:async()=>true,desktopSurfaceSecret:secret,AbortSignal,
   fetch:async(...args:Parameters<typeof fetch>)=>{const response=await fetch(...args);statuses.push(response.status);return response;}});
  let document:any={};
  const bridge=createHighLevelCredentialBridge({commitCredential:credential,readDocument:()=>document,assertSafeStorage:async()=>{},updateDocument:async(derive:any)=>{document=derive(document);writeFileSync(join(fixture.info.dataDir,'fixture-bank.json'),JSON.stringify(document.highlevelBank));},request});
  const ownerPost=async(action:string,body:object={})=>fetch(fixture.info.url+'/api/highlevel/connect/'+action,{method:'POST',headers:{'content-type':'application/json','x-murage-surface':'desktop','x-murage-surface-secret':secret},body:JSON.stringify(body)});
  const begun=await ownerPost('begin');expect(begun.status).toBe(200);const flow=await begun.json() as {flowId:string};
  expect(flow).toMatchObject({flowId:'flow-fixture'});expect(JSON.stringify(flow)).not.toContain('completion-fixture');
  const before=await bridge.commit({flowId:flow.flowId,versionId:'not-confirmed'});expect(before).toMatchObject({ok:false});statuses.length=0;
  const previewResponse=await ownerPost('preview',{flowId:flow.flowId});expect(previewResponse.status).toBe(200);
  expect(await previewResponse.json()).toMatchObject({status:'held',locationId:'location-fixture'});
  const confirmed=await ownerPost('confirm',{flowId:flow.flowId,locationId:'location-fixture'});expect(confirmed.status).toBe(200);
  const intent=await confirmed.json() as {flowId:string;versionId:string};expect(Object.keys(intent).sort()).toEqual(['flowId','versionId']);
  expect(await bridge.commit(intent)).toEqual({ok:true});
  expect(statuses).toEqual([200,200]);expect(document.highlevelBank.connection).toMatchObject({grantId:connection.grantId,runtimeCapability:connection.runtimeCapability});
  const metadata=JSON.parse(readFileSync(join(fixture.info.dataDir,'highlevel','credential-metadata.json'),'utf8'));
  expect(metadata).toMatchObject({epoch:1,metadata:{connectionId:'hl_location-fixture',bankRevision:1}});
  expect(JSON.stringify(metadata)).not.toContain(connection.runtimeCapability);
  const api=async(method:string,path:string,body?:unknown,headers?:Record<string,string>)=>{const response=await fetch(fixture.info.url+path,{method,headers:{'content-type':'application/json',...(headers??{'x-murage-surface':'desktop','x-murage-surface-secret':secret})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json() as any};};
  const connected=await api('GET','/api/highlevel');expect(connected.body.tokenSaved).toBe(false);
  expect(connected.body.connection).toMatchObject({connectionId:'hl_location-fixture',state:'connected'});
  expect(connected.body.familyScopes.contacts.canChange).toBe(true);
  const created=await api('POST','/api/bots',{name:'Broker fixture',modelSelection:{instanceId:'queues',model:'ask-1'}});expect(created.status).toBe(201);const bot=created.body.bot;
  const {defaultHighLevelFamilies}=await import('../../shared/highlevel.ts');
  expect((await api('PUT',`/api/highlevel/bots/${bot.id}/access`,{grants:[{connectionId:'hl_location-fixture',families:{...defaultHighLevelFamilies(),contacts:'read'}}]})).status).toBe(200);
  const operationResults:unknown[]=[];
  const operation=async()=>{
   const envFile=join(fixture.info.dataDir,'ask',bot.threadId+'.json');if(existsSync(envFile))unlinkSync(envFile);
   writeFileSync(join(fixture.info.dataDir,'ask','hold'),'');
   expect((await api('POST',`/api/bots/${bot.id}/messages`,{text:'Read fixture contact',threadId:bot.threadId,sendId:crypto.randomUUID()})).status).toBe(202);
   let env:Record<string,string>={};await expect.poll(()=>{try{env=JSON.parse(readFileSync(join(fixture.info.dataDir,'ask',bot.threadId+'.json'),'utf8'));return Boolean(env.MURAGE_CONTROL_TOKEN);}catch{return false;}},{timeout:20000}).toBe(true);
   const result=await api('POST','/api/internal/highlevel/mcp',{jsonrpc:'2.0',id:crypto.randomUUID(),method:'tools/call',params:{name:'HIGHLEVEL_CONTACTS',arguments:{operation:'contacts.get',args:{contactId:'contact_1'}}}},{authorization:'Bearer '+env.MURAGE_CONTROL_TOKEN});
   operationResults.push(result);
   expect(result.status).toBe(200);expect(result.body.result.isError).not.toBe(true);
   expect(result.body,JSON.stringify(result.body)).toMatchObject({result:{structuredContent:{outsideContent:'highlevel-crm'}}});
   expect(result.body.result.structuredContent.crm).toContain(JSON.stringify({contact:{id:'contact_1',locationId:'location-fixture',name:'Fixture'}}));
   writeFileSync(join(fixture.info.dataDir,'ask','release'),'');
   await expect.poll(async()=>(await api('GET','/api/bots?messages=0')).body.bots.find((row:any)=>row.id===bot.id)?.busy,{timeout:20000}).toBe(false);
  };
  await operation();
  await fixture.restart();secret=readFileSync(join(fixture.info.dataDir,'fixture-desktop-secret'),'utf8');
  expect((await api('GET','/api/highlevel')).body.connection.state).toBe('connected');
  await operation();
  const disconnected=await api('DELETE','/api/highlevel/connections/hl_location-fixture');expect(disconnected.status).toBe(200);
  // Main persists a bank without the grant before the server acknowledges disconnection.
  const restartBridge=createHighLevelCredentialBridge({commitCredential:credential,readDocument:()=>document,assertSafeStorage:async()=>{},updateDocument:async(derive:any)=>{document=derive(document);writeFileSync(join(fixture.info.dataDir,'fixture-bank.json'),JSON.stringify(document.highlevelBank));},request:async(action:string,body:unknown)=>{if(mode==='interrupted'&&action==='commit')throw Error('fixture exit after bank persisted');const response=await api('POST','/api/highlevel/credential-commit/'+action,body,{'x-murage-surface':'desktop','x-murage-surface-secret':secret,authorization:'Bearer '+credential});if(response.status!==200)throw Error('Commit refused');return response.body;}});
  expect(await restartBridge.commit(disconnected.body.intent)).toEqual(mode==='interrupted'?{ok:false,error:'outcome_unknown'}:{ok:true});
  expect(document.highlevelBank.connection).toBeNull();
  expect(JSON.parse(readFileSync(join(fixture.info.dataDir,'highlevel','credential-metadata.json'),'utf8'))).toMatchObject(mode==='interrupted'?{epoch:1,metadata:{connectionId:'hl_location-fixture'}}:{epoch:2,metadata:null});
  expect((await api('GET','/api/highlevel')).body.connection).toBeNull();
  await fixture.restart();secret=readFileSync(join(fixture.info.dataDir,'fixture-desktop-secret'),'utf8');
  expect((await api('GET','/api/highlevel')).body.connection).toBeNull();
  expect(JSON.parse(readFileSync(join(fixture.info.dataDir,'highlevel','credential-metadata.json'),'utf8'))).toEqual({epoch:2,metadata:null});
  // Fresh sign-in retries only the durable revoke journal, never its old enrollment.
  expect((await ownerPost('begin')).status).toBe(200);
  const brokerCalls=readFileSync(join(fixture.info.dataDir,'broker.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  expect(brokerCalls.map(row=>row.path)).toEqual(['/v1/crm/lease','/v1/crm/lease',...(mode==='normal'?['/v1/crm/disconnect']:[]),'/v1/crm/disconnect']);
  const providerCalls=readFileSync(join(fixture.info.dataDir,'provider.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  expect(providerCalls).toEqual(Array.from({length:4},()=>({method:'GET',path:'/contacts/contact_1'})));
  const unauthorized=await fetch(fixture.info.url+'/api/highlevel/credential-commit/prepare',{method:'POST',headers:{'content-type':'application/json','x-murage-surface':'desktop','x-murage-surface-secret':secret,authorization:'Bearer wrong'},body:JSON.stringify({flowId:stage.flowId,versionId:stage.versionId})});
  expect(unauthorized.status).toBe(403);
  const doctor=await runControlMurage(['doctor','--url',fixture.info.url]);expect(controlResultSucceeded("doctor",doctor)).toBe(true);
  const out=join(process.cwd(),'.afix-data-fix-r3-evidence','workflow-'+mode);mkdirSync(out,{recursive:true});writeFileSync(join(out,'D8-server.log'),readFileSync(fixture.info.logPath));writeFileSync(join(out,'D8-fixture-flow.json'),JSON.stringify({fixture:fixture.info,statuses,brokerCalls,providerCalls,operationResults,connected:connected.body,restarted:true,disconnected:true,committed:true,unauthorizedStatus:unauthorized.status,doctor},null,2));
 } finally {const out=join(process.cwd(),'.afix-data-fix-r3-evidence','workflow-'+mode);mkdirSync(out,{recursive:true});writeFileSync(join(out,'D8-server.log'),readFileSync(fixture.info.logPath));await fixture.close();}
},240000);
