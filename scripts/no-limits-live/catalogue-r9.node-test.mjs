// Harness owner: gnl-harness-r9. Registry/capability contract owner: MAIN.
// A single isolated catalogue fixture; never invokes main or the gate runner.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {launchLive} from './run.mjs';
import {releaseEngines,selectFixtureModel} from './release-engines.mjs';
import {shippedEngineSpecs} from './engine-inventory.mjs';
import {removeTempDirSync} from '../../server/testing/cleanup.ts';
import {isFluxModel} from '../../server/flux-surface.ts';
test('P3 every shipped engine selects an advertised native route on an isolated catalogue', {timeout:180000},async()=>{
 const out=mkdtempSync(join(tmpdir(),'gnl-catalogue-')),configs=releaseEngines();let fixture,succeeded=false;
 try{
  const specs=shippedEngineSpecs().map(spec=>({...spec,...configs[spec.id],path:configs[spec.id].cli,requestedModel:configs[spec.id].model}));
  fixture=await launchLive(out,specs);
  const {instances}=await fixture.client.api('GET','/api/instances?fresh=1');
  assert.equal(specs.length,24);
  const failures=[];
  for(const spec of specs){try{
   const instance=instances.find(i=>i.instanceId===spec.id);
   assert.equal(instance?.snapshot?.state,'available',`${spec.id}: ${instance?.snapshot?.reason}`);
   const model=selectFixtureModel(spec,instance);
   assert.equal(isFluxModel(model),false,spec.id);
   assert.ok(instance.models.options.some(o=>(typeof o==='string'?o:o.id)===model),spec.id);
   assert.equal(typeof instance.capabilities.agentsMcp,'boolean',spec.id);
  }catch(error){failures.push(`${spec.id}: ${error.message}`);}}
  assert.deepEqual(failures,[]);
  for(const id of ['openclaw','pi','box-agent'])assert.equal(instances.find(i=>i.instanceId===id).capabilities.agentsMcp,false,id);
  const spec=specs.find(s=>s.id==='codex'),instance=instances.find(i=>i.instanceId==='codex');
  const bot=await fixture.client.bot('Persisted settings fixture',{...spec,model:selectFixtureModel(spec,instance)},fixture.work,'unlimited');
  const current=(await fixture.client.api('GET',`/api/bots/${bot.id}`)).bot;
  const task=current.tasks.find(t=>t.threadId===bot.threadId);
  assert.equal(task.autoApprove,true);assert.equal(task.fullAccess,true);assert.equal(task.noLimits,true);
  const saved=JSON.parse(readFileSync(join(fixture.data,'bots.json'),'utf8')).find(b=>b.id===bot.id);
  assert.equal(saved.permissionExplicit,true);
  assert.equal(saved.tasks.find(t=>t.threadId===bot.threadId).noLimits,true);
  succeeded=true;
 }finally{await fixture?.client.disconnect();await fixture?.close();if(succeeded)removeTempDirSync(out);else console.error(`Catalogue failure log: ${join(out,'server.log')}`);}
});
