// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, chmodSync, readdirSync, copyFileSync, openSync, closeSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { compareReds, smoothVerdict, webVerdict, fixtureVerdict } from './judge.mjs';
import { readSmoothReceipt } from './smooth-receipt.mjs';
import { cleanupOwnedShards } from './owned-shards.mjs';
import { trulyLiveVerdict } from './truly-verdict.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const argv = process.argv.slice(2), ref = argv.shift();
let baseRef = '1a899c675', outParent = '/work/build/bld-gatekit-1019/runs', dry = false, nolimConfig, smoothFrom;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--base' && argv[i + 1]) baseRef = argv[++i];
  else if (argv[i] === '--out' && argv[i + 1]) outParent = resolve(argv[++i]);
  else if (argv[i] === '--dry-run') dry = true;
  else if (argv[i] === '--nolim-config' && argv[i + 1]) nolimConfig = resolve(argv[++i]);
  else if (argv[i] === '--smooth-from' && argv[i + 1]) smoothFrom = resolve(argv[++i]);
  else throw Error(`Unknown option: ${argv[i]}`);
}
if (!ref) throw Error('Usage: gate-1019.sh <sha> [--base sha] [--out evidence-parent] [--dry-run]');
if (process.platform !== 'linux') throw Error('Run on build-host; never the Mac');
const safe = p => p !== '/dev' && !p.startsWith('/dev/') && p !== '/';
if (!safe(outParent)) throw Error('Evidence must be outside /dev and /');
function git(...args) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw Error(`git ${args[0]} failed: ${r.stderr}`);
  return r.stdout.trim();
}
const sha = git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`);
const base = git('rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`);
mkdirSync(outParent, { recursive: true });
const out = mkdtempSync(join(outParent, `${sha.slice(0, 12)}-`));
chmodSync(out, 0o755);
const home = join(out, 'home'); mkdirSync(home);
const config = join(out, 'empty.gitconfig'); writeFileSync(config, '');
// An empty, job-owned Git config is writable. Never use /dev/null here.
const env = { PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: home, CI: '1', NO_COLOR: '1',
  GIT_CONFIG_GLOBAL: config, GIT_CONFIG_SYSTEM: config, TMPDIR: out };
