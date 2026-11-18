import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.cwd(),out=resolve(process.argv[2]);mkdirSync(out,{recursive:true});
const tests={actions:'scripts/no-limits-live/afix-actions.node-test.mjs',build:'scripts/no-limits-live/afix-build.node-test.mjs',replay:'scripts/nolim-replay/afix-context.node-test.mjs',production:'scripts/nolim-replay/afix-production.node-test.mjs'};
// MAIN RULING: native proof lane 91c4d404cb moved exact input/completion
// checks into native-operation-evidence. Keep the original mutation identities
// and make each remove the corresponding current guard.
const mutations=[
 ['cli-candidate-unbound','scripts/no-limits-live/run.mjs','report.candidate=verifyCandidate(ROOT,options.candidateSha,options.candidateProof??process.env.GNL_CANDIDATE_PROOF);',"report.candidate={candidateSha:options.candidateSha};",'scripts/no-limits-live/afix-cli-binding.node-test.mjs'],
 ['skipped-owner-action','scripts/no-limits-live/action-proof.mjs','return completed && effect;','return true;',tests.actions],
 ['owner-input-substituted','scripts/no-limits-live/native-operation-evidence.mjs',"command(actual.command)===command(wanted.command)",'true',tests.actions],
 // 4aa36aea44 added generation to the completion join; the mutant still drops itemId.
 ['owner-completion-unmatched','scripts/no-limits-live/native-operation-evidence.mjs','[e.threadId,e.turnId,e.itemId,e.provider,e.providerInstanceId,e.generation]','[e.threadId,e.turnId,e.provider,e.providerInstanceId,e.generation]',tests.actions],
 ['owner-effect-missing','scripts/no-limits-live/action-proof.mjs','return completed && effect;','return completed;',tests.actions],
 ['r2-effect-missing','scripts/no-limits-live/r2-scenarios.mjs','&&Number.isSafeInteger(before)&&after===before+1','',tests.actions],
 ['replay-invents-wipe-presentation','scripts/nolim-replay/ruling.mjs','&& presented && !got.autoOnly','',tests.replay],
 ['replay-empty-denial-context','scripts/nolim-replay/replay-decide.mjs',"if (contextNeeded && (",'if (false && (',tests.replay],
 ['candidate-sha-unbound','scripts/no-limits-live/candidate-proof.mjs','(!candidateSha||candidateSha===actual)','true',tests.build],
 ['candidate-content-unbound','scripts/no-limits-live/candidate-proof.mjs',"check(objectHash('blob',bytes)===e.oid);",'',tests.build],
 ['decisions-reparse-history','scripts/no-limits-live/decision-reader.mjs',"const stat=fstatSync(fd),identity=", "this.offset=0;const stat=fstatSync(fd),identity=",tests.build],
];
const old=JSON.parse(readFileSync(join(root,'scripts/no-limits-live/fakes/reviewed-source.json')));
mutations.push(['cli-smoke-only','scripts/no-limits-live/qualify-product-mutant.mjs',readFileSync('scripts/no-limits-live/qualify-product-mutant.mjs','utf8'),old['scripts/no-limits-live/qualify-product-mutant.mjs'],'scripts/no-limits-live/afix-qualification.node-test.mjs']);
const report={releaseGate:false,mutants:[],verdict:'FAIL'};
for(const [id,file,before,after,test]of mutations){
 const source=readFileSync(file,'utf8');if(!source.includes(before))throw Error(`Mutant anchor absent: ${id}`);
 const dir=mkdtempSync(join(tmpdir(),'gnl-afix-mutant-'));try{
  const loader=join(dir,'loader.mjs'),active=join(dir,'active');
  writeFileSync(loader,`import {registerHooks} from 'node:module';import {writeFileSync} from 'node:fs';registerHooks({load(url,ctx,next){if(url===${JSON.stringify(pathToFileURL(join(root,file)).href)}){writeFileSync(${JSON.stringify(active)},'yes');return {format:'module',source:${JSON.stringify(source.replace(before,after))},shortCircuit:true};}return next(url,ctx);}});`);
  const r=spawnSync(process.execPath,['--experimental-strip-types','--test',test],{encoding:'utf8',timeout:200000,env:{...process.env,NODE_OPTIONS:`--import=${pathToFileURL(loader).href}`}});
  const killed=r.status===1&&existsSync(active)&&/fail [1-9]/.test(r.stdout??'');writeFileSync(join(out,id+'.log'),(r.stdout??'')+(r.stderr??''));report.mutants.push({id,killed,activated:existsSync(active),exit:r.status});
 }finally{rmSync(dir,{recursive:true,force:true});}
}
// Restore the precise reviewed autoOnly adapter in the isolated candidate
// probe: the wipe release must be caught rather than converted into a card.
{
 const r=spawnSync(process.execPath,['--experimental-strip-types','--test',tests.production],{encoding:'utf8',timeout:60000,env:{...process.env,GNL_RED_SOURCE:join(root,'scripts/no-limits-live/fakes/reviewed-source.json')}});
 const killed=r.status===1&&/notStrictEqual/.test(r.stdout??'');writeFileSync(join(out,'invented-auto-wipe.log'),(r.stdout??'')+(r.stderr??''));report.mutants.push({id:'invented-auto-wipe',killed,activated:true,exit:r.status});
}
// Model an absent deliverable only inside the mutant child. Parallel
// qualification controls must keep their own real inventory available.
{
 const dir=mkdtempSync(join(tmpdir(),'gnl-english-mutant-')),active=join(dir,'active'),loader=join(dir,'loader.mjs'),file=join(root,'scripts/no-limits-live/ENGLISH-INVENTORY.md');
 try{
  writeFileSync(loader,`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {fileURLToPath} from 'node:url';import {resolve} from 'node:path';const read=fs.readFileSync;fs.readFileSync=function(path,...args){const name=path instanceof URL?fileURLToPath(path):String(path);if(resolve(name)===${JSON.stringify(file)}){fs.writeFileSync(${JSON.stringify(active)},'yes');const error=new Error('ENOENT: owned inventory mutant');error.code='ENOENT';throw error;}return read.call(this,path,...args);};syncBuiltinESMExports();`);
  const r=spawnSync(process.execPath,['--experimental-strip-types','--test',tests.build],{encoding:'utf8',timeout:60000,env:{...process.env,NODE_OPTIONS:`--import=${pathToFileURL(loader).href}`}});
  const activated=existsSync(active),killed=r.status===1&&activated&&/ENOENT/.test(r.stdout??'');writeFileSync(join(out,'english-inventory-absent.log'),(r.stdout??'')+(r.stderr??''));report.mutants.push({id:'english-inventory-absent',killed,activated,exit:r.status});
 }finally{rmSync(dir,{recursive:true,force:true});}
}
report.verdict=report.mutants.every(m=>m.killed)?'PASS':'FAIL';writeFileSync(join(out,'verdict.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));if(report.verdict!=='PASS')process.exitCode=1;
