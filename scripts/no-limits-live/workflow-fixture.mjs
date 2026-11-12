import '../../server/testing/idle-load-preload.mjs';
import {readFileSync,writeFileSync,mkdirSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
// Runs only as the isolated launcher's preload, before the fixture server imports config.
export function installWorkflowFixture(){
 // Existing suite seam: this fixture qualifies HTTP/native workflows, never
 // the operating-system power block. Every installed executable is a fake.
 process.env.NODE_ENV='test';globalThis[Symbol.for('murage.hostPower.testUnwrapped')]=true;
 const dir=process.env.MURAGE_DATA_DIR;if(!dir)throw Error('isolated fixture data directory required');
 const path=join(dir,'config.json'),cfg=JSON.parse(readFileSync(path,'utf8'));
 const state=join(dir,'s3-state');mkdirSync(state,{recursive:true});
 cfg.instances.verification.config.cli=fileURLToPath(new URL('./fakes/workflow-claude.mjs',import.meta.url));
 cfg.instances.verification.environment={S3_STATE_DIR:state,S3_EVENT_LOG:join(dir,'s3-workflow-native.ndjson')};
 cfg.instances['verification-queue']={driver:'piAgent',displayName:'S3 queue fixture',config:{cli:fileURLToPath(new URL('../../server/testing/fake-pi-cli.ts',import.meta.url))},environment:{FAKE_PI_MODE:'stream',FAKE_PI_STREAM_FOR_MS:'4000',FAKE_PI_STREAM_EVERY_MS:'100'}};
 cfg.features={...(cfg.features??{}),projectsAutonomy:true};
 cfg.flux={...(cfg.flux??{}),apiKey:'sk-flux-verificationfixture'};writeFileSync(path,JSON.stringify(cfg));
 process.env.MURAGE_EMAIL_SECRETS=JSON.stringify({owner:{token:'owner-fixture-token',keyId:'key_owner_fixture'}});
 const json=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}}),original=globalThis.fetch;
 globalThis.fetch=async(input,init)=>{
  const url=new URL(String(input instanceof Request?input.url:input));if(url.protocol!=='https:')return original(input,init);
  if(!/(^|\.)fluxrouter\.ai$/.test(url.hostname))throw Error('external network refused by fake fixture');
  const method=String(init?.method??'GET').toUpperCase(),p=url.pathname;
  if(p==='/v1/email/capabilities')return json(200,{object:'email.capabilities',enabled:true,available:true,account_state:'active',terms_version:'v1',limits:{max_inboxes:5}});
  if(method==='POST'&&p==='/api/desktop/bot-keys')return json(201,{key:'bot-email-fixture',key_id:'key_bot_fixture'});
  if(method==='POST'&&p==='/v1/email/inboxes'){const b=JSON.parse(String(init.body));return json(201,{id:'ibx_fixture',bot_id:b.bot_id,address:'fixture@murage.email',state:'active',send_policy:'auto'});}
  if(method==='GET'&&p==='/v1/email/inboxes/ibx_fixture')return json(200,{id:'ibx_fixture',address:'fixture@murage.email',state:'active',sends_today:0,daily_send_cap:50});
  if(method==='POST'&&p==='/v1/email/inboxes/ibx_fixture/recipients')return json(200,{entry:'fixture@example.test',rule:'allow'});
  if(method==='POST'&&p==='/v1/email/inboxes/ibx_fixture/messages'){const body=JSON.parse(String(init.body));appendFileSync(join(dir,'s3-email-capture.ndjson'),JSON.stringify({subject:body.subject,text:body.text,to:body.to})+'\n');return json(200,{status:'sent',message_id:'msg_fixture'});}
  return json(404,{error:'not_found',message:'Not in this fixture.'});
 };
}
