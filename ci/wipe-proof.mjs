// Owners: wg-ci owns CI invocation/artifacts; wg-proof owns fixture safety;
// wg-int owns the real callback recipe; wg-winproof owns the Windows text list.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { finished } from 'node:stream/promises';
import { assertTempRoot } from '../server/wipe-proof/safety.mjs';

const candidate = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const [mode, destination, engine] = process.argv.slice(2);
assert.ok(['posix', 'windows-text'].includes(mode) && destination,
  'Usage: node ci/wipe-proof.mjs posix|windows-text EVIDENCE_DIR [powershell|pwsh]');
const evidence = path.resolve(destination);
const relative = path.relative(candidate, evidence);
assert.ok(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative), 'Evidence must be outside the checkout');
assert.ok(evidence !== path.parse(evidence).root && !/^\/dev(?:\/|$)/.test(evidence), 'Unsafe evidence directory');
const label = mode === 'windows-text' ? `PROOF-WINDOWS-${engine === 'powershell' ? 'PS51' : 'PS7'}`
  : `PROOF-${{ darwin: 'MACOS', win32: 'GIT-BASH', linux: 'LINUX' }[process.platform]}`;
await fs.mkdir(evidence, { recursive: true });
const logFile = path.join(evidence, label + '.log');
const log = createWriteStream(logFile);
const summary = { kind: 'wipe-ci-proof', mode, platform: process.platform, tempRootGuard: false, failed: 1 };
let scratch;
try {
  assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'Node 24 is required');
  // Assert the actual shared guard before launching either proof. No mutation
  // probe ever targets these paths: only the read-only admission predicate runs.
  await assert.rejects(assertTempRoot(path.parse(os.tmpdir()).root), /unsafe-fixture-root/);
  await assert.rejects(assertTempRoot(os.tmpdir()), /unsafe-fixture-root/);
  scratch = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'wipe-proof-ci-'));
  await assertTempRoot(scratch);
  summary.tempRootGuard = true;
  log.write('PASS safety/non-temp-root-refused\n');
  let command = process.execPath, args = [path.join(candidate, 'ci/run-real-proof.mjs'), candidate];
  if (mode === 'windows-text') {
    assert.equal(process.platform, 'win32', 'Windows text proof requires real Windows');
    assert.ok(['powershell', 'pwsh'].includes(engine), 'Explicit PowerShell version required');
    // The published launcher writes beside itself. Its temp copy imports the
    // untouched candidate caller, which reads the corpus/checker at source.
    const proof = path.join(scratch, 'server/wipe-proof/windows-gate');
    await fs.mkdir(proof, { recursive: true });
    await fs.copyFile(path.join(candidate, 'server/wipe-proof/windows-gate/run-windows.ps1'), path.join(proof, 'run-windows.ps1'));
    await fs.writeFile(path.join(proof, 'run.mjs'), `await import(${JSON.stringify(pathToFileURL(path.join(candidate, 'server/wipe-proof/windows-gate/run.mjs')).href)});\n`);
    command = engine + '.exe';
    const launcher = path.join(proof, 'run-windows.ps1').replaceAll("'", "''");
    const versionCheck = engine === 'powershell'
      ? '$PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1'
      : '$PSVersionTable.PSVersion.Major -ne 7';
    args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `$ErrorActionPreference='Stop'; if (${versionCheck}) { throw 'Required PowerShell version missing' }; & '${launcher}'; exit $LASTEXITCODE`];
    summary.engine = engine;
  }
  const code = await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: candidate, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
    child.once('error', reject); child.once('close', resolve);
  });
  log.end(); await finished(log);
  const output = await fs.readFile(logFile, 'utf8');
  const proofSummary = mode === 'posix'
    ? JSON.parse(output.trim().split(/\r?\n/).at(-1))
    : JSON.parse(await fs.readFile(path.join(scratch, 'server/wipe-proof/windows-gate/summary.windows.json'), 'utf8'));
  summary.proof = proofSummary;
  summary.exitCode = code;
  assert.equal(code, 0, 'Proof process failed');
  assert.ok(!/(?:^|\n)\s*FAIL\b/.test(output), 'FAIL line in proof output');
  assert.equal(proofSummary.failed, 0, 'Proof summary has failures');
  if (mode === 'posix') {
    assert.equal(proofSummary.mode, 'production-guard');
    assert.ok(proofSummary.cases.some(row => row.name === 'bash/literal-root' && row.ok), 'Git Bash/bash proof missing');
  } else assert.equal(proofSummary.commandsExecuted, 0, 'Windows corpus must remain text only');
  summary.failed = 0;
} catch (error) {
  summary.error = String(error);
  if (!log.writableEnded) { log.end(`FAIL ci-proof ${String(error)}\n`); await finished(log); }
  else await fs.appendFile(logFile, `FAIL ci-proof ${String(error)}\n`);
} finally {
  if (scratch) { await assertTempRoot(scratch); await fs.rm(scratch, { recursive: true, force: true }); }
  await fs.writeFile(path.join(evidence, label + '.json'), JSON.stringify(summary, null, 2) + '\n');
}
console.log(`${summary.failed ? 'FAIL' : 'PASS'} ${label}; artifacts: ${evidence}`);
process.exitCode = summary.failed ? 1 : 0;