const rows = [], containers = new Set(), children = new Map(), shardLogs = new Set();
let stopping = false;
const snapshot = join(out, 'candidate');
const shellQuote = s => `'${String(s).replaceAll("'", "'\\''")}'`;
const manualKit = `bash ${shellQuote(join(here, 'gate-1019.sh'))} ${sha} --base ${base}`;
function record(gate, result, detail, evidence) {
  if (result === 'UNVERIFIED') detail = { ...detail, manual: detail?.manual ?? manualKit };
  const path = join(out, `${gate.replaceAll(/[^a-zA-Z0-9.-]/g, '_')}.json`);
  writeFileSync(path, JSON.stringify({ gate, result, sha, base, detail, evidence }, null, 2) + '\n');
  rows.push({ gate, result, evidence: path });
  process.stderr.write(`${gate}: ${result}\n`);
  if (result === 'UNVERIFIED') process.stderr.write(`${gate} manual: ${detail.manual}\n`);
}
async function run(command, args, log, options = {}) {
  if (stopping) throw Error('Runner is stopping');
  writeFileSync(join(out, 'commands.jsonl'), JSON.stringify({ at: new Date().toISOString(), command, args,
    cwd: options.cwd ?? repo, log, environment: options.env ?? {} }) + '\n', { flag: 'a' });
  const fd = openSync(log, 'w');
  return await new Promise(resolveResult => {
    const child = spawn(command, args, { env: { ...env, ...options.env }, cwd: options.cwd ?? repo, stdio: ['ignore', fd, fd], detached: true });
    let closed;
    children.set(child, new Promise(resolveClosed => { closed = resolveClosed; }));
    const terminate = signal => { try { process.kill(-child.pid, signal); } catch {} };
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; terminate('SIGTERM'); }, options.timeout ?? 7_200_000);
    const hard = setTimeout(() => terminate('SIGKILL'), (options.timeout ?? 7_200_000) + 30_000);
    const finish = code => { children.delete(child); clearTimeout(timer); clearTimeout(hard); closeSync(fd); closed(); resolveResult(timedOut ? 124 : code ?? 125); };
    child.once('error', error => { writeFileSync(`${log}.error`, String(error)); });
    child.once('close', finish);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function loadGuard() {
  while (+readFileSync('/proc/loadavg', 'utf8').split(' ')[0] > 60) {
    process.stderr.write('Waiting: host load > 60\n'); await sleep(20_000);
  }
}
async function leg(name, fn) {
  try { await fn(); } catch (e) { record(name, 'UNVERIFIED', { error: String(e), manual: manualKit }); }
}
async function stopChildren() {
  // Reap the dispatch groups before inspecting mounts: no shard can launch
  // after cleanup has enumerated the resources assigned by this invocation.
  const active = [...children.entries()];
  for (const [child] of active) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
  let hard;
  try {
    await Promise.race([Promise.all(active.map(([, closed]) => closed)), new Promise(resolveWait => {
      hard = setTimeout(() => {
        for (const [child] of active) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
        resolveWait();
      }, 5_000);
    })]);
    await Promise.all(active.map(([, closed]) => closed));
    for (const [child] of active) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  } finally { clearTimeout(hard); }
}
async function cleanup() {
  await stopChildren();
  for (const log of shardLogs) cleanupOwnedShards(log, sha, out);
  for (const name of containers) spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8' });
  if (safe(snapshot) && snapshot.startsWith(out + '/')) safeWipeSync(snapshot, { within: out });
  if (safe(home)) safeWipeSync(home, { within: out });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if (stopping) return; stopping = true;
  try { await cleanup(); }
  catch (error) { writeFileSync(join(out, 'cleanup-error.json'), JSON.stringify({ error: String(error) })); }
  process.exit(130);
});
writeFileSync(join(out, 'manifest.json'), JSON.stringify({ sha, base, dryRun: dry, started: new Date().toISOString(),
  controller: git('rev-parse', 'HEAD'), smoothRig: '1715ad380105197f58345d1fc4912dae50c8f43c', smoothFrom,
  policy: 'fake engines only; no login, billable API, live data, Mac, or resource provisioning',
  concurrency: '5 vt-shard containers + 2 local fixture containers + 1 smoothness worker = 8 maximum for this kit' }, null, 2));

// Clone uses local objects only; it creates no registration in the user's repo.
let rc = await run('git', ['clone', '--shared', '--no-checkout', git('rev-parse', '--git-common-dir'), snapshot], join(out, 'clone.log'));
if (rc !== 0) throw Error(`Candidate clone failed; ${out}/clone.log`);
rc = await run('git', ['-C', snapshot, 'checkout', '--detach', sha], join(out, 'checkout.log'));
if (rc !== 0) throw Error(`Candidate checkout failed; ${out}/checkout.log`);
// Test-only overlay: never import product changes from another lane.
const injected = readdirSync(join(repo, 'server')).filter(f => f.startsWith('release-marc-') && f.endsWith('.test.ts'));
for (const f of injected) copyFileSync(join(repo, 'server', f), join(snapshot, 'server', f));
writeFileSync(join(out, 'fixture-overlay.json'), JSON.stringify(injected.map(f => ({ file: `server/${f}`,
  sha256: createHash('sha256').update(readFileSync(join(repo, 'server', f))).digest('hex') })), null, 2));
