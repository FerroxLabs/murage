import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchVerificationServer, type VerificationServer } from '../scripts/control-murage.ts';
let fixture:VerificationServer;let headers:Record<string,string>;
const instrumentation=`
import {readFileSync,writeFileSync} from 'node:fs';import{join}from'node:path';
const dir=process.env.MURAGE_DATA_DIR;
const cfg=JSON.parse(readFileSync(join(dir,'config.json'),'utf8'));cfg.features={browser:true};writeFileSync(join(dir,'config.json'),JSON.stringify(cfg));
writeFileSync(join(dir,'bots.json'),JSON.stringify([{id:'choice',name:'Ava',threadId:'thread-choice',tasks:[],useMyChrome:true,browserTransport:'extension',browserApproval:'step'}]));
`;
const call=async(path:string,body?:unknown)=>{const response=await fetch(fixture.info.url+path,{headers:{...headers,'content-type':'application/json'},...(body?{method:'PATCH',body:JSON.stringify(body)}:{})});const result={status:response.status,body:await response.json() as any};console.log('S3 choice HTTP',JSON.stringify({path,...result}));return result;};
beforeAll(async()=>{fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:instrumentation});const proof=await(await fetch(fixture.info.url+'/api/desktop-secret')).json() as {secret:string};headers={'x-murage-surface':'desktop','x-murage-surface-secret':proof.secret};console.log('S3 isolated fixture',JSON.stringify(fixture.info));},60000);
afterAll(async()=>{await fixture?.close();});
it('EP B2 HTTP cannot skip disclosure and selection revision advances on a confirmed change',async()=>{
 const preview=await call('/api/bots/choice/browser-choice/preview?mode=builtin');expect(preview.status).toBe(200);expect(preview.body.disclosure.lines[0]).toBe('Ava will stop asking each step.');
 expect(await call('/api/bots/choice',{browserChoice:{mode:'builtin',baseRevision:0,disclosureKey:'stale'}})).toMatchObject({status:409,body:{code:'disclosure_stale'}});
 const applied=await call('/api/bots/choice',{browserChoice:{mode:'builtin',baseRevision:0,disclosureKey:preview.body.disclosure.disclosureKey}});
 expect(applied).toMatchObject({status:200,body:{applied:true,bot:{browserMode:'builtin',selectionRevision:1,browserApproval:'step',previousBrowserChoice:{mode:'chrome-extension'}}}});
 expect(await call('/api/bots/choice',{browserChoice:{mode:'builtin',baseRevision:0,disclosureKey:preview.body.disclosure.disclosureKey}})).toMatchObject({status:409,body:{code:'revision_changed'}});
});
it('EP14 legacy auto without a paired profile resolves direct and never writes extension transport',async()=>{
 const preview=await call('/api/bots/choice/browser-choice/preview?mode=your-chrome');expect(preview.body.proposedRoute).toBe('chrome-direct');
 const applied=await call('/api/bots/choice',{useMyChrome:true,browserTransport:'auto',baseRevision:preview.body.baseRevision,disclosureKey:preview.body.disclosure.disclosureKey});expect(applied.status).toBe(200);expect(applied.body.bot.browserMode).toBe('chrome-direct');expect(applied.body.bot.browserTransport).toBeUndefined();
});
it('preflight checks the chosen browser without changing the selection and rejects unknown browser input',async()=>{
 const before=await call('/api/bots/choice/browser-choice/preview?mode=builtin');
 const extension=await call('/api/bots/choice/browser-choice/preflight?route=chrome-extension&browser=edge');expect(extension).toMatchObject({status:200,body:{browser:'edge',minimum:151}});expect(['supported','update_required','unknown']).toContain(extension.body.status);
 expect(await call('/api/bots/choice/browser-choice/preflight?route=chrome-direct&browser=edge')).toMatchObject({status:200,body:{browser:'chrome',minimum:144}});
 expect(await call('/api/bots/choice/browser-choice/preflight?route=chrome-direct&browser=unknown')).toMatchObject({status:400});
 const after=await call('/api/bots/choice/browser-choice/preview?mode=builtin');expect(after.body.baseRevision).toBe(before.body.baseRevision);
});

it('legacy PATCH without baseRevision still requires the exact reviewed revision and boolean opt-in',async()=>{
 const path='/api/bots/choice';
 const shown=await call(path+'/browser-choice/preview?mode=builtin');
 const before=shown.body.baseRevision;
 expect(await call(path,{useMyChrome:false})).toMatchObject({status:409,body:{code:'disclosure_stale'}});
 const applied=await call(path,{useMyChrome:false,disclosureKey:shown.body.disclosure.disclosureKey});
 expect(applied).toMatchObject({status:200,body:{bot:{browserMode:'builtin',selectionRevision:before+1}}});
 expect(await call(path,{useMyChrome:false,disclosureKey:shown.body.disclosure.disclosureKey})).toMatchObject({status:409,body:{code:'disclosure_stale'}});
 for(const useMyChrome of ['true','false',1,{},null])expect(await call(path,{useMyChrome})).toMatchObject({status:400});
 expect((await call(path+'/browser-choice/preview?mode=builtin')).body.baseRevision).toBe(before+1);
});
