// Candidate source mutations in isolated children, with inert action sinks.
// No candidate file is rewritten and no real tool or provider is launched.
import { spawnSync } from 'node:child_process';
// These are independent CLI children, not Node test-runner IPC workers.
const cliEnv={...process.env};delete cliEnv.NODE_TEST_CONTEXT;
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), out = resolve(process.argv[2]);
mkdirSync(out, { recursive: true });
const mutants = [
  { id: 'nonwipe-card', file: 'server/decision/implementation.ts', before: 'else if(owner(e)){',
    after: "else if(owner(e) && (r.snapshot?.input as any)?.command === 'printf fixture')outcome=approval(e,'base',[]);\n else if(owner(e)){",
    smoke: 'scripts/nolim-replay/production-smoke.mjs', args: ['--ordinary-only'],
    verify: row => row?.nonwipeCardCount === 1 },
  ...[
    ['stored-rule-card',"outcome=approval(e,'deny',r.deny);",row=>row?.cardCount===1],
    ['stored-rule-refusal',"outcome={kind:'refuse',message:REFUSAL};",row=>row?.refusalCount>0],
  ].map(([id,outcome,verify])=>({id,file:'server/decision/implementation.ts',before:'else if(owner(e)){',
    after:`else if(owner(e)&&r.deny.some(d=>d.kind==='deny')){${outcome}}\n else if(owner(e)){`,
    smoke:'scripts/nolim-replay/production-smoke.mjs',args:['--stored-only'],verify})),
  { id:'stored-rule-final-hold',file:'server/decision/provider-release.ts',
    before:"try{return reader?.(identity,updatedInput as ApprovalAnswer['updatedInput'],replay)===true;}",after:'try{return false;}',
    smoke:'scripts/nolim-replay/production-smoke.mjs',args:['--stored-only'],verify:row=>row?.refusalCount>0&&row?.actionSink?.executed===false},
  { id:'stored-rule-silent-deny',file:'scripts/nolim-replay/production.mjs',
    before:'delivered=guardEngineRelease(target, row.updatedInput);',after:'delivered=false;',
    smoke:'scripts/nolim-replay/production-smoke.mjs',args:['--stored-only'],verify:row=>row?.refusalCount>0&&row?.actionSink?.executed===false},
  { id:'feature-off-runs' ,file:'server/host-computer-consent.ts',
    before:'return bot.computer === undefined && bot.hostComputerConsent === "declined";',after:'return false;',
    smoke:'scripts/no-limits-live/feature-off-smoke.mjs',args:[],verify:row=>row?.actionSink?.executed===true},
  { id:'browser-feature-off-runs',file:'server/config.ts',before:'return cfg.features?.browser !== false;',after:'return true;',
    smoke:'scripts/no-limits-live/feature-off-smoke.mjs',args:['--browser'],verify:row=>row?.actionSink?.executed===true},
  { id:'feature-off-card',file:'scripts/nolim-replay/production.mjs',
    before:'if (disabled) return',after:'if (false) return',
    smoke:'scripts/nolim-replay/production-smoke.mjs',args:['--feature-only'],
    verify:row=>row?.cardCount===1&&row?.actionSink?.executed===false},

];
const report = { mode: 'fake-only candidate source mutations', releaseGate: false, mutants: [], verdict: 'FAIL' };
for (const { id, file, before, after, smoke, args, verify } of mutants) {
  if (!readFileSync(join(root, file), 'utf8').includes(before)) throw Error(`Candidate mutant anchor changed: ${id}`);
  const dir = mkdtempSync(join(tmpdir(), 'gnl-product-mutant-')), evidence = join(out, id);
  mkdirSync(evidence, { recursive: true });
  try {
    const run = (name, env = cliEnv) => {
      const result = spawnSync(process.execPath, ['--experimental-strip-types', join(root, smoke), join(evidence, name), ...args], {
        cwd: root, encoding: 'utf8', timeout: 60000, env,
      });
      writeFileSync(join(evidence, name + '.log'), (result.stdout ?? '') + (result.stderr ?? ''));
      return result;
    };
    const baseline = run('baseline');
    const active = join(dir, 'activated'), preload = join(dir, 'mutant.mjs');
    writeFileSync(preload, `import {registerHooks} from 'node:module';import {writeFileSync} from 'node:fs';
registerHooks({load(url,ctx,next){const r=next(url,ctx);if(url===${JSON.stringify(pathToFileURL(join(root,file)).href)}){const s=typeof r.source==='string'?r.source:Buffer.from(r.source).toString();if(!s.includes(${JSON.stringify(before)}))throw Error('anchor');writeFileSync(${JSON.stringify(active)},'applied');return {...r,source:s.replace(${JSON.stringify(before)},${JSON.stringify(after)})};}return r;}});`);
    const mutant = run('mutant', { ...cliEnv, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` });
    let observed; try { observed = JSON.parse(readFileSync(join(evidence, 'mutant/verdict.json'))); } catch {}
    const killed = baseline.status === 0 && mutant.status === 1 && existsSync(active)
      && observed?.verdict === 'FAIL' && observed.rows?.length === 1 && observed.rows[0].verdict === 'FAIL' && verify(observed.rows[0]);
    report.mutants.push({ id, source: file, baselineExit: baseline.status, mutantExit: mutant.status, activated: existsSync(active), killed });
    console.log(`${id}: ${killed ? 'KILLED' : 'SURVIVED'}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
report.verdict = report.mutants.every(m => m.killed) ? 'PASS' : 'FAIL';
writeFileSync(join(out, 'verdict.json'), JSON.stringify(report, null, 2) + '\n');
if (report.verdict !== 'PASS') process.exitCode = 1;
