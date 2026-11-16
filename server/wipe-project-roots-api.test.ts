// SPDX-License-Identifier: AGPL-3.0-or-later
// Isolated server, temporary data/home, fake engine only. Never execute wipes.
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { launchVerificationServer, runControlMurage } from '../scripts/control-murage.ts';

it('H4 H5 server roster writes maintain the shared root index without execution-time history scans',async()=>{
 const fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:`
  const fs=await import('node:fs'),path=await import('node:path');
  const {registeredWipeProjects}=await import(${JSON.stringify(new URL('./wipe/registry.ts',import.meta.url).href)});
  const query=path.join(process.env.MURAGE_DATA_DIR,'root-query.json'),result=path.join(process.env.MURAGE_DATA_DIR,'root-result.json');
  let seen=0;
  setInterval(()=>{if(!fs.existsSync(query))return;const input=JSON.parse(fs.readFileSync(query,'utf8'));if(input.seq===seen)return;seen=input.seq;fs.writeFileSync(result+'.next',JSON.stringify({seq:seen,protected:registeredWipeProjects.containsRoot(input.target)}));fs.renameSync(result+'.next',result);},10).unref();
 `}).catch(error=>{
  const destination=process.env.WIPE_FIXTURE_EVIDENCE;
  if(destination){mkdirSync(destination,{recursive:true});for(const name of readdirSync('/tmp/murage-verification-evidence'))copyFileSync(join('/tmp/murage-verification-evidence',name),join(destination,name));}
  throw error;
 });
 const observations:unknown[]=[];
 let seq=0;
 try{
  const proof=await(await fetch(fixture.info.url+'/api/desktop-secret')).json() as {secret:string};
  const headers={'content-type':'application/json','x-murage-surface':'desktop','x-murage-surface-secret':proof.secret};
  const api=async(method:string,path:string,body?:unknown)=>{
   const response=await fetch(fixture.info.url+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
   expect(response.ok).toBe(true);const result=await response.json();observations.push({method,path,status:response.status});return result as any;
  };
  const query=async(target:string,want:boolean)=>{
   const current=++seq;writeFileSync(join(fixture.info.dataDir,'root-query.next'),JSON.stringify({seq:current,target}));
   renameSync(join(fixture.info.dataDir,'root-query.next'),join(fixture.info.dataDir,'root-query.json'));
   await expect.poll(()=>{const file=join(fixture.info.dataDir,'root-result.json');return existsSync(file)?JSON.parse(readFileSync(file,'utf8')):null;},{timeout:10000,interval:25}).toEqual({seq:current,protected:want});
   observations.push({query:current,protected:want});
  };
  const selected=join(fixture.info.dataDir,'selected-project');mkdirSync(selected);
  await query(selected,false);
  const {bot}=await api('POST','/api/bots',{name:'Root registry fixture',modelSelection:{instanceId:'verification',model:'fixture'}});
  await api('PATCH',`/api/bots/${bot.id}`,{cwd:selected});
  await query(selected,true);await query(selected+'/inside',false);
  await api('PATCH',`/api/bots/${bot.id}`,{name:'Root registry updated'});
  await query(selected,true);
  const taskRoot=join(fixture.info.dataDir,'selected-task');mkdirSync(taskRoot);
  await api('PATCH',`/api/bots/${bot.id}/tasks/${bot.threadId}`,{cwd:taskRoot});
  await query(taskRoot,true);
  await api('PATCH',`/api/bots/${bot.id}/tasks/${bot.threadId}`,{cwd:null});
  await query(taskRoot,false);
  const env={MURAGE_DATA_DIR:fixture.info.dataDir};
  const doctor=await runControlMurage(['doctor','--url',fixture.info.url],{env}) as any;
  expect(doctor.ok).toBe(true);expect(doctor.availableEngines).toEqual(['verification']);
  if(process.env.WIPE_FIXTURE_EVIDENCE)writeFileSync(join(process.env.WIPE_FIXTURE_EVIDENCE,'doctor.json'),JSON.stringify(doctor));
  await api('DELETE',`/api/bots/${bot.id}`);
  await query(selected,false);
 }finally{
  // The capture belongs to the disposable fixture, outside the repository.
  writeFileSync(join(fixture.info.dataDir,'root-observations.json'),JSON.stringify(observations));
  if(process.env.WIPE_FIXTURE_EVIDENCE){const out=process.env.WIPE_FIXTURE_EVIDENCE;mkdirSync(out,{recursive:true});copyFileSync(fixture.info.logPath,join(out,'server-fixture.log'));writeFileSync(join(out,'root-observations.json'),JSON.stringify(observations));}
  console.log('isolated root registry verification',JSON.stringify({observations:observations.length,queries:seq}));
  await fixture.close();
  expect(existsSync(fixture.info.dataDir)).toBe(false);
 }
},60000);
