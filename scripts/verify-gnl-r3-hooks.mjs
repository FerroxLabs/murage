import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
const out=resolve(process.argv[2]);mkdirSync(out,{recursive:true});
const results=await Promise.all(['baseline-hooks','final-hooks'].map(mode=>new Promise(resolve=>{
 const child=spawn(process.execPath,['scripts/verify-gnl-r3-compare.mjs',mode,join(out,mode)],{stdio:['ignore','inherit','inherit']});
 child.on('exit',(code,signal)=>resolve({mode,code,signal}));
})));
writeFileSync(join(out,'runs.json'),JSON.stringify(results,null,2));