// The shared dependency cache is read-only. Never install or download dependencies.
const lock = createHash('sha256').update(readFileSync(join(snapshot, 'pnpm-lock.yaml'))).digest('hex').slice(0, 16);
const nm = `/root/fuigo-builds/tools/nm/${lock}/node_modules`;
const available = existsSync(nm) && spawnSync('docker', ['image', 'inspect', 'node:24-bookworm'], { stdio: 'ignore' }).status === 0;
let slots = 0;
async function fixture(name, command) {
  if (!available) return { code: null, log: 'Missing pinned dependency cache or local node:24-bookworm image' };
  while (slots >= 2) await sleep(250);
  slots++;
  const dir = join(out, name); mkdirSync(dir); chmodSync(dir, 0o777);
  const container = `gate1019-${process.pid}-${name.toLowerCase().replaceAll(/[^a-z0-9-]/g, '-')}`;
  try {
    await loadGuard(); containers.add(container);
    const prep = 'mkdir -p /tmp/home /work/node_modules; cp -a /src/. /work/; for f in /nm/* /nm/.[!.]*; do case "$f" in */.vite-temp|*/.vite|*/.cache) ;; *) ln -s "$f" /work/node_modules/;; esac; done; ';
    const log = join(dir, 'run.log');
    const code = await run('docker', ['run', '--rm', '--init', '--pull=never', '--name', container,
      '--label', `owner=gate1019-${process.pid}`, '--user', '2001:2001', '--cpus', '2', '--memory', '8g', '--network', 'none',
      '--tmpfs', '/work:rw,exec,size=4g,uid=2001,gid=2001,mode=0755',
      '--tmpfs', '/home:rw,uid=2001,gid=2001,mode=0755', '-e', 'HOME=/tmp/home', '-e', 'CI=1',
      '-e', 'ELECTRON_SKIP_BINARY_DOWNLOAD=1', '-e', 'WEBREAD_REVISION=' + sha,
      '-e', 'RELEASE_GATE_EVIDENCE=/evidence', '-e', 'BROWSER_WAIT_EVIDENCE=/evidence/browser-workflow',
      '-e', 'GIT_CONFIG_GLOBAL=/tmp/home/gitconfig', '-e', 'GIT_CONFIG_SYSTEM=/tmp/home/gitconfig',
      '-v', snapshot + ':/src:ro', '-v', nm + ':/nm:ro', '-v', dir + ':/evidence', '-w', '/work',
      'node:24-bookworm', 'bash', '-euc', prep + command], log, { timeout: 900_000 });
    return { code, log, dir };
  } finally {
    spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' }); containers.delete(container); slots--;
  }
}
async function tests(gate, files, pattern) {
  const missing = files.filter(f => !existsSync(join(snapshot, f)));
  if (missing.length) return record(gate, 'FAIL', { missing, scope: 'candidate fixture absent' });
  const r = await fixture(gate, `node node_modules/vitest/vitest.mjs run ${files.map(shellQuote).join(' ')} --maxWorkers=1 --reporter=default --reporter=json --outputFile=/evidence/tests.json${pattern ? ' -t ' + shellQuote(pattern) : ''}`);
  if (r.code === null) return record(gate, 'UNVERIFIED', { ...r, manual: manualKit });
  let report; try { report = JSON.parse(readFileSync(join(r.dir, 'tests.json'), 'utf8')); } catch {}
  record(gate, fixtureVerdict(report, r.code, pattern),
    { ...r, scope: 'isolated fake fixture; no installed engine proof', passed: report?.numPassedTests, failed: report?.numFailedTests });
}

