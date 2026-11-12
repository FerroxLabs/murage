import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
vi.hoisted(() => { vi.resetModules(); });
// Only the canonical filesystem writer is a seam; the driver, gate, child and loader are real.
vi.mock('../hook-canon.ts', async original => ({
  ...await original<typeof import('../hook-canon.ts')>(),
  registerCanon: (files: any[]) => ({ id: files[0].path, files }),
  ensureCanon: (set: any) => {
    for (const file of set.files) { mkdirSync(dirname(file.path), { recursive: true, mode: 0o700 }); writeFileSync(file.path, file.bytes, { mode: 0o600 }); }
    return { ok: true, restored: [] };
  },
  ensureAllLive: () => [], dropCanon: () => {},
}));
import { CodexDriver } from './codex.ts';
import { resetIsolationCache } from './isolation-cache.ts';
import { ensureDirs } from '../config.ts';
import { recordEvents } from '../testing/events.ts';
import { CODEX_HOOK_SCRIPT, CodexHookGate, type HookDelivery } from './codex-hook.ts';
import { HOOK_LOADER } from '../hook-canon.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
const roots: string[] = [];
const gates: CodexHookGate[] = [];
afterEach(() => { for (const gate of gates.splice(0)) { gate.close(); gate.release(); } for (const root of roots.splice(0)) removeTempDirSync(root); });
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-token-')); roots.push(dir); mkdirSync(join(dir, 'hook-env'));
  const gate = new CodexHookGate(); gates.push(gate); await gate.listen();
  const script = join(dir, 'hook.mjs'); writeFileSync(script, CODEX_HOOK_SCRIPT);
  const envFile = join(dir, 'hook-env', 'child.env');
  const envText = `SOCKET=${gate.path}\nTOKEN=process-token\n`; writeFileSync(envFile, envText);
  const run = (event = 'PreToolUse') => new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', HOOK_LOADER.codex, script, hash(CODEX_HOOK_SCRIPT)], { env: { ...process.env, MURAGE_CODEX_HOOK_ENV: envFile, MURAGE_CODEX_HOOK_ENV_SHA256: hash(envText) }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.resume(); child.on('error', reject);
    child.on('close', code => resolve({ code, stdout })); child.stdin.end(JSON.stringify({ hook_event_name: event, tool_name: 'Bash', tool_input: { command: 'pwd' }, tool_use_id: 'call' }));
  });
  return { gate, envFile, envText, run };
}
describe('T15b process token and generation ownership', () => {
  it('gate generations authenticate fixed env bytes; stale disarm cannot retire the new turn', async () => {
    const f = await fixture(); const seen: HookDelivery[] = [];
    const handlers = { token: 'process-token', onSession: () => {}, onPreTool: async (call: HookDelivery) => { seen.push(call); return { decision: 'allow' as const }; } };
    const first = f.gate.arm(handlers); expect(await f.run()).toEqual({ code: 0, stdout: '' });
    f.gate.disarm(first); const second = f.gate.arm(handlers); expect(second).not.toBe(first);
    f.gate.disarm(first); expect(await f.run()).toEqual({ code: 0, stdout: '' }); expect(seen).toHaveLength(2);
    writeFileSync(f.envFile, f.envText.replace('process-token', 'changed-token'));
    expect(JSON.parse((await f.run()).stdout).hookSpecificOutput.permissionDecision).toBe('deny'); expect(seen).toHaveLength(2);
  });
  it('V-C2 SessionStart refusal reaches the hook as a failed proof', async () => {
    const f = await fixture();
    f.gate.arm({ token: 'process-token', onSession: () => false, onPreTool: async () => ({ decision: 'allow' }) });
    expect(await f.run('SessionStart')).toEqual({ code: 2, stdout: '' });
  });
  it('each fresh process authenticates its own env generation, and changed bytes never connect', async () => {
    for (let child = 0; child < 2; child++) {
      const f = await fixture(); const seen: HookDelivery[] = [];
      f.gate.arm({ token: 'process-token', onSession: () => {}, onPreTool: async call => { seen.push(call); return { decision: 'allow' }; } });
      expect(await f.run()).toEqual({ code: 0, stdout: '' }); expect(seen).toHaveLength(1);
      writeFileSync(f.envFile, f.envText + 'EXTRA=value\n');
      expect(JSON.parse((await f.run()).stdout).hookSpecificOutput.permissionDecision).toBe('deny'); expect(seen).toHaveLength(1);
    }
  });
});

it('T15b CodexDriver reuses one child across two authenticated turns without rotating its token', async () => {
  ensureDirs(); resetIsolationCache();
  const root = mkdtempSync(join(tmpdir(), 'codex-driver-token-')); roots.push(root);
  const cli = fileURLToPath(new URL('../testing/fake-codex-app-server.ts', import.meta.url)); chmodSync(cli, 0o755);
  const home = join(root, 'home'); mkdirSync(home); writeFileSync(join(home, 'config.toml'), '');
  const dump = join(root, 'dump.json'), spawns = join(root, 'spawns');
  const instance = await CodexDriver.create({ instanceId: 'token-reuse', displayName: 'Codex', enabled: true, config: { cli, fullAuto: false },
    environment: { CODEX_HOME: home, FAKE_CODEX_VERSION: 'codex-cli 0.150.0', FAKE_CODEX_WARM: '1', FAKE_CODEX_DUMP: dump,
      FAKE_CODEX_GATED_SPAWN_LOG: spawns, FAKE_CODEX_TOOLS: JSON.stringify([{ kind: 'shell', id: 'execution', command: 'echo fixture' }]) } });
  const recorder = recordEvents(instance.adapter);
  instance.adapter.onEvent(e => { if (e.type === 'request.opened') void instance.adapter.respondToRequest(e.threadId, e.requestId!, { behavior: 'allow' }); });
  try {
    let firstPid: number | undefined;
    let resumeCursor: string | undefined;
    for (let turn = 1; turn <= 2; turn++) {
      const sent = await instance.adapter.sendTurn({ threadId: 'token-reuse', text: `turn ${turn}`, cwd: root, resumeCursor, warmIdentity: { botId: 'token-bot', audience: 'owner' },
        integrations: { agents: { command: process.execPath, args: ['-e', ''], env: {} } } });
      expect(await recorder.until(e => e.type === 'turn.completed' && e.turnId === sent.turnId, 15000), JSON.stringify(recorder.events)).toMatchObject({ ok: true });
      const session = recorder.events.find(e => e.type === 'session.started');
      if (session?.type === 'session.started') resumeCursor = session.sessionId ?? undefined;
      const wire = JSON.parse(readFileSync(dump, 'utf8'));
      firstPid ??= wire.pid;
      expect(wire.pid).toBe(firstPid);
      expect(wire.hookLog.filter((call: any) => call.id === 'execution')).toEqual(Array.from({ length: turn }, () => expect.objectContaining({ verdict: 'allow' })));
      expect(wire.calls.filter((call: any) => call.method === 'turn/start')).toHaveLength(turn);
    }
    expect(readFileSync(spawns, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(recorder.events.filter(e => e.type === 'request.opened')).toHaveLength(2);
  } finally { recorder.stop(); await instance.dispose(); }
});
