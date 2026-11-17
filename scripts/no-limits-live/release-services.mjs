// Gate-only loopback provider stubs. No live credential or outbound network.
import '../../server/testing/idle-load-preload.mjs';
import {boxFixture} from './box-fixture.mjs';
import {dirname} from 'node:path';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
process.env.NODE_ENV='test';globalThis[Symbol.for('murage.hostPower.testUnwrapped')]=true;
const dir=process.env.MURAGE_DATA_DIR;
const path=join(dir,'config.json'),cfg=JSON.parse(readFileSync(path,'utf8'));
cfg.features={...cfg.features,projectsAutonomy:true};cfg.flux={...cfg.flux,apiKey:'sk-flux-verificationfixture'};writeFileSync(path,JSON.stringify(cfg));
process.env.MURAGE_EMAIL_SECRETS=JSON.stringify({owner:{token:'owner-fixture-token',keyId:'key_owner_fixture'}});
const box=boxFixture(dirname(dir));
if(Object.values(cfg.instances??{}).some(i=>i.driver==='boxAgent'&&i.environment?.NOLIM_RELEASE_FAKE==='1')){cfg.box={token:'fixture-key'};writeFileSync(path,JSON.stringify(cfg));}
const original=globalThis.fetch;
globalThis.fetch=async(input,init)=>{
 const url=new URL(String(input instanceof Request?input.url:input));if(url.protocol!=='https:')return original(input,init);
 if(url.origin==='https://ascii.dev'&&url.pathname.startsWith('/api/box/v1/')&&Object.values(cfg.instances??{}).some(i=>i.driver==='boxAgent'&&i.environment?.NOLIM_RELEASE_FAKE==='1'))return box(url,init);
 if(!/(^|\.)fluxrouter\.ai$/.test(url.hostname))throw Error('External network refused by release fixture');
 const method=String(init?.method??'GET').toUpperCase(),p=url.pathname;
 if(p==='/v1/email/capabilities')return Response.json({object:'email.capabilities',enabled:true,available:true,account_state:'active',terms_version:'v1',limits:{max_inboxes:5}});
 if(method==='POST'&&p==='/api/desktop/bot-keys')return Response.json({key:'bot-email-fixture',key_id:'key_bot_fixture'},{status:201});
 if(method==='POST'&&p==='/v1/email/inboxes'){const b=JSON.parse(String(init.body));return Response.json({id:'ibx_fixture',bot_id:b.bot_id,address:'fixture@murage.email',state:'active',send_policy:'auto'},{status:201});}
 if(method==='GET'&&p==='/v1/email/inboxes/ibx_fixture')return Response.json({id:'ibx_fixture',address:'fixture@murage.email',state:'active',sends_today:0,daily_send_cap:50});
 if(method==='POST'&&p==='/v1/email/inboxes/ibx_fixture/recipients')return Response.json({entry:'fixture@example.test',rule:'allow'});
 if(method==='POST'&&p==='/v1/email/inboxes/ibx_fixture/messages'){const body=JSON.parse(String(init.body));appendFileSync(join(dir,'s3-email-capture.ndjson'),JSON.stringify({subject:body.subject,text:body.text,to:body.to})+'\n');return Response.json({status:'sent',message_id:'msg_fixture'});}
 return Response.json({error:'not_found'},{status:404});
};
