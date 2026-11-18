// PIS (r4 row, owner-facing P7c): a Stop whose first write is refused by a revoked lease ends as the one memory-refused terminal, with one tree kill.
import { chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const K = vi.hoisted(() => ({ kills: 0, on: false }));
vi.mock('../procs.ts', async (orig) => { const m: any = await orig(); return { ...m, killCliTree: (...a: any[]) => { if (K.on) K.kills++; return m.killCliTree(...a); } }; });
import { ensureDirs } from '../config.ts';
import { PiDriver } from './pi.ts';
import { recordEvents } from '../testing/events.ts';
import { fixtureBotFolder } from '../testing/bot-folder-fixture.ts';
import { consumingFixture } from '../testing/consuming-fixture.ts';
import { fixtureBoundTurn } from '../testing/mcp-admission-fixture.ts';
import { watchEscapes } from '../testing/nativecrash-harness.ts';
import type { ProviderInstance } from '../contracts.ts';
const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'testing', 'fake-pi-cli.ts');
let instance: ProviderInstance | undefined;
beforeEach(() => { ensureDirs(); chmodSync(FAKE_CLI, 0o755); });
afterEach(async () => { await instance?.dispose().catch(() => {}); instance = undefined; });
it('P7c pi Stop with a refused lease: :1299 first refused write, ONE memory-refused terminal', async () => {
  const watch = watchEscapes(); const stacks: string[] = [];
  const f = consumingFixture(undefined, { threadId: 'p7c', onRefused: () => { const lim = Error.stackTraceLimit; Error.stackTraceLimit = 60; const st = new Error().stack; Error.stackTraceLimit = lim; stacks.push((st ?? '').split('\n').filter(l => /drivers\/pi\.ts|engine-input/.test(l)).map(l => l.trim().replace(/^at .*\/server\//, '')).join(' | ')); } });
  try {
    instance = await PiDriver.create({ instanceId: 'p7c', displayName: 'pi', environment: { FAKE_PI_MODE: 'hold' }, enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
    const recorder = recordEvents(instance.adapter);
    const sent = await instance.adapter.sendTurn(fixtureBoundTurn({ cwd: fixtureBotFolder(), threadId: 'p7c', text: 'go', releaseBinding: f.binding } as any));
    await recorder.until((e: any) => e.type === 'turn.started', 10000).catch(() => {});
    await new Promise(r => setTimeout(r, 300));
    const before = f.refusals; K.kills = 0; K.on = true; f.replace();
    const t0 = Date.now(); let stop: any;
    try { stop = { ok: await instance.adapter.interruptTurn('p7c', sent.turnId) }; } catch (e: any) { stop = { error: String(e?.message ?? e) }; }
    const stopMs = Date.now() - t0;
    await new Promise(r => setTimeout(r, 1000)); // fixed grace; the assertions decide, not a test timeout
    const terminals = recorder.events.filter((e: any) => e.type === 'turn.completed' && e.turnId === sent.turnId);
    const facts = { refusalsBefore: before, refusals: f.refusals, stacks, stopMs, stop: stop.error ?? { closeConfirmed: stop.ok?.closeConfirmed },
      kills: K.kills, terminals: terminals.map((e: any) => e.stopReason ?? e.reason ?? e.error ?? e.ok), escapes: (watch as any).escapes?.length ?? null };
    K.on = false;
    recorder.stop();
    expect(facts.refusalsBefore).toBe(0);
    expect(facts.stacks.join(' '), 'first refused write is the :1299 abort').toMatch(/drivers\/pi\.ts/);
    expect(facts.stop, 'the :1297 termination ran and closure was confirmed').toEqual({ closeConfirmed: true });
    expect(facts.kills, 'P7c+K the one close owner kills the tree ONCE (mutant b: un-memoized closeOnce -> 2)').toBe(1);
    expect(facts.terminals.length, 'ONE terminal').toBe(1);
    expect(String(facts.terminals[0]), 'refused Stop ends memory-refused (P1), not cancelled').toMatch(/memory-refused/);
  } finally { watch.stop(); f.close(); }
}, 40000);
