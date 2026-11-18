import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
const failures = vi.hoisted(() => ({ at: '' }));
const captured = vi.hoisted(() => { vi.resetModules(); return [] as Array<{ files: Array<{ path: string; bytes: Buffer; kind: string; sha256: string }> }>; });
vi.mock('./hook-canon.ts', async original => ({
  ...await original<typeof import('./hook-canon.ts')>(),
  registerCanon: (files: any[]) => { const set = { id: String(captured.length), files }; captured.push(set); return set; },
  ensureCanon: (set: any, at: string) => failures.at === at ? { ok: false, path: set.files[0].path, why: 'owner', error: 'fixture repair obstruction' } : { ok: true, restored: [] }, dropCanon: () => {},
}));
import { writeHookFiles, hookEnvPathOf } from './drivers/codex-hook.ts';
import { openAntigravityRelay } from './drivers/antigravity-relay.ts';
import { antigravityAskStopHooks } from './drivers/antigravity.ts';
import { buildAntigravityScopedHome } from './drivers/antigravity-scope.ts';
import { applyHermesAskHook } from './drivers/acp/hermes.ts';
import { removeTempDirSync } from './testing/cleanup.ts';
const roots: string[] = [];
afterEach(() => { failures.at = ''; captured.length = 0; for (const root of roots.splice(0)) removeTempDirSync(root); });
const fixture = () => { const root = mkdtempSync(join(tmpdir(), 'hook-registry-')); roots.push(root); return root; };
describe('T19 hook artifacts are handed to the canonical writer', () => {
  it('F1–F4: scripts, launcher, config and per-process env are registered before any hook write', () => {
    const root = fixture(); const home = join(root, 'native', 'codex-scope', 'scope');
    const files = writeHookFiles(home, '/socket', 'token', hookEnvPathOf(home, 'gate'));
    expect(captured.flatMap(set => set.files.map(file => file.path)).sort()).toEqual([files.script, files.launcher, files.hooksJson, files.envFile].sort());
    for (const file of captured.flatMap(set => set.files)) expect(existsSync(file.path)).toBe(false);
  });
  it('F5–F8: relay, env, ask script and scoped hooks config; mirrors and MCP config stay outside the registry', async () => {
    const root = fixture(); const realHome = join(root, 'owner'); mkdirSync(realHome);
    const relay = await openAntigravityRelay(join(root, 'native', 'antigravity-relay', 'turn'), async () => ({ decision: 'deny', reason: 'test' }));
    let scope: ReturnType<typeof buildAntigravityScopedHome> | undefined;
    try {
      antigravityAskStopHooks(root);
      scope = buildAntigravityScopedHome({ realHome, scopeRoot: join(root, 'native', 'antigravity-scope'), name: 'turn',
        servers: { fixture: { command: '/fixture', args: [], env: {} } }, askStopHooks: relay.hooksJson });
      const paths = captured.flatMap(set => set.files.map(file => file.path));
      expect(paths).toHaveLength(4);
      expect(paths.some(path => path.endsWith('murage-agy-relay.cjs'))).toBe(true);
      expect(paths.some(path => path.endsWith('murage-agy-relay.env'))).toBe(true);
      expect(paths.some(path => /ask-hook-[a-f0-9]+\.cjs$/.test(path))).toBe(true);
      expect(paths.some(path => path.endsWith('hooks.json'))).toBe(true);
      expect(paths.some(path => /mcp_config|manifest|process/.test(path))).toBe(false);
      for (const path of paths) expect(existsSync(path)).toBe(false);
      expect(existsSync(join(scope.home, '.gemini', 'config', 'mcp_config.json'))).toBe(true);
    } finally { scope?.dispose(); relay.close(); }
  });
  it('T22 V-H1 refuses handing over the managed config when repair fails', () => {
    failures.at = 'V-H1';
    const env: Record<string, string> = { MURAGE_DATA_DIR: fixture() };
    expect(() => applyHermesAskHook(env, { hostComputer: false })).toThrow(expect.objectContaining({ code: 'hook-repair-failed' }));
    expect(env.HERMES_MANAGED_DIR).toBeUndefined();
    expect(env.HERMES_ACCEPT_HOOKS).toBeUndefined();
  });
  it('F9–F10: Hermes script and managed config are registered together', () => {
    const root = fixture(); const env: Record<string, string> = { MURAGE_DATA_DIR: root };
    const set = applyHermesAskHook(env, { hostComputer: false });
    expect(set.files).toHaveLength(2);
    expect(set.files.map(file => file.kind).sort()).toEqual(['config', 'script']);
    expect(set.files.find(file => file.kind === 'config')?.path).toBe(join(env.HERMES_MANAGED_DIR!, 'config.yaml'));
    for (const file of set.files) expect(existsSync(file.path)).toBe(false);
  });
});


describe('T16b serialized Ask-stop and Hermes shell commands', () => {
  for (const engine of ['ask-stop', 'hermes'] as const) for (const name of ['space name', '日本語', "&;()'", '$HOME', '$(touch /tmp/pwn)', '`touch /tmp/pwn`', 'back\\slash']) it.runIf(process.platform !== 'win32')(`${engine} preserves ${name}`, () => {
    const root = fixture(), data = join(root, name); mkdirSync(data, { recursive: true });
    const runtime = join(data, 'runtime'), runtimeLog = join(root, 'runtime-argv'), scriptLog = join(root, 'script-argv'), preload = join(root, 'preload.cjs');
    const node = process.execPath;
    writeFileSync(runtime, '#!/bin/sh\nprintf "%s" "$0" > "$HOOK_ARGV_LOG"\nexec "$HOOK_REAL_NODE" "$@"\n'); chmodSync(runtime, 0o700);
    let command: string;
    if (engine === 'ask-stop') command = JSON.parse(antigravityAskStopHooks(data, runtime))['murage-ask-stop'].PreToolUse[0].hooks[0].command;
    else {
      const env: Record<string, string> = { MURAGE_DATA_DIR: data };
      try { process.execPath = runtime; applyHermesAskHook(env, { hostComputer: false }); } finally { process.execPath = node; }
      const config = captured.flatMap(set => set.files).find(file => file.kind === 'config')!;
      command = parseYaml(config.bytes.toString()).hooks.pre_tool_call[0].command;
    }
    const files = captured.flatMap(set => set.files);
    for (const file of files) { mkdirSync(dirname(file.path), { recursive: true }); writeFileSync(file.path, file.bytes); }
    const script = files.find(file => file.kind === 'script')!.path;
    writeFileSync(preload, `globalThis.MURAGE_LOADER_AFTER_VERIFY=()=>require('fs').writeFileSync(${JSON.stringify(scriptLog)},process.argv[1])`);
    const result = spawnSync('/bin/sh', ['-c', command], { cwd: root, input: JSON.stringify({ toolCall: { name: 'read_file' }, tool_name: 'terminal', tool_input: { command: 'pwd' } }), encoding: 'utf8', timeout: 3000,
      env: { ...process.env, NODE_OPTIONS: `--require=${preload}`, HOOK_ARGV_LOG: runtimeLog, HOOK_REAL_NODE: node } });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(runtimeLog, 'utf8')).toBe(runtime); expect(readFileSync(scriptLog, 'utf8')).toBe(script);
    expect(JSON.parse(result.stdout)).toMatchObject(engine === 'hermes' ? { action: 'approve' } : { decision: 'allow' });
    expect(existsSync('/tmp/pwn')).toBe(false);
  });
});
