#!/usr/bin/env node
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probes, platforms } from './catalog.mjs';
import { withFixture, fixtureEnv } from './fixture.mjs';
import { readGateConfig, subscriptionAuth, installAuth, binaryConfig } from './auth.mjs';
import { parseVersion, parseResultLine } from './results.mjs';
import { makeContext, executeProbe } from './engines.mjs';

export function parseArgs(args) {
  const options = { dryRun: true, os: undefined, selected: [], timeoutMs: 120000 };
  let mode;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--run' || arg === '--dry-run') {
      if (mode && mode !== arg) throw new Error('CONFLICTING-MODE');
      mode = arg; options.dryRun = arg === '--dry-run';
    } else if (arg === '--os') options.os = args[++i];
    else if (arg === '--probe') options.selected.push(args[++i]);
    else if (arg === '--timeout-ms') options.timeoutMs = Number(args[++i]);
    else throw new Error('INVALID-ARGUMENT');
  }
  if (!Object.hasOwn(platforms, options.os) || options.selected.some(id => !probes.some(item => item.probe === id)) ||
    !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 600000) throw new Error('INVALID-OPTIONS');
  return options;
}

export async function runSuite(options, { inherited = process.env, signal, emit = row => process.stdout.write(`${JSON.stringify(row)}\n`), tempRoot } = {}) {
  // Dry-run never parses auth, creates fixtures, resolves binaries or asks a
  // CLI for its version. Cross-OS plans can safely be inspected on Linux.
  const gate = options.dryRun ? { engines: {} } : readGateConfig(inherited.NATIVE_DENY_GATE_JSON);
  let failed = false;
  for (const definition of probes.filter(item => !options.selected.length || options.selected.includes(item.probe))) {
    const base = { probe: definition.probe, engine: definition.engine, version: 'unknown', os: options.os };
    let row;
    if (options.dryRun) {
      row = { ...base, result: 'SKIP', evidence: { reason: 'DRY-RUN', plan: definition.plan,
        observationOnly: definition.observation, fixtureHome: '$TEMP/murage-native-deny-UNIQUE/home',
        workDir: '$TEMP/murage-native-deny-UNIQUE/work/repo', auth: 'gate subscription handoff or SKIP-NO-AUTH',
        action: options.os === 'windows' ? 'New-Item of fixture canaries only' : 'touch of fixture canaries only',
        cleanup: 'owned fixture removed in finally after child shutdown', launches: 0 } };
    } else {
      try {
        row = await withFixture(async fixture => {
          const skip = reason => ({ ...base, result: 'SKIP', evidence: { reason } });
          if (signal?.aborted) return skip('SKIP-INTERRUPTED');
          if (platforms[options.os] !== process.platform) return skip('SKIP-WRONG-OS');
          if (definition.probe === 'P-C6' && (process.platform !== 'linux' || process.getuid?.() !== 0)) return skip('SKIP-REQUIRES-LINUX-ROOT');
          const config = gate.engines[definition.engine];
          const auth = subscriptionAuth(definition.engine, config);
          if (!auth) return skip('SKIP-NO-AUTH');
          const binary = binaryConfig(config);
          const env = fixtureEnv(fixture, inherited);
          installAuth(fixture, auth, env);
          const ctx = makeContext(fixture, binary, env, options.timeoutMs, signal);
          const version = await ctx.cli(['--version']);
          const parsed = version.code === 0 && !version.failure ? parseVersion(version.stdout) : null;
          if (!parsed) return { ...base, result: 'FAIL', evidence: { reason: 'UNKNOWN-ENGINE-VERSION', trace: version.trace } };
          base.version = parsed;
          const outcome = await executeProbe(ctx, definition, gate);
          if (outcome.rows.some(stage => stage.facts.authFailure)) return { ...base, result: 'SKIP', evidence: { reason: 'SKIP-NO-AUTH' } };
          return { ...base, result: outcome.pass ? 'PASS' : 'FAIL', evidence: {
            reason: outcome.pass ? definition.observation ? 'OBSERVATION-RECORDED' : 'CONTRACT-PROVEN' : 'CONTRACT-NOT-PROVEN',
            observationOnly: outcome.observationOnly, stages: outcome.rows,
          } };
        }, tempRoot);
        row.evidence.fixtureCleaned = true;
      } catch (error) {
        // Exceptions and raw engine output may carry credentials. Emit only
        // known codes, never arbitrary messages, stacks, paths or auth bytes.
        const code = /^(?:FIXTURE-[A-Z-]+|INVALID-[A-Z-]+|SUBSCRIPTION-AUTH-ONLY|CODEX-HOOKS-NOT-[A-Z]+)$/.test(error.message) ? error.message : 'PROBE-ERROR';
        row = { ...base, result: 'FAIL', evidence: { reason: code } };
      }
    }
    parseResultLine(JSON.stringify(row));
    failed ||= row.result === 'FAIL';
    emit(row);
  }
  return failed ? 1 : 0;
}

export async function main(args = process.argv.slice(2)) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try { return await runSuite(parseArgs(args), { signal: controller.signal }); }
  catch { process.stderr.write('native-deny: invalid options or gate configuration\n'); return 2; }
  finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
