// Qualification-only code. Never imported by production main.
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { resolve, dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANDATORY, sourceBinding, sha256, canonical, casesFor, layoutKey, bindBundles, validateBundle } from '../../electron/notify-s0.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const RIG_FILES = ['tools/notify-s0/kit.mjs', 'tools/notify-s0/entry.mjs'];
export const rigHash = (root = ROOT) => sha256(canonical(Object.fromEntries(RIG_FILES.map(p => [p, sha256(readFileSync(join(root, p)))]))));
export const readJSON = path => JSON.parse(readFileSync(path, 'utf8'));
export const writeJSON = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
const refuse = reason => { throw Error(`S0_REFUSED:${reason}`); };
export function artifact(root, name) {
  if (typeof name !== 'string' || isAbsolute(name) || name.split(/[\\/]/).some(p => p === '..' || p === '')) refuse('artifact-path');
  const base = realpathSync(root), path = realpathSync(resolve(base, name));
  const rel = relative(base, path);
  if (rel.startsWith('..') || isAbsolute(rel)) refuse('artifact-escape');
  return readFileSync(path);
}
export function verifyArtifacts(bundle, folder) {
  const plan = artifact(folder, 'plan.json');
  if (sha256(plan) !== bundle.planHash) refuse('plan-hash');
  const parsed = JSON.parse(plan);
  if (parsed.calibration !== false) refuse('calibration-is-not-measurement');
  if (canonical(parsed.cases) !== canonical(casesFor(parsed.envelope, parsed.widest))) refuse('plan-cases');
  if (parsed.binding !== bundle.binding || canonical(parsed.envelope) !== canonical(bundle.envelope) || canonical(parsed.layout) !== canonical(bundle.layout)) refuse('plan-binding');
  for (const o of bundle.observations) {
    const capture = artifact(folder, o.capture);
    if (!capture.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || sha256(capture) !== o.captureHash) refuse(`capture-${o.id}`);
    const receipt = artifact(folder, `posts/${o.id}.json`);
    if (sha256(receipt) !== o.postReceiptHash) refuse(`receipt-${o.id}`);
    const post = JSON.parse(receipt);
    if (post.transformed === true && o.transformed !== true) refuse(`transformed-${o.id}`);
    if (!post.screens?.some(s => s.file === o.capture && s.sha256 === o.captureHash)) refuse(`capture-receipt-${o.id}`);
    if (post.id !== o.id || post.payloadHash !== o.payloadHash || post.nativePosted !== true || post.binding !== bundle.binding || post.rigHash !== bundle.rigHash || post.packageHash !== bundle.packageHash || canonical(post.layout) !== canonical(bundle.layout)) refuse(`post-${o.id}`);
  }
}
export function finalize(folder, root = ROOT) {
  // Operator edits observations.json only. Collector receipts and captured PNGs remain immutable.
  const b = readJSON(join(folder, 'observations.json'));
  if (b.fixture !== false) refuse('fixture');
  b.finishedAt = new Date().toISOString();
  b.planHash = sha256(readFileSync(join(folder, 'plan.json')));
  b.rigHash = rigHash(root);
  for (const o of b.observations) {
    o.captureHash = sha256(artifact(folder, o.capture));
    o.postReceiptHash = sha256(artifact(folder, `posts/${o.id}.json`));
  }
  validateBundle(b, sourceBinding(root));
  verifyArtifacts(b, folder);
  writeJSON(join(folder, 'bundle.json'), b);
  return b;
}

export function makePlan(input, root = ROOT, calibration = false) {
  layoutKey(input.layout);
  const cases = calibration ? calibrationCases() : casesFor(input.envelope, input.widest);
  if (!input.operator?.trim() || !input.machine?.trim()) refuse('operator-machine');
  return { ...input, schema: 1, binding: sourceBinding(root), rigHash: rigHash(root), calibration, cases };
}
// These numbers define glyph stimuli, NOT measurements or candidate envelopes.
export function calibrationCases() {
  return casesFor({maxLines:1,maxLineChars:8,titleChars:8,nameChars:8,templateLines:3,repertoire:'ascii'}).filter(c => c.kind === 'glyph');
}

// Run with Node 24 on the build/admission host; no native test is performed here.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'plan' || command === 'calibrate') {
      const [input, out] = args;
      const plan = makePlan(readJSON(input), ROOT, command === 'calibrate');
      writeJSON(out, plan);
      console.log(`S0_PLAN ${out} ${plan.cases.length} cases; candidate only`);
    } else if (command === 'finalize') {
      const bundle = finalize(resolve(args[0]));
      console.log(`S0_BUNDLE ${args[0]}/bundle.json ${layoutKey(bundle.layout)}; review required`);
    } else if (command === 'import') {
      const [out, ...folders] = args;
      const bundles = folders.map(folder => {
        const b = readJSON(join(folder, 'bundle.json'));
        if (b.rigHash !== rigHash()) refuse('rig-revision');
        verifyArtifacts(b, folder);
        return b;
      });
      const index = bindBundles(bundles, sourceBinding(ROOT));
      writeJSON(out, index);
      console.log(`S0_INDEX ${out} ${index.revision}; ${Object.keys(index.entries).length} exact layouts; production remains disabled`);
      const missing = MANDATORY.flatMap(os => os.arches.flatMap(arch => ['menu', { win32:'banner-win',darwin:'banner-mac',linux:'banner-linux' }[os.platform]].filter(surface => !bundles.some(b => b.layout.platformId === os.id && b.layout.arch === arch && b.layout.surface === surface)).map(surface => `${os.id}/${arch}/${surface}`)));
      console.log(`S0_COVERAGE ${missing.length ? `OPEN missing ${missing.join(', ')}` : 'inventory present; MAIN must audit all layout/scale/theme/locale cells'}`);
    } else if (command === 'seed') {
      // Null means unmeasured, not zero, and is refused by plan/finalize.
      const [id, surface, out] = args, os = MANDATORY.find(p => p.id === id);
      if (!os) refuse('platform');
      const layout = Object.fromEntries(['platformId','platform','osVersion','osBuild','arch','session','desktop','daemon','font','textScale','displayScale','workArea','theme','locale','layout','surface','electron','nativeHash'].map(k => [k, null]));
      Object.assign(layout, { platformId:id, platform:os.platform, session:os.session, surface });
      const metrics = () => ({ usableWidthPx:null, usableHeightPx:null, lineHeightPx:null, advancesPx:Array(95).fill(null) });
      writeJSON(out, { operator:null, machine:null, layout,
        envelope:{maxLines:null,maxLineChars:null,titleChars:null,nameChars:null,templateLines:null,repertoire:'ascii'},
        widest:{botName:null,title:null,willRun:null},
        measurements:{method:null,textSizeMode:null,minimumWorkArea:null,templateHeightPx:null,templateUsableHeightPx:null,botName:metrics(),title:metrics(),willRun:metrics()} });
      console.log(`S0_SEED ${out}; fill from native calibration; nulls cannot qualify`);
    } else refuse('usage: seed <platformId> <surface> <out> | calibrate <input> <out> | plan <input> <out> | finalize <folder> | import <new-index> <folders...>');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
