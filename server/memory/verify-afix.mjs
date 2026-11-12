// Run through it-remote.sh, in a network-none container with isolated fixtures.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const root='server/memory/.afix-evidence';mkdirSync(root,{recursive:true});
const steps=[
 ['start-binding-red',['server/memory/verify-start.mjs'],12],
 ['start-field-red',['server/memory/verify-start.mjs','field'],30],
 ['candidate-binding-green',['node_modules/vitest/vitest.mjs','run','--config','server/memory/baseline-binding.config.mjs']],
 ['candidate-memory-green',['node_modules/vitest/vitest.mjs','run','server/memory/registered-request.test.ts','server/memory/service-approval.test.ts']],
 ['fix-mutants',['server/memory/afix-mutation-check.mjs']],
 ['inherited-mutants',['server/memory/mutation-check.mjs']],
 ['field-green',['server/memory/verify-policy.mjs']],
 ['base-regression',['node_modules/vitest/vitest.mjs','run','server/memory/routes.test.ts','server/memory/correction-approval.test.ts','server/memory/automatic-learning.test.ts','server/memory/learning-guard.test.ts']],
 ['isolated-launch',['--experimental-strip-types','server/memory/verification.fixture.mjs']],
 ['typecheck',['/tools/bin/pnpm','typecheck']],
];
for(const [name,args,red]of steps){
 let load=Number(readFileSync('/proc/loadavg','utf8').split(' ')[0]);
 while(load>60){console.log(`WAIT load=${load} before ${name}`);await new Promise(r=>setTimeout(r,15000));load=Number(readFileSync('/proc/loadavg','utf8').split(' ')[0]);}
 const executable=name==='typecheck'?'bash':process.execPath;
 const argv=name==='typecheck'?['-c','pnpm typecheck']:args;
 console.log(`START ${name} load=${load} ${new Date().toISOString()}`);
 const run=spawnSync(executable,argv,{encoding:'utf8',timeout:360000,maxBuffer:32*1024*1024});
 const log=`COMMAND ${JSON.stringify([executable,...argv])}\n${run.stdout??''}${run.stderr??''}`;
 writeFileSync(`${root}/${name}.log`,log);
 const match=log.match(/Tests\s+(\d+) failed/);
 const pass=red?run.status===1&&run.signal===null&&Number(match?.[1])===red&&/AssertionError/.test(log)&&!/Failed Suites|TypeError:|ReferenceError:|NotBuilt/.test(log):run.status===0&&run.signal===null;
 console.log(`${pass?'PASS':'FAIL'} ${name} exit=${run.status} ${log.match(/Tests\s+[^\n]+/)?.[0]??''}`);
 if(!pass){console.log(log.slice(-10000));process.exitCode=1;break;}
}