async function fullSuite() {
  const tool = '/root/fuigo-builds/tools/vt-shard.sh';
  const manual = `VT_WIDEN=0 MAXC=5 LOADMAX=60 bash ${tool} ${shellQuote(repo)} ${sha} --hosts hz`;
  if (!existsSync(tool)) return record('FULL', 'UNVERIFIED', { manual, reason: 'build host vt-shard tool missing' });
  const cageKey = createHash('sha256').update(readFileSync(join(snapshot, 'scripts/build-murage-cage.mjs')))
    .update(readFileSync(join(snapshot, 'scripts/prepare-source-cage.mjs'))).digest('hex').slice(0, 16);
  if (!available || !existsSync(`/root/fuigo-builds/tools/cage/${cageKey}/linux-x64/bwrap`)) {
    return record('FULL', 'UNVERIFIED', { manual, reason: 'Missing prewarmed dependencies/cage/image; refusing networked preparation by vt-shard' });
  }
  await loadGuard();
  const log = join(out, 'vt-shard.log');
  shardLogs.add(log);
  // Explicit hz overrides inherited VT_WIDEN. Never provision or visit Vultr.
  let code;
  const lockDeadline = Date.now() + 7_200_000;
  try {
    do {
      code = await run('bash', ['-x', tool, repo, sha, '--hosts', 'hz'], log,
        { env: { MAXC: '5', LOADMAX: '60', VT_WIDEN: '0', VT_REMOTE_OK: '0' } });
      if (code !== 4 || dry || Date.now() > lockDeadline) break;
      process.stderr.write('FULL: registry locked; waiting for existing run\n'); await sleep(20_000);
    } while (true);
  } finally {
    // The signal handler first reaps child groups, then uses this same cleanup.
    if (!stopping) cleanupOwnedShards(log, sha, out);
  }
  const registry = s => `/root/fuigo-builds/shared-base/${s}/out`;
  const complete = s => {
    const d = registry(s);
    return existsSync(join(d, 'SUMMARY.md')) && existsSync(join(d, 'FAILS.txt')) &&
      readFileSync(join(d, 'SUMMARY.md'), 'utf8').includes(`# vt-shard result for ${s}`) &&
      /files with a result [1-9][0-9]*; files with NO RESULT: 0/.test(readFileSync(join(d, 'SUMMARY.md'), 'utf8')) &&
      /^- tests [1-9][0-9]*, passed /m.test(readFileSync(join(d, 'SUMMARY.md'), 'utf8')) &&
      !/NO RESULT shards/.test(readFileSync(join(d, 'SUMMARY.md'), 'utf8')) &&
      (!existsSync(join(d, 'NORESULT.txt')) || !readFileSync(join(d, 'NORESULT.txt'), 'utf8').trim());
  };
  if (!complete(sha) || !complete(base)) return record('FULL', 'UNVERIFIED', { code, log, manual,
    reason: 'Candidate or base registry incomplete/locked; no partial green', candidate: registry(sha), base: registry(base),
    manualBase: `VT_WIDEN=0 MAXC=5 LOADMAX=60 bash ${tool} ${shellQuote(repo)} ${base} --hosts hz` });
  const diff = compareReds(readFileSync(join(registry(sha), 'FAILS.txt'), 'utf8'), readFileSync(join(registry(base), 'FAILS.txt'), 'utf8'));
  for (const s of new Set([sha, base])) {
    const dest = join(out, `registry-${s}`); mkdirSync(dest);
    for (const f of ['FAILS.txt', 'SUMMARY.md', 'NORESULT.txt']) if (existsSync(join(registry(s), f))) copyFileSync(join(registry(s), f), join(dest, f));
  }
  record('FULL', diff.NEW.length ? 'FAIL' : 'PASS', { code, log, ...diff, meaning: 'PASS means no NEW reds; inherited reds are separately blocking below' });
  record('FULL-base-reds', diff.BASE.length ? 'FAIL' : 'PASS', { BASE: diff.BASE });
}

