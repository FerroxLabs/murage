// FIXTURES ONLY. Every number/capture below is synthetic. This test file and
// tools/notify-s0 test material must never enter a measured index or package.
import { safeWipeSync } from '../server/testing/safe-wipe.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, cpSync, existsSync, globSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MANDATORY, sourceBinding, sha256, canonical, casesFor, layoutKey, validateBundle, bindBundles, createS0Qualification, loadS0Index } from './notify-s0.mjs';
import { OUTSIDE_ENVELOPES, fitsEnvelope } from '../shared/outside-limits.mjs';
import { artifact, verifyArtifacts, makePlan, calibrationCases, ROOT, rigHash } from '../tools/notify-s0/kit.mjs';
import { packagedImportGraph, isPackaged } from '../scripts/check-packaged-shared-imports.mjs';
const binding = sourceBinding(ROOT);
const clone = structuredClone;
function fixture() {
  const envelope = { maxLines:2,maxLineChars:8,titleChars:4,nameChars:4,templateLines:4,repertoire:'ascii' };
  const advancesPx = Array(95).fill(1); advancesPx['W'.charCodeAt(0)-32] = 2;
  const metrics = () => ({usableWidthPx:32,usableHeightPx:32,lineHeightPx:8,advancesPx:[...advancesPx]});
  return { schema:1,kind:'murage-s0-native-measurement',fixture:true,binding,operator:'TEST FIXTURE',machine:'TEST FIXTURE',packageHash:sha256('fixture'),planHash:sha256('fixture'),rigHash:rigHash(),startedAt:'2026-01-01T00:00:00Z',finishedAt:'2026-01-01T00:01:00Z',
    layout:{platformId:'w10',platform:'win32',osVersion:'Windows 10 22H2',osBuild:'10.0.19045.1',arch:'x64',session:'gui',desktop:'Windows',daemon:'os-native',font:'fixture-font',textScale:1,displayScale:1,workArea:[800,600],theme:'light',locale:'en',layout:'collapsed',surface:'banner-win',electron:'43.8.1',nativeHash:sha256('fixture-native')},envelope,
    measurements:{method:'TEST FIXTURE',textSizeMode:'maximum',minimumWorkArea:true,templateHeightPx:32,templateUsableHeightPx:64,botName:metrics(),title:metrics(),willRun:metrics()},
    observations:casesFor(envelope).map(c=>({id:c.id,payloadHash:sha256(canonical(c.display)),nativePosted:true,captureHash:sha256('fixture'),postReceiptHash:sha256('fixture'),observedAt:'2026-01-01T00:00:30Z',complete:true,transformed:false,runtimeRefused:c.kind==='reject'})) };
}
// Simulate an operator's non-fixture declaration in memory ONLY, to exercise
// successful admission and its subsequent invalidation. No bundle is shipped.
const claimedMeasurement = () => ({...fixture(),fixture:false});
test('fixture can be inspected but never installed or qualified',()=>{
  const f=fixture(); assert.equal(validateBundle(f,binding,{inspectFixture:true}).eligible,false);
  assert.throws(()=>bindBundles([f],binding),/fixture/);
  const index={schema:1,binding,entries:{[layoutKey(f.layout)]:f}}; index.revision=sha256(canonical(index.entries));
  assert.equal(createS0Qualification({readBinding:()=>binding,readIndex:()=>index,readLayout:()=>f.layout}).qualify('banner-win').ok,false);
});
test('production OS/menu envelopes remain zero',()=>{
  for(const surface of ['banner-win','banner-mac','banner-linux','menu']) assert.equal(OUTSIDE_ENVELOPES[surface].maxLines,0);
});
test('mandatory OS and arch matrix is explicit, including both Mac arches',()=>{
  assert.deepEqual(MANDATORY.map(p=>p.id),['w10','w11','m14','m15','m26','gx','gw','kw']);
  for(const p of MANDATORY.filter(p=>p.platform==='darwin')) assert.deepEqual(p.arches,['arm64','x64']);
});
test('all 95 glyphs in each field and whole-template / wrap / negative cases',()=>{
  const cases=casesFor(fixture().envelope);
  for(const field of ['botName','title','willRun']) assert.equal(cases.filter(c=>c.field===field).length,95);
  assert.ok(cases.some(c=>c.id==='full-template'));
  for(const c of cases.filter(c=>c.kind==='reject')) assert.equal(fitsEnvelope(c.display.willRun,c.display.title,c.display.botName,fixture().envelope),false);
  assert.equal(calibrationCases().length,285);
});
test('canonical object ordering is independent of input order',()=>{
  assert.equal(canonical({a:1,b:2}),canonical({b:2,a:1}));
  assert.equal(bindBundles([claimedMeasurement()],binding).revision,bindBundles([clone(claimedMeasurement())],binding).revision);
});
for(const [name, mutate] of [
  ['stale revision', b=>b.binding=sha256('old')], ['missing fixture marker',b=>delete b.fixture],
  ['missing glyph',b=>b.measurements.title.advancesPx.pop()], ['zero glyph',b=>b.measurements.title.advancesPx[0]=0],
  ['overflow width',b=>b.measurements.willRun.usableWidthPx=1], ['overflow height',b=>b.measurements.willRun.usableHeightPx=1],
  ['template crop',b=>b.measurements.templateHeightPx=1000], ['no maximum/normal scale',b=>b.measurements.textSizeMode='default'],
  ['unknown surface',b=>b.layout.surface='toast'], ['future OS',b=>b.layout.osBuild='10.0.99999.1'],
  ['unknown arch',b=>b.layout.arch='arm64'], ['extra layout key',b=>b.layout.invented=true],
  ['absent font',b=>delete b.layout.font], ['unknown font',b=>b.layout.font='unknown'],
  ['zero scale',b=>b.layout.textScale=0], ['missing case',b=>b.observations.pop()],
  ['duplicate case',b=>b.observations[1]=b.observations[0]], ['missing screenshot',b=>b.observations[0].captureHash=null],
  ['not native',b=>b.observations[0].nativePosted=false], ['altered payload',b=>b.observations[0].payloadHash=sha256('other')],
  ['clipped full template',b=>b.observations.find(o=>o.id==='full-template').complete=false],
  ['menu folds whitespace',b=>b.observations.find(o=>o.id==='wrap-breaks').transformed=true],
  ['negative accepted',b=>b.observations.find(o=>o.id==='plus-title').runtimeRefused=false],
  ['unsafe repertoire',b=>b.envelope.repertoire='extended'], ['negative bound',b=>b.envelope.maxLines=-1],
]) test(`refuses ${name}`,()=>{const b=claimedMeasurement();mutate(b);assert.throws(()=>validateBundle(b,binding),/S0_REFUSED/);});
test('duplicate layout cannot silently replace evidence',()=>assert.throws(()=>bindBundles([claimedMeasurement(),claimedMeasurement()],binding),/duplicate/));
test('input mutation cannot change already bound index',()=>{
  const b=claimedMeasurement(),index=bindBundles([b],binding); b.envelope.maxLines=999;
  assert.equal(Object.values(index.entries)[0].envelope.maxLines,2);
});
test('qualifies exact layout and invalidates a lease on each layout/source/index change',()=>{
  const b=claimedMeasurement();let layout=b.layout,index=bindBundles([b],binding),activeBinding=binding,invalidations=0;
  const q=createS0Qualification({readLayout:()=>layout,readIndex:()=>index,readBinding:()=>activeBinding,invalidate:()=>invalidations++});
  const lease=q.qualify('banner-win');assert.equal(lease.ok,true);assert.equal(q.valid(lease,'banner-win'),true);
  for(const key of ['font','daemon','layout','locale','theme','osBuild','electron','nativeHash']) {
    layout={...b.layout,[key]:'changed'};assert.equal(q.valid(lease,'banner-win'),false);
    layout=b.layout;assert.equal(q.qualify('banner-win').ok,true);
    assert.equal(q.valid(lease,'banner-win'),false); // old generation stays dead
  }
  activeBinding=sha256('changed');assert.equal(q.qualify('banner-win').ok,false);
  activeBinding=binding;const next=q.qualify('banner-win');q.invalidate();assert.equal(q.valid(next,'banner-win'),false);
  index=clone(index);Object.values(index.entries)[0].envelope.maxLineChars=7;assert.equal(q.qualify('banner-win').ok,false);
  assert.ok(invalidations>10);
});
test('reader failures, common envelopes and mismatched surface cannot fall open',()=>{
  const b=claimedMeasurement(),index=bindBundles([b],binding);
  for(const readIndex of [()=>{throw Error('read');},()=>null,()=>({...index,entries:{common:b}})]) {
    assert.equal(createS0Qualification({readBinding:()=>binding,readLayout:()=>b.layout,readIndex}).qualify('banner-win').ok,false);
  }
  assert.equal(createS0Qualification({readBinding:()=>binding,readLayout:()=>b.layout,readIndex:()=>index}).qualify('menu').ok,false);
});
test('admission refuses missing native artifacts, traversal and capture tampering',()=>{
  const folder=mkdtempSync(join(tmpdir(),'s0-test-fixture-'));
  try {
    const b=claimedMeasurement(),plan=makePlan({operator:b.operator,machine:b.machine,layout:b.layout,envelope:b.envelope,widest:{botName:'W',title:'W',willRun:'W'}});
    const planBytes=JSON.stringify(plan);writeFileSync(join(folder,'plan.json'),planBytes);b.planHash=sha256(planBytes);
    mkdirSync(join(folder,'posts'));mkdirSync(join(folder,'captures'));
    // PNG signature only: deliberately synthetic, used to test integrity, not rendering.
    const png=Buffer.from([137,80,78,71,13,10,26,10]);
    for(const o of b.observations) {
      o.capture=`captures/${o.id}.png`;writeFileSync(join(folder,o.capture),png);o.captureHash=sha256(png);
      const post={id:o.id,payloadHash:o.payloadHash,nativePosted:true,binding,rigHash:b.rigHash,packageHash:b.packageHash,layout:b.layout,screens:[{file:o.capture,sha256:o.captureHash}]};
      const receipt=JSON.stringify(post);writeFileSync(join(folder,'posts',`${o.id}.json`),receipt);o.postReceiptHash=sha256(receipt);
    }
    verifyArtifacts(b,folder);
    assert.throws(()=>artifact(folder,'../outside'),/artifact-path/);
    writeFileSync(join(folder,b.observations[0].capture),'corrupt');assert.throws(()=>verifyArtifacts(b,folder),/capture/);
  } finally {safeWipeSync(folder);}
});
test('calibration and kit never enter production main/package entry',()=>{
  const pkg=JSON.parse(readFileSync(join(ROOT,'package.json'),'utf8'));
  assert.equal(pkg.main,'electron/main.mjs');
  assert.doesNotMatch(readFileSync(join(ROOT,'electron/main.mjs'),'utf8'),/notify-s0\/entry|notify-s0\/kit/);
  const config=readFileSync(join(ROOT,'electron-builder.yml'),'utf8');
  assert.doesNotMatch(config,/^\s+- tools\/notify-s0\//m);
});

test('filesystem loader validates the complete canonical revision, not just the selected entry',()=>{
  const folder=mkdtempSync(join(tmpdir(),'s0-index-fixture-'));
  try {
    const file=join(folder,'index.json'),index=bindBundles([claimedMeasurement()],binding);
    writeFileSync(file,JSON.stringify(index));assert.deepEqual(loadS0Index(file,ROOT),index);
    index.entries.extra=fixture();index.revision=sha256(canonical(index.entries));
    writeFileSync(file,JSON.stringify(index));assert.throws(()=>loadS0Index(file,ROOT),/fixture/);
  } finally {safeWipeSync(folder);}
});

test('qualification package includes every transitive entry import', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'notify-s0-imports-fixture-'));
  try {
    const configPath = join(scratch, 'builder.json');
    const generated = spawnSync(process.execPath, ['tools/notify-s0/package.mjs', configPath], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr);
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const excluded = new Set(globSync(config.files.filter(p => p.startsWith('!')).map(p => p.slice(1)), { cwd: ROOT }));
    const packaged = new Set(globSync(config.files.filter(p => !p.startsWith('!')), { cwd: ROOT }).filter(file => !excluded.has(file)));
    const graph = packagedImportGraph([join(ROOT, config.extraMetadata.main)]);
    assert.deepEqual(graph.missing, [], 'entry imports must resolve in the source tree');
    assert.ok(graph.files.includes('server/testing/safe-wipe.mjs'));
    assert.ok(graph.files.includes('electron/data-dir-lease.mjs'), 'follows safe-wipe transitive imports');
    assert.deepEqual(graph.files.filter(file => !packaged.has(file)), [], 'entry imports missing from the qualification package');
    const cleanupGraph = packagedImportGraph([join(ROOT, 'server/testing/safe-wipe.mjs')]);
    assert.deepEqual(cleanupGraph.files.filter(file => !isPackaged(file)), [], 'release file list must include the cleanup module and its imports');
  } finally {
    safeWipeSync(scratch);
  }
});

