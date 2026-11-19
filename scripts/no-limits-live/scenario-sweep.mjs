// Scenario-only diagnostic sweep. This is not a release verdict: replay and
// mandatory suites remain binding in run.mjs. Every selected cell uses the
// original driver, judge and all-surface accounting without assertion changes.
import {createServer} from 'node:http';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {launchLive,runScenarioCapped} from './run.mjs';
import {scenarios,engineSpecs} from './scenarios.mjs';
import {validCapabilityNA} from './capability-rows.mjs';
import {releaseEngines,selectFixtureModel} from './release-engines.mjs';
import {installBindings} from './bindings.mjs';
import {installOriginFixtures} from './origin-fixtures.mjs';

const args=process.argv.slice(2),arg=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
const out=resolve(arg('--out')),shard=Number(arg('--shard','0')),shards=Number(arg('--shards','1'));
const timeout=Number(arg('--timeout','10000')),only=arg('--engines')?.split(','),cases=arg('--cases')?.split(',');
if(out==='/dev'||out.startsWith('/dev/')||existsSync(out))throw Error('New evidence directory outside /dev required');
if(!Number.isInteger(shard)||!Number.isInteger(shards)||shard<0||shard>=shards||!Number.isInteger(timeout)||timeout<1||timeout>45000)throw Error('Invalid sweep bounds');
if(only?.some(id=>!engineSpecs.some(s=>s.id===id))||cases?.some(id=>!scenarios.some(s=>s.id===id)))throw Error('Unknown sweep selection');
mkdirSync(out,{recursive:true});
const catalogue=releaseEngines(),installed=engineSpecs.map(s=>({...s,path:catalogue[s.id].cli,config:catalogue[s.id].config,environment:catalogue[s.id].environment,requestedModel:catalogue[s.id].model}));
const selected=installed.filter((s,i)=>i%shards===shard&&(!only||only.includes(s.id)));
const report={mode:'scenario-only',releaseGate:false,tree:arg('--candidate','UNCOMMITTED'),timeout,shard,shards,rows:[],errors:[],engines:selected.map(s=>s.id),startedAt:new Date().toISOString()};
const save=()=>writeFileSync(join(out,'verdict.json'),JSON.stringify(report,null,2)+'\n');
const site={hits:new Set()};
site.server=createServer((req,res)=>{site.hits.add(req.url);res.writeHead(200,{'content-type':'text/html'});res.end(req.url.startsWith('/long/')?'<!doctype html><p>'+'x'.repeat(13342-'<!doctype html><p></p>END-13342'.length)+'</p>END-13342':'<!doctype html><title>No limits fixture</title><h1>Fixture ready</h1>');});
await new Promise(r=>site.server.listen(0,'127.0.0.1',r));site.url=`http://127.0.0.1:${site.server.address().port}`;
try{
 for(const engine of selected){
  const engineOut=join(out,engine.id);mkdirSync(engineOut);let f;
  try{
   f=await launchLive(engineOut,installed);f.platform=process.platform;f.client.timeout=timeout;
   installBindings(f);f.workflowFixtures={...f.workflowFixtures,...installOriginFixtures(f)};await f.client.connect();
   const {instances}=await f.client.api('GET','/api/instances?fresh=1'),instance=instances.find(i=>i.instanceId===engine.id);
   if(instance?.snapshot?.state!=='available')throw Error(`Engine unavailable: ${JSON.stringify(instance?.snapshot)}`);
   engine.model=selectFixtureModel(engine,instance);
   engine.capabilityEvidence={instanceId:instance.instanceId,driverKind:instance.driverKind,capabilities:instance.capabilities};
   for(const spec of scenarios.filter(s=>!cases||cases.includes(s.id))){
    const start=Date.now(),row=await runScenarioCapped(f,engine,spec,site,timeout);
    row.durationMs=Date.now()-start;report.rows.push(row);save();
    console.log(`${engine.id}/${spec.id} ${row.verdict} ${row.durationMs}ms ${[...new Set(row.errors)].join('; ')}`);
   }
  }catch(error){report.errors.push(`${engine.id}: ${error.stack}`);save();}
  finally{if(f){
   for(const name of ['gnl-browser-pages.ndjson','gnl-request-inputs.ndjson','nolim-native-events.ndjson','nolim-protocol.ndjson','nolim-registrations.ndjson','nolim-service-protocol.ndjson'])if(existsSync(join(f.data,name)))writeFileSync(join(engineOut,name),readFileSync(join(f.data,name)));
   if(existsSync(join(f.data,'s3-state/api-inventory.ndjson')))writeFileSync(join(engineOut,'api-inventory.ndjson'),readFileSync(join(f.data,'s3-state/api-inventory.ndjson')));
   await f.client.disconnect();await f.close();
  }}
 }
}finally{site.server.closeAllConnections();await new Promise(r=>site.server.close(r));report.finishedAt=new Date().toISOString();report.pass=report.rows.filter(r=>r.verdict==='PASS').length;report.naByCapability=report.rows.filter(validCapabilityNA).length;report.fail=report.rows.length-report.pass-report.naByCapability;save();}
console.log(JSON.stringify({rows:report.rows.length,pass:report.pass,fail:report.fail,errors:report.errors}));
process.exitCode=report.fail||report.errors.length?1:0;
