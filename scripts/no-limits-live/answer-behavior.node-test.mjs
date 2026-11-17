// The public stream's request frames are an audience projection: an opaque
// envelope with no requestId or turnId. An accepted answer tap must still get
// the behavior the engine resolved, from the private execution rail only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {removeTempDirSync} from '../../server/testing/cleanup.ts';
import {readNativeEvents} from './native-operation-evidence.mjs';
import {normalizeLiveAccounting} from './live-accounting.mjs';
import {observe} from './observe.mjs';
const temp=fn=>{const root=mkdtempSync(join(tmpdir(),'nolim-answer-behavior-'));return Promise.resolve().then(()=>fn(root)).finally(()=>removeTempDirSync(root));};
const thread='fixture-thread',turn='fixture-turn',request='fixture-request';
const opened={type:'request.opened',eventId:'native-open',provider:'gnlFake',providerInstanceId:'fixture-engine',threadId:thread,turnId:turn,requestId:request,requestType:'permission',createdAt:'2026-01-01T00:00:00.000Z'};
const resolved=(behavior,eventId='native-resolve')=>({type:'request.resolved',eventId,provider:'gnlFake',providerInstanceId:'fixture-engine',threadId:thread,turnId:turn,requestId:request,behavior,createdAt:'2026-01-01T00:00:01.000Z'});
// What /api/events now carries for the same resolution (audience-collector.ts).
const publicResolved={type:'request.resolved',eventId:'audience-1',providerInstanceId:'fixture-engine',threadId:thread,generation:1,behavior:'allow',source:'user',speechDisposition:'none'};
const tapRequest={type:'request',threadId:thread,engine:'gnlFake',providerInstanceId:'fixture-engine',generation:turn,requestId:request,tool:'Bash',inputHash:'h'};
const tapAnswer={type:'answer',threadId:thread,engine:'gnlFake',providerInstanceId:'fixture-engine',generation:turn,requestId:request,answerId:`native:${turn}:${request}`,state:'accepted'};
const snapshot=()=>({complete:true,errors:[],taps:[{...tapRequest},{...tapAnswer}],registrations:[{threadId:thread,generation:turn,requestId:request}],records:[],messages:[],queues:[],electron:[],mirrors:[]});
const accounted=(root,rows)=>{
 writeFileSync(join(root,'nolim-native-events.ndjson'),rows.map(r=>JSON.stringify(r)+'\n').join(''));
 writeFileSync(join(root,'nolim-service-protocol.ndjson'),'');
 const events=readNativeEvents(root,[thread],[publicResolved]);
 return normalizeLiveAccounting(snapshot(),{dataDir:root,events,threadIds:[thread]});
};

test('an accepted native answer tap takes the behavior of its own native resolution, not the projected public frame',()=>temp(root=>{
 const allow=accounted(root,[opened,resolved('allow')]);
 assert.equal(allow.taps.find(t=>t.type==='answer').behavior,'allow');
 const scenario={id:'owner-qualification',actor:'owner',level:'unlimited',expected:'RUN',incidental:[{engine:'gnlFake',tool:'Bash',inputHash:'h',class:'run'}]};
 // The baseline control's RUN receipt is complete again.
 assert.equal(observe(scenario,allow).verdict,'PASS',JSON.stringify(observe(scenario,allow)));
 // A deny is never read as allow, and the public allow frame (no requestId) never fills it.
 const deny=accounted(root,[opened,resolved('deny')]);
 assert.equal(deny.taps.find(t=>t.type==='answer').behavior,'deny');
 assert.ok(observe(scenario,deny).errors.includes('RUN requires an accepted allow receipt'));
 // No native resolution, or two of them: no behavior, so RUN fails closed.
 for(const rows of [[opened],[opened,resolved('allow'),resolved('allow','native-resolve-2')]]){
  const none=accounted(root,rows);
  assert.equal(none.taps.find(t=>t.type==='answer').behavior,undefined);
  assert.ok(observe(scenario,none).errors.includes('RUN requires an accepted allow receipt'));
 }
}));

test('a native request row without its request identity fails the surface closed',()=>temp(root=>{
 for(const row of [{...resolved('allow'),requestId:undefined},{...resolved('allow'),requestId:''},{...resolved('allow'),eventId:7},{...opened,type:'request.unknown'}]){
  writeFileSync(join(root,'nolim-native-events.ndjson'),JSON.stringify(row)+'\n');
  assert.throws(()=>readNativeEvents(root,[thread],[]),/Native operation surface malformed/);
 }
}));

test('the live observer records request identity and resolution from the execution rail, never ask text or input',()=>temp(root=>{
 const observer=pathToFileURL(fileURLToPath(new URL('./live-observer.mjs',import.meta.url))).href;
 const ask={...opened,tool:'Bash',summary:'fixture-summary-text',reason:'fixture-reason-text',choices:['fixture-choice'],toolInput:{command:'printf fixture-input'},toolCall:{name:'Bash',input:{command:'printf fixture-input'}}};
 const script=`const rail=globalThis[Symbol.for('gnl.native.operation')];for(const e of ${JSON.stringify([ask,{...resolved('allow'),source:'user',decidedBy:'fixture-rule'},{...resolved('allow'),requestId:undefined}])})rail(e);`;
 const r=spawnSync(process.execPath,['--experimental-strip-types','--no-warnings','--import',observer,'--input-type=module','-e',script],{encoding:'utf8',timeout:120000,env:{...process.env,MURAGE_DATA_DIR:root,MURAGE_GATE_TAP:'1',NODE_OPTIONS:''}});
 assert.equal(r.status,0,r.stdout+r.stderr);
 const file=join(root,'nolim-native-events.ndjson');assert.ok(existsSync(file));
 const text=readFileSync(file,'utf8'),rows=text.trim().split('\n').map(line=>JSON.parse(line));
 assert.deepEqual(rows,[{type:'request.opened',eventId:'native-open',provider:'gnlFake',providerInstanceId:'fixture-engine',threadId:thread,turnId:turn,requestId:request,createdAt:opened.createdAt,requestType:'permission'},
  {type:'request.resolved',eventId:'native-resolve',provider:'gnlFake',providerInstanceId:'fixture-engine',threadId:thread,turnId:turn,requestId:request,createdAt:'2026-01-01T00:00:01.000Z',behavior:'allow',source:'user'}]);
 assert.ok(!/fixture-(summary|reason|choice|input|rule)/.test(text));
 // The reader accepts exactly what the observer writes.
 assert.equal(readNativeEvents(root,[thread],[]).length,2);
}));
