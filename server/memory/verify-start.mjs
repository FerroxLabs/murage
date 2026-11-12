import {readFileSync,writeFileSync,existsSync,unlinkSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root='server/memory/.afix-evidence',manifest=JSON.parse(readFileSync(`${root}/start-source/manifest.json`)), originals=new Map();
try{
 for(const file of [...manifest.files,'server/memory/http-authority.ts','server/memory/service-approval.ts']){
  originals.set(file,existsSync(file)?readFileSync(file):null);
  if(manifest.files.includes(file)){const source=readFileSync(`${root}/start-source/${file}`);if(createHash('sha256').update(source).digest('hex')!==manifest.sha256[file])throw new Error('Start snapshot hash mismatch: '+file);writeFileSync(file,source);}else if(file.endsWith('http-authority.ts'))writeFileSync(file,"import {memoryAgentRoute} from './routes.ts'; export function authenticatedMemoryAgentRoute(_registry,_capability,...args){return memoryAgentRoute(...args);}");else if(existsSync(file))unlinkSync(file);
 }
 const args=process.argv[2]==='field'?['server/memory/verify-policy.mjs','-t','Field 7']:['node_modules/vitest/vitest.mjs','run','--config','server/memory/baseline-binding.config.mjs'];
 console.log(`BASELINE ${manifest.commit}; exact product sources restored in finally; COMMAND ${JSON.stringify([process.execPath,...args])}`);
 const run=spawnSync(process.execPath,args,{stdio:'inherit',timeout:240000});process.exitCode=run.status??1;
}finally{for(const [file,value]of originals){if(value===null){if(existsSync(file))unlinkSync(file);}else writeFileSync(file,value);}}
