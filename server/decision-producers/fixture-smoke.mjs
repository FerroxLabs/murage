// Isolated, fake-engine smoke using the repository's supported control surface.
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {launchVerificationServer,runControlMurage} from '../../scripts/control-murage.ts';
const evidence='.s2p-fixture-evidence';mkdirSync(evidence,{recursive:true});
const server=await launchVerificationServer({...process.env}).catch(error=>{throw error;});
try{
 console.log(JSON.stringify({launch:server.info}));
 writeFileSync(`${evidence}/launch.json`,JSON.stringify(server.info,null,2));
 const command=async(name,args=[])=>{
  const result=await runControlMurage([name,...args,'--url',server.info.url],{env:{...process.env,MURAGE_DATA_DIR:server.info.dataDir}});
  writeFileSync(`${evidence}/${name}.json`,JSON.stringify(result,null,2));console.log(JSON.stringify({command:name,result}));return result;
 };
 await command('doctor');const created=await command('new-bot',['--name','S2p fixture']);
 const id=created.bot?.id??created.id;if(!id)throw new Error('fixture bot id missing');
 await command('send',['--bot',id,'--text','hello']);
 const waited=await command('wait',['--bot',id,'--timeout','30']);
 if(waited.state!=='settled'&&waited.status!=='settled')throw new Error(`fixture did not settle: ${JSON.stringify(waited)}`);
 await command('messages',['--bot',id,'--limit','10']);
}finally{
 writeFileSync(`${evidence}/server.log`,readFileSync(server.info.logPath));
 await server.close();
}
