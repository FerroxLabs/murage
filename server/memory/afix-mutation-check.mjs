// Isolated-container runner. Product sources are always restored.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const cases=[
 ['AM1-http-authority-omitted','server/memory/http-authority.ts',
  'const authority = /\\/(?:save|propose-correction)$/.test(path) ? memoryHttpAuthority(registry,capability) : options?.authority;',
  'const authority = options?.authority;',
  ['server/memory/verify-policy.mjs','-t','Field 7']],
 ['AM2-null-prototype-rejection','server/memory/authority.ts',
  'isDeepStrictEqual(structuredClone(call.input),expected)',
  'isDeepStrictEqual(call.input,expected)',
  ['node_modules/vitest/vitest.mjs','run','server/memory/registered-request.test.ts','-t','null-prototype']],
 ['AM3-request-binding-removed','server/memory/authority.ts',
  'if(call.tool!==tool || !isDeepStrictEqual(structuredClone(call.input),expected))throw new Error("MEMORY_REQUEST_MISMATCH");',
  '// MUTANT: no exact request binding',
  ['node_modules/vitest/vitest.mjs','run','--config','server/memory/baseline-binding.config.mjs','-t','R16 baseline']],
 ['AM4-durable-queue-omitted','server/memory/service-approval.ts',
  "if(!prior)this.replace({item,base:request.base,state:'waiting'});",
  '// MUTANT: no durable queue',
  ['node_modules/vitest/vitest.mjs','run','--config','server/memory/baseline-binding.config.mjs','-t','A2/A4a baseline']],
];
const output='server/memory/.afix-evidence/mutants';mkdirSync(output,{recursive:true});let failures=0;
for(const [name,file,before,after,args] of cases){
 const original=readFileSync(file,'utf8');if(!original.includes(before))throw new Error('Missing mutation target: '+name);
 try{
  writeFileSync(file,original.replace(before,after));
  const result=spawnSync(process.execPath,args,{encoding:'utf8',timeout:240000});
  const log=`COMMAND ${JSON.stringify([process.execPath,...args])}\n${result.stdout??''}${result.stderr??''}`;
  writeFileSync(`${output}/${name}.log`,log);
  const killed=result.status!==0&&result.signal===null&&/AssertionError/.test(log)&&/Tests\s+\d+ failed/.test(log);
  console.log(`${name}: ${killed?'KILLED':'SURVIVED OR INVALID'} exit=${result.status}`);if(!killed)failures++;
 }finally{writeFileSync(file,original);}
}
if(failures)process.exitCode=1;