test('qualification package starts with only its declared files and cleans its isolated scratch', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'notify-s0-package-fixture-'));
  try {
    const configPath = join(scratch, 'builder.json');
    const generated = spawnSync(process.execPath, ['tools/notify-s0/package.mjs', configPath], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr);
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const excluded = new Set(globSync(config.files.filter(p => p.startsWith('!')).map(p => p.slice(1)), { cwd: ROOT }));
    const staged = join(scratch, 'app');
    for (const file of globSync(config.files.filter(p => !p.startsWith('!')), { cwd: ROOT })) {
      if (excluded.has(file)) continue;
      // Directories are emitted by ** too; copy only individual declared files.
      if (!statSync(join(ROOT, file)).isFile()) continue;
      mkdirSync(dirname(join(staged, file)), { recursive: true });
      cpSync(join(ROOT, file), join(staged, file));
    }
    const fakeElectron = join(scratch, 'electron.mjs');
    writeFileSync(fakeElectron, `
      const paths = {};
      export const app = {
        isPackaged: true,
        setPath: (key, value) => { paths[key] = value; },
        setAppUserModelId() {},
        whenReady: async () => { throw Error('S0_STARTUP_FIXTURE'); },
        exit: code => console.log(JSON.stringify({ code, paths })),
      };
      export const Notification = {}, Menu = {}, BrowserWindow = {}, dialog = {},
        screen = {}, desktopCapturer = {}, nativeTheme = {};
    `);
    const launcher = join(scratch, 'launch.mjs');
    writeFileSync(launcher, `
      import { registerHooks } from 'node:module';
      import { pathToFileURL } from 'node:url';
      registerHooks({ resolve(specifier, context, next) {
        return specifier === 'electron'
          ? { url: pathToFileURL(${JSON.stringify(fakeElectron)}).href, shortCircuit: true }
          : next(specifier, context);
      }});
      await import(pathToFileURL(${JSON.stringify(join(staged, config.extraMetadata.main))}).href);
    `);
    const output = join(scratch, 'admission');
    const started = spawnSync(process.execPath, [launcher, '--out', output], {
      cwd: staged, encoding: 'utf8',
      env: { ...process.env, DISPLAY: 'fixture', DBUS_SESSION_BUS_ADDRESS: 'fixture' },
    });
    assert.equal(started.status, 0, started.stderr);
    assert.match(started.stderr, /S0_STARTUP_FIXTURE/);
    const receipt = JSON.parse(started.stdout.trim());
    assert.equal(receipt.code, 1);
    assert.ok(receipt.paths.userData.startsWith(join(tmpdir(), 'murage-s0-')));
    assert.equal(existsSync(receipt.paths.userData), false, 'entry cleanup removed its own scratch');
    assert.equal(JSON.parse(readFileSync(join(output, 'OPEN.json'), 'utf8')).reason, 'S0_STARTUP_FIXTURE');
  } finally {
    safeWipeSync(scratch);
  }
});