async function smoothness() {
  const rig = '1715ad380105197f58345d1fc4912dae50c8f43c';
  if (smoothFrom && !safe(smoothFrom)) throw Error('Unsafe smoothness receipt directory');
  const rigDir = join(out, 'rig'); mkdirSync(rigDir);
  const archive = join(out, 'rig.tar');
  const ar = spawnSync('git', ['-C', repo, 'archive', '--output=' + archive, rig, 'scripts/smoothness'], { env });
  if (ar.status !== 0) throw Error('Pinned smoothness rig object unavailable');
  const unpack = spawnSync('tar', ['-xf', archive, '-C', rigDir], { env });
  if (unpack.status !== 0) throw Error('Cannot unpack pinned rig');
  const launcher = join(rigDir, 'scripts/smoothness/g8-smooth.sh');
  const sshArgs = ['-i', '/root/.ssh/build_runner', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'root@build-host.invalid'];
  // Idle and load share CPUs 0-5: sequential even when idle fails.
  for (const mode of ['idle', 'load']) await leg(`SMOOTH-${mode}`, async () => {
    const state = join(out, `smooth-${mode}`);
    const manual = `PREBUILD=1 G8_HUB=${shellQuote(git('rev-parse', '--git-common-dir'))} G8_RIG=${rig} G8_JOB=${shellQuote(state)} bash ${shellQuote(launcher)} ${sha} ${mode}`;
    if (smoothFrom) {
      // Explicit replay of completed evidence only. Default invocations always
      // run fresh legs. Recheck provenance and parse the raw worker log again.
      const receipt = readSmoothReceipt({ root: smoothFrom, sha, rig, mode, git });
      return record(`SMOOTH-${mode}`, receipt.result, { ...receipt, manual });
    }
    await loadGuard();
    let check;
    do {
      check = spawnSync('ssh', [...sshArgs, "awk '{print $1}' /proc/loadavg; docker ps -q | wc -l"], { encoding: 'utf8', env, timeout: 30_000 });
      if (check.status !== 0) break;
      const [load, count] = check.stdout.trim().split(/\s+/).map(Number);
      if (Number.isFinite(load) && Number.isFinite(count) && load <= 60 && count < 8) break;
      await sleep(20_000);
    } while (true);
    if (check.status !== 0) return record(`SMOOTH-${mode}`, 'UNVERIFIED', { manual, reason: 'Gate box SSH unavailable' });
    const log = join(out, `smooth-${mode}.log`);
    const code = await run('bash', [launcher, sha, mode], log, { env: { PREBUILD: '1', G8_RIG: rig,
      G8_HUB: git('rev-parse', '--git-common-dir'), G8_JOB: state }, timeout: 2_700_000 });
    // Launcher records the exact worker evidence directory; copy its reports only.
    let verdictText = '', evidence;
    const runs = existsSync(state) ? readdirSync(state).filter(f => f.startsWith(`run-${mode}.`)) : [];
    if (runs.length === 1) {
      const remoteFile = join(state, runs[0], 'remote');
      if (existsSync(remoteFile)) {
        const remote = readFileSync(remoteFile, 'utf8').trim();
        if (!/^root@178\.104\.176\.107:\/root\/mb-0161-hz\/smooth-v7-[a-f0-9]{12}-(idle|load)-[0-9-]+$/.test(remote)) throw Error('Unsafe worker evidence path');
        evidence = join(out, `smooth-${mode}-evidence`); mkdirSync(evidence);
        await run('rsync', ['-a', '-e', 'ssh -i /root/.ssh/build_runner -o BatchMode=yes -o ConnectTimeout=15',
          '--exclude=src', '--exclude=data', remote + '/', evidence + '/'], join(out, `smooth-${mode}-collect.log`), { timeout: 120_000 });
        const gateLog = join(evidence, 'gate.log');
        if (existsSync(gateLog)) verdictText = readFileSync(gateLog, 'utf8');
      }
    }
    if (!verdictText) verdictText = readFileSync(log, 'utf8');
    const verdict = smoothVerdict(verdictText, code);
    record(`SMOOTH-${mode}`, verdict.result, { ...verdict, code, log, evidence, manual });
  });
  record('SMOOTH-real-engines', 'UNVERIFIED', { reason: 'S10 rows require dedicated signed-in engines; fake rig does not prove them; no billable calls authorized',
    manual: `MURAGE_DATA_DIR="\${ISOLATED_SMOOTH_DATA:?fixture copy}" SMOOTH_WORK="$PWD" SMOOTH_OUT="\${SMOOTH_EVIDENCE:?new output directory}" SMOOTH_LABEL=gate1019-${sha.slice(0,12)} SMOOTH_ENGINES=real node scripts/smoothness/smooth.mjs`,
    prerequisite: 'Exact candidate checkout with pinned rig, isolated fixture and dedicated gate login; manual command can incur engine usage and is never automatically executed' });
}

