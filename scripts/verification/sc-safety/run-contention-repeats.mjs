// Owner: sc-safety-rd (repeat counts and immutable test selection).
// Owner: lane runner (isolated container, fixture launch and external evidence).
import {spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync,readdirSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const root=resolve(fileURLToPath(new URL('../../../',import.meta.url)));
const out=resolve(process.env.SC_OUT??'');
if(!process.env.SC_OUT||!relative(root,out).startsWith('..')||out==='/dev'||out.startsWith('/dev/'))throw Error('External SC_OUT is required');
mkdirSync(out,{recursive:true});
const scratch=mkdtempSync(join(out,'repeat-env-')),home=join(scratch,'home'),data=join(scratch,'data'),config=join(scratch,'gitconfig');
mkdirSync(home);mkdirSync(data);writeFileSync(config,'');
const env={PATH:process.env.PATH??'/usr/local/bin:/usr/bin:/bin',HOME:home,CI:'1',LANG:'C.UTF-8',TZ:'UTC',NO_COLOR:'1',FORCE_COLOR:'0',
  NODE_OPTIONS:'--max-old-space-size=12000',ELECTRON_SKIP_BINARY_DOWNLOAD:'1',MURAGE_E2E_DATA_DIR:data,
  GIT_CONFIG_GLOBAL:config,GIT_CONFIG_SYSTEM:config};
const file='server/ledger-refusal-server.test.ts';
const hash=()=>createHash('sha256').update(readFileSync(join(root,file))).digest('hex');
const runtimeHashes=()=>{const values={};const visit=(directory)=>{for(const entry of readdirSync(join(root,directory),{withFileTypes:true})){const name=join(directory,entry.name);if(entry.isDirectory()){if(!['fixtures','node_modules'].includes(entry.name))visit(name);}else if(/\.(?:ts|mjs|json)$/.test(name)&&!name.includes('.test.'))values[name]=createHash('sha256').update(readFileSync(join(root,name))).digest('hex');}};visit('server');visit('shared');return values;};
const before=hash(),runtimeBefore=runtimeHashes(),rows=[];
// The R3 probe instruments SQLite without changing its arguments, timing,
// return values or errors. The original ten ledger/finalizer cases still own
// every behavioral assertion. The logs are observations, never pass evidence.
const probe=join(scratch,'sqlite-observation.mjs');
writeFileSync(probe,`import {DatabaseSync,StatementSync} from 'node:sqlite';
const meta=new WeakMap(),prepare=DatabaseSync.prototype.prepare,exec=DatabaseSync.prototype.exec;
function observe(sql,start,error){const ms=performance.now()-start;if(ms>=25||error?.errcode===5)console.error('SC_SQL_WAIT '+JSON.stringify({operation:String(sql).replace(/'[^']*'/g,'?').replace(/\\s+/g,' ').slice(0,100),ms:Math.round(ms),error:error?.code,errcode:error?.errcode}));}
DatabaseSync.prototype.prepare=function(sql,...args){const stmt=Reflect.apply(prepare,this,[sql,...args]);meta.set(stmt,sql);return stmt;};
DatabaseSync.prototype.exec=function(sql,...args){const start=performance.now();let error;try{return Reflect.apply(exec,this,[sql,...args]);}catch(e){error=e;throw e;}finally{observe(sql,start,error);}};
for(const method of ['run','get','all']){const original=StatementSync.prototype[method];StatementSync.prototype[method]=function(...args){const start=performance.now();let error;try{return Reflect.apply(original,this,args);}catch(e){error=e;throw e;}finally{observe(meta.get(this)??'',start,error);}};}
`);
try{
  for(const [kind,repetitions,pattern,expected]of [['cleanup',25,'T-BUSY-RELEASE',2],['r3-probe',10,undefined,10]]){
    for(let iteration=1;iteration<=repetitions;iteration++){
      const label=`${kind}-${String(iteration).padStart(2,'0')}`,report=join(out,`${label}.json`),started=Date.now();
      const args=['node_modules/vitest/vitest.mjs','run',file,'--reporter=json',`--outputFile=${report}`];
      if(pattern)args.push('--testNamePattern',pattern);
      const caseEnv={...env,SC_LEDGER_EVIDENCE:join(out,'ledger',label)};
      if(kind==='r3-probe')caseEnv.NODE_OPTIONS+=` --import=${pathToFileURL(probe).href}`;
      const run=spawnSync(process.execPath,args,{cwd:root,env:caseEnv,encoding:'utf8',timeout:240000,maxBuffer:32*1024*1024});
      const log=(run.stdout??'')+(run.stderr??'');writeFileSync(join(out,`${label}.log`),log);
      let tests=[];try{tests=JSON.parse(readFileSync(report,'utf8')).testResults.flatMap(suite=>suite.assertionResults??[]).filter(test=>!pattern||test.fullName.includes(pattern)).filter(test=>test.status!=='pending'&&test.status!=='skipped');}catch{}
      const row={kind,iteration,status:run.status,elapsed:Date.now()-started,tests:tests.map(test=>({id:test.fullName,status:test.status})),
        pass:run.status===0&&tests.length===expected&&tests.every(test=>test.status==='passed')};
      if(run.error)row.error=run.error.message;
      rows.push(row);
      writeFileSync(join(out,'CONTENTION-REPEATS.json'),JSON.stringify({sourceBefore:before,sourceAfter:hash(),rows},null,2));
      process.stdout.write(`${label} ${row.pass?'PASS':'FAIL'}\n`);
    }
  }
}finally{rmSync(scratch,{recursive:true,force:true});}
const report={sourceBefore:before,sourceAfter:hash(),cleanup:{passed:rows.filter(row=>row.kind==='cleanup'&&row.pass).length,total:25},
  probe:{passed:rows.filter(row=>row.kind==='r3-probe'&&row.pass).length,total:10},rows};
report.runtimeBefore=runtimeBefore;report.runtimeAfter=runtimeHashes();
report.pass=JSON.stringify(report.runtimeBefore)===JSON.stringify(report.runtimeAfter)&&report.sourceBefore===report.sourceAfter&&rows.length===35&&rows.every(row=>row.pass);
writeFileSync(join(out,'CONTENTION-REPEATS.json'),JSON.stringify(report,null,2));
process.stdout.write(`SC_SAFETY_CONTENTION_REPORT\n${JSON.stringify(report)}\n`);
process.exitCode=report.pass?0:1;
