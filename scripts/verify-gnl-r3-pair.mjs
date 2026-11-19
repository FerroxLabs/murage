// Two independently copied fixtures; no source or generated proof inputs are shared.
import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
const [mode,outArg]=process.argv.slice(2),out=resolve(outArg);mkdirSync(out,{recursive:true});
const results=await Promise.all([1,2].map(shard=>new Promise(resolve=>{
 const child=spawn(process.execPath,['scripts/verify-gnl-r3-compare.mjs',mode,join(out,'shard-'+shard),shard+'/2'],{stdio:['ignore','inherit','inherit']});
 child.on('exit',(code,signal)=>resolve({shard,code,signal}));
})));
writeFileSync(join(out,'runs.json'),JSON.stringify(results,null,2));process.exitCode=results.some(r=>r.code!==0)?1:0;