async function noLimits() {
  const harness = 'scripts/nolim-replay/run.sh';
  const manualReplay = `bash ${harness} "\${NOLIM_IMAGE:?immutable image for ${sha}}" "\${NOLIM_CORPUS:?isolated inert corpus}" "\${NOLIM_RESULTS:?new allocated directory}" ${sha} "\${NOLIM_CORPUS_DIGEST:?}" "\${NOLIM_POLICY_DIGEST:?}" "\${NOLIM_PENDING_RECEIPT:?}"`;
  if (nolimConfig && existsSync(join(snapshot, harness))) {
    const cfg = JSON.parse(readFileSync(nolimConfig, 'utf8'));
    if (cfg.sha !== sha || cfg.inert !== true || !/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(cfg.image) ||
      !['corpusDigest', 'policyDigest'].every(k => /^[a-f0-9]{64}$/.test(cfg[k])) ||
      !['corpus', 'results', 'pendingReceipt'].every(k => typeof cfg[k] === 'string' && cfg[k].startsWith('/root/fuigo-builds/orph/_ev/nolim-replay/1019/') && !cfg[k].split('/').includes('..'))) {
      throw Error('Invalid inert replay configuration; use the harness allocated paths and exact candidate');
    }
    if (spawnSync('docker', ['image', 'inspect', cfg.image], { stdio: 'ignore' }).status !== 0) {
      record('G-NL-replay', 'UNVERIFIED', { reason: 'Pinned replay image is not installed; no pull or build attempted', manual: manualReplay });
    } else {
      await loadGuard();
      // Serialize with a fixture slot: full(5) + local(2, including replay) + smooth(1).
      while (slots >= 2) await sleep(250); slots++;
      try {
        const log = join(out, 'nolim-replay.log');
        const code = await run('bash', [join(snapshot, harness), cfg.image, cfg.corpus, cfg.results, sha,
          cfg.corpusDigest, cfg.policyDigest, cfg.pendingReceipt], log, { timeout: 1_900_000 });
        record('G-NL-replay', code === 0 ? 'PASS' : 'FAIL', { code, log, results: cfg.results,
          scope: 'Inert replay receipt verified by candidate harness; installed engine qualification stays separate' });
      } finally { slots--; }
    }
  } else record('G-NL-replay', existsSync(join(snapshot, harness)) ? 'UNVERIFIED' : 'FAIL', {
    reason: existsSync(join(snapshot, harness)) ? 'Private corpus/receipt and all-engine installed matrix unavailable; synthetic checks below cannot qualify release' : 'Replay harness absent at candidate',
    contract: 'S3-STATUS.txt; Sean 2026-11-12 02:05/02:50Z: admitted No limits origins, including webhooks, are wipe-only; guests never inherit; channel off wins; all available rig engines',
    manual: manualReplay });
  const replayTests = [
    "server/decision/no-limits-early-denials.test.ts",
    "server/no-limits-early-apps.test.ts",
    "server/no-limits-early-host.test.ts",
    "server/no-limits-early-origins.test.ts",
    "server/highlevel/no-limits-early-denials.test.ts",
    "server/decision/no-limits-feature-off.test.ts",
    "server/no-limits-early-api.test.ts",
    "scripts/nolim-replay/permission-rule-contract.test.mjs",
    // H6: these files are absolute hard gates, including reds already present on the RC.
    'server/nolimits-means-it.test.ts', 'server/powershell-fail-closed-104.test.ts',
    'server/nolimits-means-it-1020.test.ts', 'server/no-limits-r13-gate.test.ts',
    'server/no-limits-truly.test.ts', 'server/decision/no-limits-truly.test.ts', 'server/no-limits-inheritance.test.ts',
    'server/no-limits-origin-r3.test.ts', 'server/no-limits-external-r3.test.ts', 'server/no-limits-level-r3.test.ts', 'server/no-limits-wipe-r3.test.ts',
    'server/no-limits-symlink-r31.test.ts', 'server/decision/no-limits-x2-full-access.test.ts', 'server/decision/no-limits-y3b-full-access.test.ts',
    'src/components/NoLimitsFollowers.test.ts', 'src/components/RoutineApprovals.test.ts',
  ];
  const missing = replayTests.filter(f => !existsSync(join(snapshot, f)));
  if (missing.length) record('G-NL-fakes', 'FAIL', { missing });
  else await tests('G-NL-fakes', replayTests);
  const trulyReplay = 'scripts/no-limits-live/truly-proof.mjs';
  const missingTruly = [trulyReplay, 'scripts/no-limits-live/truly-rows.mjs'].filter(file => !existsSync(join(snapshot, file)));
  if (missingTruly.length) record('G-NL-truly-live', 'FAIL', { missing: missingTruly });
  else {
    const r = await fixture('nolim-truly-live', `TRULY_ONLY='' node --experimental-strip-types ${trulyReplay} /evidence/replay`);
    if (r.code === null) record('G-NL-truly-live', 'UNVERIFIED', { ...r, manual: manualKit });
    else {
      let report; try { report = JSON.parse(readFileSync(join(r.dir, 'replay/report.json'), 'utf8')); } catch {}
      const {trulyRows} = await import(pathToFileURL(join(snapshot, 'scripts/no-limits-live/truly-rows.mjs')).href);
      record('G-NL-truly-live', trulyLiveVerdict(report, r.code, trulyRows), { ...r, report: join(r.dir, 'replay/report.json'), scope: 'Required complete wipe-only origin/inheritance HTTP/SSE replay with a fake native engine' });
    }
  }
  const binaries = ['claude', 'codex', 'fuigo', 'gemini', 'pi', 'muse', 'antigravity'];
  const inventory = Object.fromEntries(binaries.map(binary => {
    const r = spawnSync('bash', ['-c', 'command -v "$1"', 'inventory', binary], { env, encoding: 'utf8' });
    return [binary, { path: r.status === 0 ? r.stdout.trim() : null, proof: 'UNVERIFIED' }];
  }));
  record('G-NL-installed-engines', 'UNVERIFIED', { reason: 'Real engine login/transport evidence is unavailable; no billable engines invoked',
    inventory, manual: `node --experimental-strip-types scripts/no-limits-live/run.mjs --live --release --out "$PWD/nolim-installed-${sha}"`,
    prerequisite: `Exact ${sha} checkout with the integrated live harness on the dedicated signed-in Linux rig, every available engine selected; isolated fixture data only. Manual command can incur engine usage and is never automatically executed.` });
}
async function web() {
  const file = 'scripts/web-read-replay/run.mjs';
  if (!existsSync(join(snapshot, file))) record('G-WEB-fake-routes', 'FAIL', { reason: 'Candidate lacks ' + file });
  else {
    const r = await fixture('web-fake', `node --experimental-strip-types ${file} --fake --out /evidence/routes`);
    let report; try { report = JSON.parse(readFileSync(join(r.dir, 'routes/verdict.json'), 'utf8')); } catch {}
    record('G-WEB-fake-routes', webVerdict(report, sha, r.code), { ...r, report });
  }
  record('G-WEB-installed', 'UNVERIFIED', { reason: 'Installed native-reader exclusions and binary proof missing; fake-route PASS never promotes this gate',
    manual: `WEBREAD_REVISION=${sha} node --experimental-strip-types ${file} --live --out "$PWD/web-installed-${sha}"`,
    prerequisite: `Exact ${sha} checkout, dedicated signed-in Linux gate user, isolated fixture data; retain binary hashes and native-reader exclusion proof. Manual command can incur engine usage and is never automatically executed.` });
}

