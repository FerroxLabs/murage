import {expect,it} from 'vitest';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {launchVerificationServer,runControlMurage} from '../../scripts/control-murage.ts';
it('isolated fake-engine fixture launches and settles a chat through the documented control surface',async()=>{
 const evidence='server/decision/evidence';mkdirSync(evidence,{recursive:true});
 const fixture=await launchVerificationServer(process.env,undefined,{readyTimeoutMs:90000,turnLog:{replies:['Fixture reply.']}});
 const commands:string[][]=[];
 const run=async(command:string,...args:string[])=>{
  const argv=[command,...args,'--url',fixture.info.url];commands.push(argv);
  writeFileSync(evidence+'/fixture-commands.json',JSON.stringify(commands,null,2));
  const result=await runControlMurage(argv,{env:{MURAGE_DATA_DIR:fixture.info.dataDir}});
  writeFileSync(evidence+'/fixture-'+command+'.json',JSON.stringify(result,null,2));return result as any;
 };
 try{
  writeFileSync(evidence+'/fixture-launch.json',JSON.stringify(fixture.info,null,2));
  const doctor=await run('doctor');expect(doctor.ok).toBe(true);expect(doctor.availableEngines).toEqual(['verification']);
  const created=await run('new-bot','--name','Verification Probe');
  await run('send','--bot',created.bot.id,'--text','hello from the isolated fixture');
  const settled=await run('wait','--bot',created.bot.id,'--timeout','30');expect(settled.status).toBe('settled');
  const transcript=await run('messages','--bot',created.bot.id,'--limit','10');
  expect(transcript.messages.some((message:any)=>message.role==='bot'&&message.text?.includes('Fixture reply.'))).toBe(true);
 }finally{await fixture.close();writeFileSync(evidence+'/fixture-server.log',readFileSync(fixture.info.logPath));}
},120000);
