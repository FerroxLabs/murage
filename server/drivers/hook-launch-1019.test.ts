import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CODEX_HOOK_SCRIPT, hookLaunchLine, hookWindowsLauncher } from './codex-hook.ts';
import { ANTIGRAVITY_RELAY_SCRIPT, antigravityRelayHooksJson } from './antigravity-relay.ts';

import { removeTempDirSync } from '../testing/cleanup.ts';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
describe('T16 authenticated hook launch commands', () => {
  it('Codex hands its script and canonical hash to the inline loader', () => {
    const command = hookLaunchLine('/runtime', '/script.mjs');
    expect(command).toContain(' -e "');
    expect(command).toContain(sha(CODEX_HOOK_SCRIPT));
    expect(hookWindowsLauncher()).toContain(' -e "');
    expect(hookWindowsLauncher()).toContain(sha(CODEX_HOOK_SCRIPT));
  });
  it('Antigravity hands its script hash to the inline loader', () => {
    const command = JSON.parse(antigravityRelayHooksJson('/script.cjs', '/runtime'))['murage-relay'].PreToolUse[0].hooks[0].command;
    expect(command).toContain(' -e "');
    expect(command).toContain(sha(ANTIGRAVITY_RELAY_SCRIPT));
  });
  it('T13c(h): invalid present Codex stdin cache denies without reading stdin', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hook-cache-')); roots.push(dir);
    const script = join(dir, 'hook.mjs');
    const count = join(dir, 'reads');
    const preload = join(dir, 'preload.cjs');
    writeFileSync(script, CODEX_HOOK_SCRIPT);
    writeFileSync(preload, `globalThis.MURAGE_HOOK_STDIN='invalid';process.stdin[Symbol.asyncIterator]=async function*(){require('fs').writeFileSync(${JSON.stringify(count)},'read');yield Buffer.from('{}')}`);
    const run = spawnSync(process.execPath, ['-r', preload, script], { input: '{}', encoding: 'utf8', timeout: 3000 });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(() => readFileSync(count)).toThrow();
  });
});

describe('T16b complete Codex and Antigravity shell launches', () => {
  for (const engine of ['codex', 'antigravity'] as const) for (const name of ['space name', '日本語', "&;()'", '$HOME', '$(touch /tmp/pwn)', '`touch /tmp/pwn`', 'back\\slash']) it.runIf(process.platform !== 'win32')(`${engine} preserves ${name} in runtime and script paths`, () => {
    const root = mkdtempSync(join(tmpdir(), 'hook-command-')); roots.push(root);
    const dir = join(root, name); mkdirSync(dir, { recursive: true });
    const runtime = join(dir, 'runtime'); const script = join(dir, engine === 'codex' ? 'hook.mjs' : 'hook.cjs');
    const argv = join(root, 'runtime-argv'); const scriptArgv = join(root, 'script-argv'); const preload = join(root, 'preload.cjs');
    writeFileSync(runtime, '#!/bin/sh\nprintf "%s" "$0" > "$HOOK_ARGV_LOG"\nexec "$HOOK_REAL_NODE" "$@"\n'); chmodSync(runtime, 0o700);
    writeFileSync(script, engine === 'codex' ? CODEX_HOOK_SCRIPT : ANTIGRAVITY_RELAY_SCRIPT);
    writeFileSync(preload, `globalThis.MURAGE_LOADER_AFTER_VERIFY=()=>require('fs').writeFileSync(${JSON.stringify(scriptArgv)},process.argv[1])`);
    const command = engine === 'codex' ? JSON.parse(JSON.stringify({ command: hookLaunchLine(runtime, script) })).command : JSON.parse(antigravityRelayHooksJson(script, runtime))['murage-relay'].PreToolUse[0].hooks[0].command;
    const result = spawnSync('/bin/sh', ['-c', command], { cwd: root, input: '{"hook_event_name":"PreToolUse"}', encoding: 'utf8', timeout: 3000,
      env: { ...process.env, NODE_OPTIONS: `--require=${preload}`, HOOK_ARGV_LOG: argv, HOOK_REAL_NODE: process.execPath } });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(argv, 'utf8')).toBe(runtime); expect(readFileSync(scriptArgv, 'utf8')).toBe(script);
    const answer = JSON.parse(result.stdout); expect(engine === 'codex' ? answer.hookSpecificOutput.permissionDecision : answer.decision).toBe('deny'); expect(existsSync('/tmp/pwn')).toBe(false);
  });
});
