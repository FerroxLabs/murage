// Producer owner: sc-safety (lane workflow evidence). Runner owner: sc-safety-rd2 (isolated child and cleanup).
import { launchVerificationServer, runControlMurage } from '../../../scripts/control-murage.ts';
import { writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
const index=process.argv.indexOf('--out'),out=resolve(process.argv[index+1]??'');
if(index<0||!relative(process.cwd(),out).startsWith('..')||/^\/dev(?:\/|$)/.test(out))throw Error('External evidence --out required');
mkdirSync(out,{recursive:true});
const fixture=await launchVerificationServer(process.env,undefined,{separateHome:true});
const env={MURAGE_URL:fixture.info.url,MURAGE_DATA_DIR:fixture.info.dataDir};
const actions=[];
try {
 const doctor=await runControlMurage(['doctor','--url',fixture.info.url],{env});
 actions.push({command:'doctor',result:doctor});
 if(!doctor?.ok)throw Error('Fixture doctor refused');
 const created=await runControlMurage(['new-bot','--name','Fixture Probe','--url',fixture.info.url],{env});
 const id=created?.bot?.id;
 if(typeof id!=='string')throw Error('Fixture bot was not created');
 actions.push({command:'new-bot',botId:id});
 const sent=await runControlMurage(['send','--bot',id,'--text','hello from the isolated fixture','--url',fixture.info.url],{env});
 actions.push({command:'send',result:sent});
 const settled=await runControlMurage(['wait','--bot',id,'--timeout','20','--url',fixture.info.url],{env});
 actions.push({command:'wait',result:settled});
 if(settled?.status!=='settled')throw Error('Fixture did not settle');
 const transcript=await runControlMurage(['messages','--bot',id,'--limit','10','--url',fixture.info.url],{env});
 actions.push({command:'messages',result:transcript});
 if(!transcript?.messages?.some(message=>message.role==='bot'))throw Error('Fixture reply missing');
} finally {
 await fixture.close();
 copyFileSync(fixture.info.logPath,join(out,'server.log'));
 writeFileSync(join(out,'workflow.json'),JSON.stringify({actions,dataRemoved:!existsSync(fixture.info.dataDir)},null,2));
}
process.stdout.write('ISOLATED_WORKFLOW PASS\n');
