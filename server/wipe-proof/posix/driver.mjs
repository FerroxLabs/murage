import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { here, tools, product, installPosix, shQuote as quote, shellFile, shellCanonicalFile, argvEqual, fastPathBlocks, medianBlock, posixStatus } from '../adapter.mjs';
import { assertTempRoot, snapshot, equal, assertTarget } from '../safety.mjs';
import { startApp } from '../app.mjs';
import { proveDevices } from './device-proof.mjs';
import { execute } from '../process.mjs';

const options = process.argv.slice(2);
const q = value => quote(shellFile(value));
const bootstrapShell = process.platform === 'win32' ? 'sh.exe' : '/bin/sh';
const stub = options.includes('--stub'), mutant = options.includes('--mutant-bypass');
if (options.some(x => !['--stub', '--mutant-bypass'].includes(x)) || mutant && !stub) {
  process.stderr.write('Usage: run.sh [--stub [--mutant-bypass]]\n'); process.exit(2);
}
let sandbox, app;
const results = [], unavailable = [];
const report = (name, ok, detail = {}) => {
  results.push({ name, ok, ...detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
};
try {
  sandbox = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'wipe-proof-'));
  await assertTempRoot(sandbox);
  const control = path.join(sandbox, 'control'), tree = path.join(sandbox, 'tree');
  const protectedRoot = path.join(tree, 'home'), benign = path.join(tree, 'benign');
  await fs.mkdir(control); await fs.mkdir(tree);
  const outside = path.join(sandbox, 'outside'); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'sentinel'), 'outside must remain byte identical');
  const outsideBefore = await snapshot(sandbox, [tree, control]);
  const shim = path.join(control, 'shim'), real = path.join(control, 'real');
  await fs.mkdir(real); await fs.mkdir(shim);
  const backendLog = path.join(control, 'backend.jsonl'), guardFile = path.join(control, 'guard.json');
  const realTools = {};
  for (const tool of tools) {
    const destination = path.join(real, tool); realTools[tool] = destination;
    await fs.writeFile(destination, '#!/bin/sh\nif [ "${WIPE_PROOF_FAST-}" = 1 ]; then exit 0; fi\nexec ' + q(process.execPath) + ' ' + q(path.join(here, 'fixture-tool.mjs')) + ' ' + q(tool) + ' "$@"\n', { mode: 0o700 });
  }
  if (stub) {
    for (const tool of tools) await fs.writeFile(path.join(shim, tool),
      '#!/bin/sh\n# Contract stub fast path; only inert fixture paths bypass its Node matcher.\nfast=1\nfor arg do case "$arg" in -*) ;; "$WIPE_PROOF_TREE"/benign/*) ;; *) fast=0 ;; esac; done\nif [ "$fast" = 1 ]; then exec ' + q(realTools[tool]) + ' "$@"; fi\nexec ' + q(process.execPath) + ' ' + q(path.join(here, 'stub-shim.mjs')) + ' ' + q(tool) + ' "$@"\n', { mode: 0o700 });
  } else {
    await fs.rmdir(shim); await installPosix(shim);
    await fs.access(product.client);
    for (const result of await proveDevices(path.join(shim, 'guard-lib.sh'), bootstrapShell)) report(result.name, result.ok);
  }
  const token = randomUUID(), threadId = 'fixture-thread';
  // Keep the Unix socket short even for long OS temp paths (macOS limit).
  const socket = process.platform === 'win32' ? '\\\\.\\pipe\\murage-wipe-' + randomUUID().replaceAll('-', '') : path.join(sandbox, 'app.sock');
  app = await startApp(socket, tree, token, threadId);
  const config = { v: 1, socket, threadId, token, roots: [shellFile(protectedRoot)],
    client: [shellFile(process.execPath), shellFile(stub ? path.join(here, 'stub-client.mjs') : product.client)],
    realTools: Object.fromEntries(Object.entries(realTools).map(([key, file]) => [key, shellFile(file)])), off: false };
  const baseEnv = { ...process.env, PATH: shim + path.delimiter + real + path.delimiter + process.env.PATH,
    HOME: path.join(control, 'home'), ENV: '', BASH_ENV: '', ZDOTDIR: path.join(control, 'home'),
    MURAGE_WIPE_GUARD: guardFile, MURAGE_WIPE_GUARD_OFF: '',
    WIPE_PROOF_TREE: tree, WIPE_PROOF_BACKEND: backendLog, WIPE_PROOF_REAL_DIR: real,
    WIPE_PROOF_SHIM: shim, WIPE_PROOF_MUTANT: mutant ? 'bypass' : '', PROTECTED: shellFile(protectedRoot) };
  delete baseEnv.UNSET; delete baseEnv.SHELLOPTS; delete baseEnv.BASHOPTS;
  await fs.mkdir(baseEnv.HOME);
  async function reset(variant = '') {
    await assertTarget(sandbox, tree); await fs.rm(tree, { recursive: true, force: true });
    await fs.mkdir(protectedRoot, { recursive: true }); await fs.mkdir(benign);
    for (let i = 0; i < 10; i++) await fs.mkdir(path.join(protectedRoot, 'child' + i));
    await fs.writeFile(path.join(protectedRoot, 'child0', 'keep'), 'protected');
    await fs.mkdir(path.join(benign, 'build')); await fs.mkdir(path.join(benign, 'space dir'));
    await fs.writeFile(backendLog, '');
      await fs.writeFile(guardFile, variant === 'malformed' ? '{' : JSON.stringify({ ...config, off: variant === 'off', socket: variant === 'unreachable'
        ? process.platform === 'win32' ? '\\\\.\\pipe\\murage-wipe-' + randomUUID().replaceAll('-', '') : path.join(sandbox, 'absent.sock') : socket }), { mode: 0o600 });
  }
  const shellPaths = {};
  for (const shell of ['bash', 'zsh', 'dash', 'fish']) {
    const lookup = await execute(bootstrapShell, ['-c', process.platform === 'win32'
      ? 'proof_shell=$(command -v ' + shell + ') || exit $?; cygpath -w "$proof_shell"' : 'command -v ' + shell], baseEnv, tree);
    if (lookup.code === 0) shellPaths[shell] = lookup.stdout.trim();
    else { unavailable.push(shell); console.log('UNAVAILABLE shell-' + shell); }
  }
  if (!Object.keys(shellPaths).length) throw Error('no-shells');
  // Bash versions disagree on nounset's process exit status. Use an independent
  // nonmutating invocation as the machine's oracle, and require its exact result.
  const nounsetOracle = shellPaths.bash ? await execute('bash', ['-uc', ': "$UNSET"'], baseEnv, tree) : null;
  if (nounsetOracle && (!nounsetOracle.code || !nounsetOracle.stderr.includes('UNSET'))) throw Error('nounset-oracle');
  const p = q(protectedRoot), b = q(benign), child = 'rm -rf "$PROTECTED"';
  const nested = 'bash -c ' + q(child);
  const nounset = 'bash -uc ' + q('bash -c ' + q('rm -rf "$PROTECTED/$UNSET"/*'));
  const cases = [
    { name: 'literal-root', command: `rm -rf ${p}`, match: true, requestArgv: ['-rf', protectedRoot] },
    { name: 'variable-root', command: 'rm -rf "$PROTECTED"', match: true },
    { name: 'glob-children', command: `rm -rf ${p}/*`, match: true },
    // MAIN RULING SEAN 1114-WIPE-HYBRID: use each shell's actual expansion syntax for the same nine children.
    { name: 'nearly-all-children', command: `rm -rf ${p}/child[0-8]`, fish: `rm -rf ${p}/child{0,1,2,3,4,5,6,7,8}`, match: true },
    { name: 'relative-glob', command: `cd ${p}; rm -rf *`, match: true },
    { name: 'child-shell', command: nested, match: true, needs: 'bash' },
    { name: 'nounset-does-not-inherit', command: nounset, match: true, needs: 'bash' },
    { name: 'child-nounset-stops', command: 'bash -uc ' + q('rm -rf "$PROTECTED/$UNSET"/*'), match: false,
      code: nounsetOracle?.code, stderr: nounsetOracle?.stderr, needs: 'bash', unchanged: true },
    { name: 'long-list-protected-last', command: 'bash -c ' + q(`for x in ${Array.from({ length: 9 }, (_, i) => q(path.join(benign, 'missing' + i))).join(' ')} ${p}; do rm -rf "$x" || exit $?; done`), match: true, runs: 9, needs: 'bash' },
    { name: 'nested-loops', command: 'bash -c ' + q(`for a in 1 2 3 4 5; do for x in ${p}; do rm -rf "$x" || exit $?; done; done`), match: true, needs: 'bash' },
    { name: 'native-long-list', command: `for x in ${Array.from({ length: 9 }, (_, i) => q(path.join(benign, 'missing' + i))).join(' ')} ${p}; do rm -rf "$x" || exit $?; done`,
      fish: `for x in ${Array.from({ length: 9 }, (_, i) => q(path.join(benign, 'missing' + i))).join(' ')} ${p}; rm -rf "$x"; or exit $status; end`, match: true, runs: 9 },
    { name: 'function-not-inherited', command: 'bash -c ' + q('rm() { :; }; ' + nested), match: true, needs: 'bash' },
    { name: 'move-root', command: `mv ${p} ${b}/moved`, match: true, requestTool: 'mv' },
    { name: 'rmdir-root', command: `rmdir ${p}`, match: true, requestTool: 'rmdir' },
    { name: 'mkfs-always-asks', command: `mkfs ${p}/device`, match: true, requestTool: 'mkfs' },
    { name: 'mkfs-variant', command: `mkfs.ext4 ${p}/device`, match: true, requestTool: 'mkfs.ext4' },
    { name: 'diskutil-erase', command: `diskutil eraseDisk fixture ${p}/device`, match: true, requestTool: 'diskutil' },
    { name: 'benign-build', command: `rm -rf ${b}/build`, match: false, runs: 1 },
    { name: 'benign-spaces', command: `rm -rf ${q(path.join(benign, 'space dir'))}`, match: false, runs: 1 },
    ...['dd', 'shred', 'wipefs'].map(tool => ({ name: tool + '-protected-target',
      command: tool === 'dd' ? `dd of=${p}` : `${tool} ${p}`, match: true, requestTool: tool })),
    { name: 'benign-dd', command: `dd if=${b}/source of=${b}/output`, match: false, runs: 1 },
    { name: 'benign-shred', command: `shred ${b}/missing`, match: false, runs: 1 },
    { name: 'benign-wipefs', command: `wipefs ${b}/missing`, match: false, runs: 1 },
    { name: 'printed-source', command: `printf '%s\\n' ${q(child)}`, match: false, stdout: child + '\n', unchanged: true },
    { name: 'passthrough-exit-streams', command: `rm -f ${b}/missing`, match: false, runs: 1, code: 7,
      env: { WIPE_PROOF_ECHO: '1', WIPE_PROOF_EXIT: '7' }, stdout: 'fixture out\n', stderr: 'fixture err\n', unchanged: true },
    { name: 'allow-root', command: `rm -rf ${p}`, match: true, allow: true, runs: 1, removed: true, requestArgv: ['-rf', protectedRoot], backendArgv: ['-rf', protectedRoot] },
    { name: 'allow-exit-streams', command: `rm -rf ${p}`, match: true, allow: true, runs: 1, code: 7,
      env: { WIPE_PROOF_ECHO: '1', WIPE_PROOF_EXIT: '7' }, stdout: 'fixture out\n', stderr: 'fixture err\n', unchanged: true },
    { name: 'scripted-allow-then-deny', command: `rm -rf ${p}; rm -rf ${p}`, match: true, runs: 1, requestCount: 2,
      decisions: ['allow', 'deny'], env: { WIPE_PROOF_EXIT: '7' } },
    { name: 'app-unreachable', command: `rm -rf ${p}`, variant: 'unreachable', code: posixStatus.unreachable, unchanged: true },
    { name: 'wrong-reply-id', command: `rm -rf ${p}`, match: true, decision: 'wrong-id', code: posixStatus.unreachable, unchanged: true },
    { name: 'app-disconnect', command: `rm -rf ${p}`, match: true, decision: 'disconnect', code: posixStatus.unreachable, unchanged: true },
    ...['missing', 'malformed', 'off', 'env-off'].map(variant => ({ name: 'fail-open-' + variant, command: `rm -rf ${p}`, variant, runs: 1, removed: true })),
  ];
  // Optional executables: absent binaries are explicit gaps, never green tests.
  for (const name of ['python3', 'fish']) {
    const lookup = await execute(bootstrapShell, ['-c', 'command -v ' + name], baseEnv, tree);
    if (lookup.code === 0) cases.push(name === 'python3'
      ? { name: 'python3-uc', command: 'python3 -uc ' + q('import subprocess,sys; sys.exit(subprocess.call(["sh","-c",\'rm -rf "$PROTECTED"\']))'), match: true }
      : { name: 'fish-command-equals', command: 'fish --command=' + q(child), match: true });
    else { unavailable.push(name + '-wrapper'); console.log('UNAVAILABLE ' + name + '-wrapper'); }
  }
  const su = await execute(bootstrapShell, ['-c', 'command -v su'], baseEnv, tree);
  if (su.code === 0) {
    const user = os.userInfo().username;
    const probe = await execute(su.stdout.trim(), ['-s', '/bin/sh', '--command=exit 0', user], baseEnv, tree, 3000);
    if (probe.code === 0) {
      const envWords = Object.entries(baseEnv).filter(([key]) => /^(WIPE_PROOF_|MURAGE_WIPE_|PROTECTED$|PATH$)/.test(key)).map(([key, value]) => `${key}=${q(value)}`).join(' ');
      cases.push({ name: 'su-command-equals', command: q(su.stdout.trim()) + ' -s /bin/sh --command=' + q('export ' + envWords + '; rm -rf "$PROTECTED"') + ' ' + q(user), match: true });
    } else { unavailable.push('su-command-runnable'); console.log('UNAVAILABLE su-command-runnable'); }
  } else { unavailable.push('su'); console.log('UNAVAILABLE su'); }
  for (const [shell, executable] of Object.entries(shellPaths)) {
    // Each fixed witness executes in every installed shell. Inner bash witnesses
    // intentionally test process boundaries independently of the outer dialect.
    for (const test of cases) {
      if (test.needs && !shellPaths[test.needs]) {
        unavailable.push(shell + '/' + test.name); console.log('UNAVAILABLE ' + shell + '/' + test.name); continue;
      }
      await reset(test.variant);
      const before = await snapshot(protectedRoot), requestStart = app.requests.length;
      app.script(test.decisions ?? [test.decision ?? (test.allow ? 'allow' : 'deny')]);
      const env = { ...baseEnv, ...test.env };
      if (test.variant === 'missing') delete env.MURAGE_WIPE_GUARD;
      if (test.variant === 'env-off') env.MURAGE_WIPE_GUARD_OFF = '1';
      const outcome = await execute(executable, ['-c', shell === 'fish' && test.fish ? test.fish : test.command], env, tree);
      const requests = app.requests.slice(requestStart);
      const backend = (await fs.readFile(backendLog, 'utf8')).trim().split('\n').filter(Boolean).map(x => JSON.parse(x));
      let protectedAfter;
      try { protectedAfter = await snapshot(protectedRoot); } catch { protectedAfter = null; }
      const expectedCode = test.code ?? (test.match && !test.allow ? posixStatus.deny : 0);
      const refused = test.match && !test.allow || test.variant === 'unreachable';
      const outsideOk = equal(outsideBefore, await snapshot(sandbox, [tree, control, socket]));
      const ok = !outcome.timedOut && !outcome.error && outcome.code === expectedCode &&
        requests.length === (test.requestCount ?? (test.match ? 1 : 0)) && backend.length === (test.runs ?? 0) &&
        outcome.stdout === (test.stdout ?? '') &&
        (test.stderr === undefined ? refused
          ? /refused|nothing was deleted/i.test(outcome.stderr) && outcome.stderr.trim().split('\n').length === 1 &&
            (expectedCode !== posixStatus.unreachable || /unreachable|could not reach/i.test(outcome.stderr) &&
              [shellFile(protectedRoot), shellCanonicalFile(protectedRoot)].some(target => outcome.stderr.includes(target)))
          : outcome.stderr === '' : outcome.stderr === test.stderr) &&
        (test.removed || equal(before, protectedAfter)) &&
        (!test.match || requests[0]?.tool === (test.requestTool ?? 'rm')) &&
        (!test.requestArgv || argvEqual(requests[0]?.argv, test.requestArgv)) &&
        (!test.backendArgv || argvEqual(backend[0]?.argv, test.backendArgv)) &&
        (!test.removed || protectedAfter === null) && outsideOk && app.faults.length === 0;
      report(shell + '/' + test.name, ok, { exit: outcome.code, expectedExit: expectedCode, requests: requests.length, backendCalls: backend.length, outsideOk, overflow: outcome.overflow,
        // A failing row carries the head of its own error text, so a host nobody can open still explains itself.
        ...(ok ? {} : { stderrHead: outcome.stderr.slice(0, 240) }) });
    }
  }
  await reset();
  const fastEnv = { ...baseEnv, WIPE_PROOF_FAST: '1' }, args = ['-f', path.join(benign, 'missing')];
  const median = xs => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  // Each block discards its first 5 rounds and keeps its own medians; the row judges the median block (adapter.mjs).
  const blocks = [], requestStart = app.requests.length;
  for (let block = 0; block < fastPathBlocks; block++) {
    const timings = { real: [], shim: [] };
    for (let i = 0; i < 45; i++) {
      for (const kind of i % 2 ? ['shim', 'real'] : ['real', 'shim']) {
        const start = performance.now();
        const executable = kind === 'real' ? realTools.rm : path.join(shim, 'rm');
        const outcome = process.platform === 'win32'
          ? await execute(bootstrapShell, ['-c', [executable, ...args].map(q).join(' ')], fastEnv, tree)
          : await execute(executable, args, fastEnv, tree);
        if (outcome.code !== 0 || outcome.stdout || outcome.stderr) throw Error('fast-path-semantics');
        if (i > 4) timings[kind].push(performance.now() - start);
      }
    }
    blocks.push({ timings, overheadMs: median(timings.shim) - median(timings.real) });
  }
  const { timings, overheadMs } = medianBlock(blocks);
  report('fast-path-under-5ms', overheadMs < 5 && app.requests.length === requestStart,
    { overheadMs, realMedianMs: median(timings.real), shimMedianMs: median(timings.shim), blockOverheadsMs: blocks.map(block => block.overheadMs), samples: 40 });
  report('outside-tree-unchanged', equal(outsideBefore, await snapshot(sandbox, [tree, control, socket])));
} catch {
  report('fixture-setup-or-run', false);
} finally {
  if (app) await app.close();
  if (sandbox) { await assertTempRoot(sandbox); await fs.rm(sandbox, { recursive: true, force: true }); }
}
const summary = { kind: 'wipe-proof-posix', mode: stub ? 'contract-stub' : 'production-guard', platform: process.platform,
  passed: results.filter(x => x.ok).length, failed: results.filter(x => !x.ok).length, unavailable,
  productionQualified: !stub && !results.some(x => !x.ok) && unavailable.length === 0, cases: results };
console.log(JSON.stringify(summary));
process.exitCode = summary.failed ? 1 : 0;
