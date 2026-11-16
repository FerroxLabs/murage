import {readFileSync,writeFileSync,existsSync,unlinkSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const root='server/memory/.afix-evidence',manifest=JSON.parse(readFileSync(`${root}/policy-source/manifest.json`));
const originals=new Map();
try{
 console.log('S1 production dependency: '+JSON.stringify(manifest));
 for(const {path,sha256} of manifest.files){
  if(createHash('sha256').update(readFileSync(`${root}/policy-source/${path}`)).digest('hex')!==sha256)throw new Error('Policy snapshot hash mismatch: '+path);originals.set(path,existsSync(path)?readFileSync(path):null);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,readFileSync(`${root}/policy-source/${path}`));}
 const implementation='server/decision/implementation.ts';
 writeFileSync(implementation,readFileSync(implementation,'utf8')+'\n'+readFileSync('server/memory/policy-sync-bridge.fixture.txt','utf8'));
 const run=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run','--config','server/memory/field-policy.config.mjs',...process.argv.slice(2)],{stdio:'inherit',timeout:240000});
 process.exitCode=run.status??1;
}finally{for(const [path,value] of originals){if(value===null)unlinkSync(path);else writeFileSync(path,value);}}
