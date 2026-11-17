import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
if(process.argv.includes('--probe')){
 const root=process.env.GNL_PROBE_ROOT,home=join(root,'home'),data=join(root,'data');mkdirSync(home);mkdirSync(data);writeFileSync(join(data,'config.json'),'{}');
 Object.assign(process.env,{HOME:home,USERPROFILE:home,MURAGE_DATA_DIR:data,NODE_ENV:'test'});
 console.log=console.info=console.warn=console.error=()=>{};
 const {productionAdapter}=await import('./production.mjs');const a=await productionAdapter({dataDir:data,home,platform:process.platform});
 try{const got=await a.decide({tool:'Bash',fullToolInput:{command:'rm -rf ~'},label:{actor:'owner',independent:true,kind:'wipe'}});writeFileSync(join(root,'result.json'),JSON.stringify(got));}finally{await a.close();}
}else test('candidate releasing a wipe cannot acquire an invented card from autoVerdict',()=>{
 const dir=mkdtempSync(join(tmpdir(),'gnl-released-wipe-'));try{
  const loader=join(dir,'candidate.mjs'),file=fileURLToPath(new URL('./production.mjs',import.meta.url));
  const sources=process.env.GNL_RED_SOURCE?JSON.parse(readFileSync(process.env.GNL_RED_SOURCE)):null;
  const source=sources?.['scripts/nolim-replay/production.mjs']??readFileSync(file,'utf8');
  const mutated=source.replace('const outcome=d.decide(handle,()=>base);',"const outcome={kind:'run'};").replace('await d.deliverRequest(handle);','delivered=true;');
  assert.notEqual(source,mutated);
  writeFileSync(loader,`import {registerHooks} from 'node:module';registerHooks({load(url,ctx,next){if(url===${JSON.stringify(pathToFileURL(file).href)})return {format:'module',source:${JSON.stringify(mutated)},shortCircuit:true};return next(url,ctx);}});`);
  const r=spawnSync(process.execPath,['--experimental-strip-types','--import',pathToFileURL(loader).href,fileURLToPath(import.meta.url),'--probe'],{encoding:'utf8',timeout:30000,env:{...process.env,NODE_OPTIONS:'',GNL_PROBE_ROOT:dir}});
  assert.equal(r.status,0,r.stderr);const got=JSON.parse(readFileSync(join(dir,'result.json')));
  assert.notEqual(got.kind,'card');assert.equal(got.cards??0,0);assert.equal(got.autoOnly,undefined);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
