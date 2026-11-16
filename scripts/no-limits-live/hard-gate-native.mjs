// Focused, unbillable native-protocol proof. Every server/data/home is disposable.
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createServer} from 'node:http';
import {launchLive,runScenarioCapped} from './run.mjs';
import {releaseEngines} from './release-engines.mjs';
import {engineSpecs,scenarios} from './scenarios.mjs';
import {installBindings} from './bindings.mjs';
const out=resolve(process.argv[2]);mkdirSync(out,{recursive:true});
const catalogue=releaseEngines(),report={isolated:true,releaseGate:false,rows:[],errors:[]};
const ids=['claude','fuigo','codex'];
const specs=engineSpecs.filter(e=>ids.includes(e.id)).map(e=>({...e,path:catalogue[e.id].cli,config:catalogue[e.id].config,environment:catalogue[e.id].environment,requestedModel:catalogue[e.id].model}));
const site={hits:new Set()};site.server=createServer((req,res)=>{site.hits.add(req.url);res.end('<h1>Fixture</h1>');});
await new Promise(r=>site.server.listen(0,'127.0.0.1',r));site.url=`http://127.0.0.1:${site.server.address().port}`;
try{
 for(const engine of specs){
  let f;const engineOut=join(out,engine.id);mkdirSync(engineOut);
  try{
   f=await launchLive(engineOut,specs);installBindings(f);await f.client.connect();
   const {instances}=await f.client.api('GET','/api/instances');
   const instance=instances.find(i=>i.instanceId===engine.id);
   engine.model=engine.requestedModel??instance.models.default;
   for(const id of ['sable-bash-after-web','sable-write-earlier-turn','unavailable-shell-missing-input','routine-wake']){
    const row=await runScenarioCapped(f,engine,scenarios.find(s=>s.id===id),site,45000);
    report.rows.push(row);writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(`${engine.id}/${id}: ${row.verdict} ${JSON.stringify(row.errors)}`);
   }
  }catch(error){report.errors.push(`${engine.id}: ${error.stack}`);}
  finally{if(f){writeFileSync(join(engineOut,'protocol.ndjson'),readFileSync(join(f.data,'nolim-protocol.ndjson')));writeFileSync(join(engineOut,'declarations.json'),JSON.stringify([...f.client.declared],null,2));writeFileSync(join(engineOut,'native-operations.ndjson'),readFileSync(join(f.data,'nolim-native-events.ndjson')));await f.client.disconnect();await f.close();}}
 }
}finally{
 site.server.closeAllConnections();await new Promise(r=>site.server.close(r));
 report.verdict=report.errors.length||report.rows.length!==12||report.rows.some(r=>r.verdict!=='PASS')?'FAIL':'PASS';
 writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
}
if(report.verdict!=='PASS')process.exitCode=1;