try {
  await Promise.all([
    leg('FULL', fullSuite), leg('SMOOTH', smoothness), leg('G-NL', noLimits), leg('G-WEB', web),
    leg('G-MARC-ssh-cd', () => tests('G-MARC-ssh-cd', ['server/release-marc-commands.test.ts'], 'ssh/cd')),
    leg('G-MARC-compound', () => tests('G-MARC-compound', ['server/release-marc-commands.test.ts'], 'compound')),
    leg('G-MARC-seat', () => tests('G-MARC-seat', ['server/release-marc-seat.api.test.ts'])),
    leg('G-MARC-switch', () => tests('G-MARC-switch', ['server/release-marc-switch.api.test.ts'])),
    leg('G-MARC-browser', () => tests('G-MARC-browser', ['server/browser-turn-execution.test.ts', 'server/browser-owner-wait-api.test.ts'])),
    leg('G-MARC-connector', () => tests('G-MARC-connector', ['server/release-marc-buffer.test.ts', 'server/connected-app-health.test.ts', 'src/components/ReconnectAppsBanner.test.ts'])),
    leg('COPY-review', () => tests('COPY-review', ['src/locales/copy-final.test.ts'])),
    leg('COPY-release-pending', async () => {
      const r = await fixture('copy-pending', 'node scripts/copy-pending-check.mjs');
      record('COPY-release-pending', r.code === null ? 'UNVERIFIED' : r.code === 0 ? 'PASS' : 'FAIL', r);
    }),
    leg('LEAK-v2', async () => {
      const shared = '/root/fuigo-builds/shared/leak-guard.sh';
      if (!existsSync(shared) || !readFileSync(shared, 'utf8').includes('# v2:')) return record('LEAK-v2', 'UNVERIFIED', { manual: `node scripts/leak-guard/check.mjs --root ${shellQuote(snapshot)} --base ${base}`, reason: 'Shared v2 scanner missing' });
      const log = join(out, 'leak-v2.log');
      const code = await run('node', [join(snapshot, 'scripts/leak-guard/check.mjs'), '--root', snapshot, '--base', base], log);
      record('LEAK-v2', code === 0 ? 'PASS' : 'FAIL', { code, log });
    }),
  ]);
} finally { await cleanup(); }
for (const gate of ['FULL', 'FULL-base-reds', 'SMOOTH-idle', 'SMOOTH-load', 'SMOOTH-real-engines',
  'G-NL-replay', 'G-NL-fakes', 'G-NL-installed-engines', 'G-WEB-fake-routes', 'G-WEB-installed',
  'G-MARC-ssh-cd', 'G-MARC-compound', 'G-MARC-seat', 'G-MARC-switch', 'G-MARC-browser', 'G-MARC-connector',
  'LEAK-v2', 'COPY-review', 'COPY-release-pending']) {
  if (!rows.some(r => r.gate === gate)) record(gate, 'UNVERIFIED', { reason: 'Leg did not produce evidence; see dispatch error records', manual: manualKit });
}
rows.sort((a, b) => a.gate.localeCompare(b.gate));
const table = '| gate | result | evidence path |\n|---|---|---|\n' + rows.map(r => `| ${r.gate} | ${r.result} | ${r.evidence} |`).join('\n') + '\n';
writeFileSync(join(out, 'table.md'), table);
writeFileSync(join(out, 'results.json'), JSON.stringify({ sha, base, dryRun: dry, rows }, null, 2) + '\n');
process.stdout.write(table);
process.stderr.write(`Evidence: ${out}\n`);
process.exitCode = rows.some(r => r.result === 'FAIL') ? 1 : rows.some(r => r.result === 'UNVERIFIED') ? 2 : 0;
