// B35 diagnosis only. Imported by the private patch; never an acceptance check.
import {existsSync,readFileSync,rmSync} from 'node:fs';
import path from 'node:path';

export function mainThreadSample(raw){
 const lines=String(raw).split(/\r?\n/),begin=lines.findIndex(line=>/^Call graph:/.test(line));
 if(begin<0)return {ok:false,error:'SAMPLE_CALL_GRAPH_MISSING'};
 const starts=[];
 for(let i=begin+1;i<lines.length;i++)if(/^\s+\d+\s+Thread[_ ]/.test(lines[i]))starts.push(i);
 const main=starts.filter(i=>/com\.apple\.main-thread|DispatchQueue_1\b/.test(lines[i]));
 if(main.length!==1)return {ok:false,error:'SAMPLE_MAIN_THREAD_AMBIGUOUS',count:main.length};
 const start=main[0],next=starts.find(i=>i>start),summary=lines.findIndex((line,i)=>i>start&&/^(Total number|Sort by top|Binary Images)/.test(line));
 const end=Math.min(next??lines.length,summary<0?lines.length:summary);
 return {ok:true,stack:lines.slice(start,end).join('\n').trimEnd()};
}

export function captureMainSample({pid,expectedExecutable,privateDir,deadline,run,redact}){
 const started=Date.now(),remaining=()=>Math.max(1,deadline-Date.now());
 if(remaining()<5000)return {ok:false,error:'SAMPLE_DEADLINE_BUDGET',pid};
 const inventory=()=>{
  const result=run('/bin/ps',['-axo','pid=,ppid=,stat=,comm='],{timeout:Math.min(500,remaining())});
  if(result.code!==0)return {ok:false,code:result.code,error:result.error,timedOut:result.timedOut};
  const rows=result.stdout.split('\n').flatMap(line=>{const m=/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);return m?[{pid:Number(m[1]),ppid:Number(m[2]),state:m[3],executable:m[4]}]:[];});
  return {ok:true,rows:rows.filter(row=>row.pid===pid||row.ppid===pid)};
 };
 const before=inventory();
 if(!before.ok||!before.rows.some(row=>row.pid===pid&&row.executable===expectedExecutable))return {ok:false,error:'SAMPLE_OWNER_UNCONFIRMED',pid,before};
 const file=path.join(privateDir,'b35-owned-main-sample.txt');
 if(existsSync(file))return {ok:false,error:'SAMPLE_FILE_EXISTS',pid};
 let result,parsed={ok:false,error:'SAMPLE_OUTPUT_MISSING'};
 try{
  result=run('/usr/bin/sample',[String(pid),'1','1','-file',file],{timeout:Math.min(4000,remaining())});
  if(existsSync(file))parsed=mainThreadSample(readFileSync(file,'utf8'));
 }finally{if(existsSync(file))rmSync(file);}
 const after=remaining()>500?inventory():{ok:false,error:'SAMPLE_DEADLINE_BUDGET'};
 const sanitize=value=>typeof value==='string'?redact(value):Array.isArray(value)?value.map(sanitize):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,sanitize(item)])):value;
 const sanitized=sanitize({before,after,...parsed});
 return {...sanitized,ok:result.code===0&&parsed.ok,pid,elapsedMs:Date.now()-started,code:result.code,signal:result.signal,timedOut:result.timedOut,error:result.error??(parsed.ok?null:parsed.error),stderr:redact(result.stderr).slice(-1200),perturbation:'One second of intermittent sampling; diagnostic evidence only.'};
}
