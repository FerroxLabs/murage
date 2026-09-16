import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFileSync,realpathSync} from 'node:fs';
import {join,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {memoryReading,privateDirectory} from './runtime.mjs';
export function processSummary(text){
 const rows=text.trim().split('\n').filter(Boolean).map(line=>{const m=/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);assert(m,'Invalid process RSS row');return {pid:Number(m[1]),ppid:Number(m[2]),rssBytes:Number(m[3])*1024,name:basename(m[4])};});
 return rows.sort((a,b)=>b.rssBytes-a.rssBytes).slice(0,30);
}
export function resourceSnapshot(){
 const run=(cmd,args)=>execFileSync(cmd,args,{encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
 const vmStat=run('/usr/bin/vm_stat',[]),reading=memoryReading(vmStat,run('/usr/sbin/sysctl',['-n','hw.memsize']).trim());
 return {at:new Date().toISOString(),reading,vmStat,processes:processSummary(run('/bin/ps',['-axo','pid=,ppid=,rss=,comm=']))};
}
export function saveResourceSnapshot(root,label){assert(/^[a-z0-9-]+$/.test(label));privateDirectory(root);privateDirectory(join(root,'evidence'));const snapshot=resourceSnapshot();writeFileSync(join(root,'evidence/resource-'+label+'.json'),JSON.stringify(snapshot,null,2)+'\n',{mode:0o600,flag:'wx'});return snapshot;}
if(process.argv[1]===fileURLToPath(import.meta.url))saveResourceSnapshot(join(realpathSync(process.env.RUNNER_TEMP),'murage-q12'),process.argv[2]);
