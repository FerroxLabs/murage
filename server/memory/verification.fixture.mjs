// Isolated fake-engine server smoke using docs/verification/README.md's launcher.
import { launchVerificationServer, runControlMurage } from '../../scripts/control-murage.ts';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
const output='server/memory/.s2m-evidence';mkdirSync(output,{recursive:true});
const fixture=await launchVerificationServer(process.env,undefined,{readyTimeoutMs:120000});
console.log(JSON.stringify({fixture:fixture.info}));
try{
 const doctor=await runControlMurage(['doctor','--url',fixture.info.url]);
 console.log(JSON.stringify({doctor}));
 if(!doctor.ok)throw new Error('isolated fixture doctor failed');
 writeFileSync(`${output}/fixture-doctor.json`,JSON.stringify({fixture:fixture.info,doctor},null,2));
}finally{
 writeFileSync(`${output}/fixture-server.log`,readFileSync(fixture.info.logPath));
 await fixture.close();
 console.log(JSON.stringify({closed:true,dataDirRemoved:!existsSync(fixture.info.dataDir)}));
}
