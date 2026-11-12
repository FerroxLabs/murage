import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.cwd(),out=resolve(process.argv[2]);mkdirSync(out,{recursive:true});
const tests={actions:'scripts/no-limits-live/afix-actions.node-test.mjs',build:'scripts/no-limits-live/afix-build.node-test.mjs',replay:'scripts/nolim-replay/afix-context.node-test.mjs',production:'scripts/nolim-replay/afix-production.node-test.mjs'};
const mutations=[
 ['cli-candidate-unbound','scripts/no-limits-live/run.mjs','report.candidate=verifyCandidate(ROOT,options.candidateSha,options.candidateProof);',"report.candidate={candidateSha:options.candidateSha};",'scripts/no-limits-live/afix-cli-binding.node-test.mjs'],
 ['skipped-owner-action','scripts/no-limits-live/action-proof.mjs','return completed && effect;','return true;',tests.actions],
 ['owner-input-substituted','scripts/no-limits-live/action-proof.mjs',"(s.input?.command??s.input?.CommandLine??s.input?.cmd)===command",'true',tests.actions],
 ['owner-completion-unmatched','scripts/no-limits-live/action-proof.mjs','e.itemId===s.itemId','true',tests.actions],
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
// The Low finding is an absent deliverable, so remove only that owned artifact
// for its mutant and restore it even when the test fails.
{
 const file=join(root,'scripts/no-limits-live/ENGLISH-INVENTORY.md'),backup=join(out,'inventory-backup.md');renameSync(file,backup);
 try{const r=spawnSync(process.execPath,['--experimental-strip-types','--test',tests.build],{encoding:'utf8',timeout:60000});const killed=r.status===1&&/ENOENT/.test(r.stdout??'');writeFileSync(join(out,'english-inventory-absent.log'),(r.stdout??'')+(r.stderr??''));report.mutants.push({id:'english-inventory-absent',killed,activated:true,exit:r.status});}finally{renameSync(backup,file);}
}
report.verdict=report.mutants.every(m=>m.killed)?'PASS':'FAIL';writeFileSync(join(out,'verdict.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));if(report.verdict!=='PASS')process.exitCode=1;
