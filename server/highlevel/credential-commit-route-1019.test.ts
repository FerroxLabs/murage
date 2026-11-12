import {expect,it} from 'vitest';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {launchVerificationServer,runControlMurage,controlResultSucceeded} from '../../scripts/control-murage.ts';
import {createHighLevelCredentialBridge} from '../../electron/highlevel-credentials.mjs';
const credential='a'.repeat(64);
const connection={connectionId:'conn-fixture',credentialVersion:1,grantId:'grant-fixture',enrollmentId:'home-fixture',runtimeCapability:'runtime-fixture-'.repeat(4),grantCapability:'grant-fixture-'.repeat(4)};
const stage={flowId:'flow-fixture',versionId:'version-fixture',expectedRevision:0,expectedEpoch:0,connection,metadata:{connectionId:connection.connectionId,credentialVersion:1,grantId:connection.grantId,locationId:'location-fixture',connectionEpoch:1,scopes:['contacts.write'],provenance:'oauth-token-response'}};
function electronRequest(sandbox:object) {
 const source=readFileSync(new URL('../../electron/main.mjs',import.meta.url),'utf8'),tree=ts.createSourceFile('main.mjs',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 let request:ts.Expression|undefined;
 const walk=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&node.name.getText(tree)==='highlevelCredentials'&&node.initializer&&ts.isCallExpression(node.initializer)){
  const options=node.initializer.arguments[0];if(options&&ts.isObjectLiteralExpression(options)){const property=options.properties.find(p=>ts.isPropertyAssignment(p)&&p.name.getText(tree)==='request');if(property&&ts.isPropertyAssignment(property))request=property.initializer;}
 }ts.forEachChild(node,walk);};walk(tree);expect(request).toBeDefined();
 return runInNewContext('('+request!.getText(tree)+')',sandbox);
}
it('D8 real Electron credential caller reaches prepare and commit on an isolated server',async()=>{
 const fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:`
  const {EventEmitter}=await import('node:events'),fs=await import('node:fs'),path=await import('node:path');
  const events=new EventEmitter();let bootstrapped=false,staged=false;
  const port={on(event,listener){events.on(event,listener);if(bootstrapped&&!staged){staged=true;setImmediate(()=>events.emit('message',{data:{type:'murage:highlevel-stage-credential',stage:${JSON.stringify(stage)}}}));}return port;},removeListener(event,listener){events.removeListener(event,listener);return port;},postMessage(message){
   if(message.type==='murage:desktop-secret')fs.writeFileSync(path.join(process.env.MURAGE_DATA_DIR,'fixture-desktop-secret'),message.secret);
   if(message.type==='murage:highlevel-bootstrap-request'){bootstrapped=true;events.emit('message',{data:{type:'murage:highlevel-bootstrap',requestId:message.requestId,bootstrap:{schema:1,commitCredential:${JSON.stringify(credential)},bank:null}}});}
  }};Object.defineProperty(process,'parentPort',{value:port,configurable:true});
 `});
 try {
  const secret=readFileSync(join(fixture.info.dataDir,'fixture-desktop-secret'),'utf8'),statuses:number[]=[];
  const request=electronRequest({SERVER_PORT:Number(new URL(fixture.info.url).port),serverProc:{},ensureDesktopSurfaceSecret:async()=>true,desktopSurfaceSecret:secret,AbortSignal,
   fetch:async(...args:Parameters<typeof fetch>)=>{const response=await fetch(...args);statuses.push(response.status);return response;}});
  let document:any={};
  const bridge=createHighLevelCredentialBridge({commitCredential:credential,readDocument:()=>document,assertSafeStorage:async()=>{},updateDocument:async(derive:any)=>{document=derive(document);},request});
  expect(await bridge.commit({flowId:stage.flowId,versionId:stage.versionId})).toEqual({ok:true});
  expect(statuses).toEqual([200,200]);expect(document.highlevelBank.connection).toEqual(connection);
  const metadata=JSON.parse(readFileSync(join(fixture.info.dataDir,'highlevel','credential-metadata.json'),'utf8'));
  expect(metadata).toMatchObject({epoch:1,metadata:{connectionId:connection.connectionId,bankRevision:1}});
  expect(JSON.stringify(metadata)).not.toContain(connection.runtimeCapability);
  const unauthorized=await fetch(fixture.info.url+'/api/highlevel/credential-commit/prepare',{method:'POST',headers:{'content-type':'application/json','x-murage-surface':'desktop','x-murage-surface-secret':secret,authorization:'Bearer wrong'},body:JSON.stringify({flowId:stage.flowId,versionId:stage.versionId})});
  expect(unauthorized.status).toBe(403);
  const doctor=await runControlMurage(['doctor','--url',fixture.info.url]);expect(controlResultSucceeded("doctor",doctor)).toBe(true);
  const out=join(process.cwd(),'.data-fix-evidence');mkdirSync(out,{recursive:true});writeFileSync(join(out,'D8-fixture-flow.json'),JSON.stringify({fixture:fixture.info,statuses,committed:true,unauthorizedStatus:unauthorized.status,doctor},null,2));
 } finally {await fixture.close();}
},120000);
