// SPDX-License-Identifier: AGPL-3.0-or-later
// CHROME-RESUME-FROM-APP (1.0.23, row CR): server side, witnesses W8-W14, W17-W20. The REAL service runs against the REAL extension
// runtime (extensions/murage-browser/runtime.mjs behind the shared chrome.* fixture); only storage, tabs and the debugger are faked at the
// Chrome API boundary. The broker below is the one adapter (design section 9): every runtime emit() reaches the service at once and in
// order, before the response to the same command resolves (the real ordered port), it echoes the request generation (broker.ts:143), and a
// gate can hold a chrome API call. A port close rejects what is in flight the way the real broker does.
import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { safeWipe } from './testing/safe-wipe.mjs';
import { privateTestDirectory } from './testing/private-test-dir.ts';
import { createBrowserExtensionService } from './browser-extension-service.ts';
import { BrowserExtensionIntegration } from './browser-extension-integration.ts';
import type { BrowserExtensionCommand, BrowserExtensionHello } from '../shared/browser-extension-protocol.ts';
// @ts-ignore shared in-memory Chrome transport fixture
import { fixture as runtimeFixture } from '../scripts/browser-extension-test-fixture.mjs';

const ORIGIN = 'https://allowed.test';
const cleanup: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0)) await close().catch(() => {}); for (const directory of cleanup.splice(0)) await safeWipe(directory, { within: path.resolve('.') }); });
const hold = () => { let release!: () => void; let arrive!: () => void; const released = new Promise<void>(resolve => { release = resolve; }); const arrived = new Promise<void>(resolve => { arrive = resolve; }); return { released, arrived, release, arrive }; };
/** An AssertionError, so a witness that never reaches its step fails as an assertion on base, never as a harness error. */
const boom = (message: string): Error => { try { expect.fail(message); } catch (error) { return error as Error; } return Error(message); };
const until = async (ready: () => boolean, what: string) => { const started = Date.now(); while (!ready()) { if (Date.now() - started > 3000) throw boom(`timed out waiting: ${what}`); await new Promise(resolve => setTimeout(resolve, 2)); } };
/** The app's press, answered as a value either way (the assertion that follows names what it should have been). */
const answer = <T>(promise: Promise<T>) => promise.then(value => value as T | { refused: string }, (error: { code?: string; message?: string }) => ({ refused: error.code ?? String(error.message) }) as T | { refused: string });

async function harness(options: { capabilities?: (all: string[]) => string[]; settleMs?: number; deadlineMs?: number } = {}) {
  const { root, directory } = await privateTestDirectory(path.resolve('.appresume-')); cleanup.push(root);
  let connected = true; let service!: Awaited<ReturnType<typeof createBrowserExtensionService>>;
  const log: BrowserExtensionCommand[] = [];
  const delivered: string[] = [];
  const suppress = new Set<string>();
  const refuse = new Map<string, string>();
  const inflight = new Set<(error: Error) => void>();
  const drops: string[] = [];
  const pending: Promise<unknown>[] = [];
  // runtime.emit: at once, in order, before the response (the ordered port)
  const f = runtimeFixture({}, { emit: (e: { type: string; event?: string; bindingId: string }) => {
    if (e.type !== 'event' || suppress.has(String(e.event)) || !service) return;
    delivered.push(String(e.event)); pending.push(service.handleMessage('profile_1', e as never).catch(() => {}));
  } });
  await f.runtime.initialize();
  let hello = await f.runtime.connection(true) as BrowserExtensionHello;
  const closePort = async () => { connected = false; for (const reject of inflight) reject(Object.assign(Error('host_lost_uncertain'))); inflight.clear(); await f.runtime.connection(false); };
  const reconnect = async () => { hello = await f.runtime.connection(true) as BrowserExtensionHello; connected = true; service.onHello('profile_1'); };
  const broker = {
    profiles: (): BrowserExtensionHello[] => connected ? [{ ...hello, capabilities: options.capabilities ? options.capabilities(hello.capabilities) : hello.capabilities }] : [],
    drop(profileId: string) { drops.push(profileId); void closePort(); return true; },
    async request(_profile: string, command: BrowserExtensionCommand) {
      log.push(command);
      if (!connected) throw Error('host_offline');
      const envelope = { version: 1 as const, type: 'response' as const, id: command.id, bindingId: command.bindingId, generation: command.generation };
      if (refuse.has(command.operation)) return { ...envelope, error: { code: refuse.get(command.operation)!, message: 'refused' } };
      const wire = { ...command, id: f.nextId() };
      const racers: Promise<any>[] = [f.runtime.handleRequest(wire), new Promise((_, reject) => { inflight.add(reject); })];
      if (options.deadlineMs !== undefined) racers.push(new Promise((_, reject) => setTimeout(() => reject(Error('deadline_exceeded_uncertain')), options.deadlineMs)));
      const answer = await Promise.race(racers);
      if (answer.generation !== command.generation) throw Error('invalid_response');
      return { ...answer, id: command.id } as never;
    },
  };
  const stateFile = path.join(directory, 'state.json');
  const makeService = () => createBrowserExtensionService({ broker, workspaceId: 'workspace', stateFile, askSite: async () => 'allow' as const, askAction: async () => true,
    botName: () => 'Dax', approvalMode: () => 'full' as const, appResumeSettleMs: options.settleMs ?? 400 } as never);
  service = await makeService();
  closers.push(() => service.close());
  const binding = await service.ensureBinding({ botId: 'bot', threadId: 'thread', profileId: 'profile_1' });
  const id = binding.bindingId;
  const integration = new BrowserExtensionIntegration({ dataDir: directory, socketDir: directory, workspaceId: 'workspace', approvalBus: { store: { bots: [], groups: [], messagesFor: () => [] } } as never, bot: () => undefined, protectedOrigins: [] } as never);
  (integration as unknown as { service: unknown }).service = service;
  const settle = async () => { for (let quiet = 0; quiet < 3;) { const batch = pending.splice(0); await Promise.all(batch); await new Promise(resolve => setTimeout(resolve, 5)); quiet = batch.length === 0 ? quiet + 1 : 0; } };
  const server = () => service.status().bindings.find(item => item.bindingId === id) as { state: string; generation: number; pausedReason?: string; outcomeUnknown?: boolean };
  const ext = async () => (await f.command('status', {}, 1, id)).result as { state: string; generation: number };
  const resumes = (from = 0) => log.slice(from).filter(command => command.operation === 'resume').length;
  const press = (generation = server().generation, surface: 'desktop' | 'phone' | 'panel' = 'desktop') => integration.ownerAction(id, 'resume', { surface, generation });
  /** The refusal the press ended with; a press that did not refuse yields a marker the caller's own assertion then fails on. */
  const refusal = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { return error as { status?: number; code?: string; errorKey?: string }; } return { status: 0, code: 'not_refused' } as { status?: number; code?: string; errorKey?: string }; };
  // The task sits on an approved page (a blank tab is refused by the policy when a Resume is taken in).
  await service.setSiteAccess(id, ORIGIN, 'allow');
  f.tabs.get(1).url = `${ORIGIN}/page`; await f.runtime.navigation({ tabId: 1, frameId: 0, url: `${ORIGIN}/page` });
  await settle();
  /** The server restarts with the saved task record edited (a hand-over the engine's floor made is a saved pause the service reloads). */
  const restart = async (edit: (record: { state: string; pausedReason?: string; handoffText?: string }) => void) => {
    await service.close(); const saved = JSON.parse(await readFile(stateFile, 'utf8')); edit(saved.bindings[0]); await writeFile(stateFile, JSON.stringify(saved));
    service = await makeService(); closers.push(() => service.close()); (integration as unknown as { service: unknown }).service = service; await settle();
  };
  return { f, get service() { return service; }, restart, integration, id, log, delivered, suppress, refuse, drops, server, ext, resumes, press, refusal, settle, closePort, reconnect, broker };
}
type H = Awaited<ReturnType<typeof harness>>;
/** An owner-paused task: plainly paused on both sides at the same generation. */
const paused = async (options?: Parameters<typeof harness>[0]) => { const h = await harness(options); await h.service.pause(h.id); await h.settle(); expect(await h.ext()).toMatchObject({ state: 'paused', generation: h.server().generation }); return h; };
/** The chrome.storage write inside the next ownerResume rejects with a plain Error (no code), as Chrome does: armed when that Resume reads its tabs. */
const failNextSave = (h: H) => {
  const set = h.f.api.storage.local.set.getMockImplementation()!, get = h.f.api.tabs.get.getMockImplementation()!; let armed = false, waiting = true;
  h.f.api.tabs.get.mockImplementation(async (tabId: number) => { if (waiting) { waiting = false; armed = true; } return get(tabId); });
  h.f.api.storage.local.set.mockImplementation(async (value: unknown) => { if (armed) { armed = false; throw new Error('QUOTA_BYTES quota exceeded'); } return set(value); });
};
const holdTabsGet = (h: H) => { const gate = hold(); gate.arrived = Promise.race([gate.arrived, new Promise<void>((_, reject) => setTimeout(() => reject(boom('the resume never reached the tab read')), 1500))]); gate.arrived.catch(() => {}); const get = h.f.api.tabs.get.getMockImplementation()!; let armed = true; h.f.api.tabs.get.mockImplementation(async (tabId: number) => { if (armed) { armed = false; gate.arrive(); await gate.released; } return get(tabId); }); return gate; };

/** The press must reach the tab read. A press refused before it (base: the app Resume does not exist) fails here on its own outcome, an assertion on the behaviour, never on the gate timeout. */
const reachedTabRead = async (gate: { arrived: Promise<void> }, pressing: Promise<unknown>) => {
  const first = await Promise.race([gate.arrived.then(() => 'read' as const), pressing.then(outcome => ({ settledFirst: outcome }))]);
  expect(first, 'the Resume was settled before it read the tab').toBe('read');
};

describe('CHROME-RESUME W8-W14, W17-W20 (server, real runtime behind the broker adapter)', () => {
  it('W8: the phone and the side panel are refused with zero commands; the desktop resumes (active)', async () => {
    const h = await paused();
    for (const surface of ['phone', 'panel'] as const) {
      const error = await h.refusal(h.press(h.server().generation, surface));
      expect(error).toMatchObject({ status: 403, errorKey: 'browserExt.owner.errorResumeDesktop' });
    }
    expect(h.resumes()).toBe(0);
    const done = await answer(h.press()) as { state: string };
    expect(done.state).toBe('active'); expect(h.resumes()).toBe(1);
  });

  it('W9: a generation the app did not show is refused stale_generation with zero commands of any kind', async () => {
    const h = await paused();
    const before = h.log.length;
    const error = await h.refusal(h.press(h.server().generation - 1));
    expect(error).toMatchObject({ status: 409, code: 'stale_generation', errorKey: 'browserExt.owner.errorResumeChanged' });
    expect(h.log.length).toBe(before); expect(h.server().state).toBe('paused');
    const missing = await h.refusal(h.integration.ownerAction(h.id, 'resume', { surface: 'desktop' }));
    expect(missing).toMatchObject({ status: 409, code: 'stale_generation' }); expect(h.log.length).toBe(before);
  });

  it('W10a: a restart-paused task (uncertain) resumes only through the resumed event: active, outcomeUnknown cleared, tools mount', async () => {
    const h = await harness();
    await h.service.handleMessage('profile_1', { version: 1, type: 'response', id: 'old_1', bindingId: h.id, generation: h.server().generation, error: { code: 'uncertain', message: 'x' } } as never);
    await h.settle();
    expect(h.server()).toMatchObject({ state: 'paused', pausedReason: 'uncertain', outcomeUnknown: true });
    const before = h.delivered.length;
    const done = await answer(h.press()) as { state: string; generation: number };
    const atResponse = h.server();   // read in the tick the press resolved: the take-in must already be complete
    expect(h.delivered.slice(before)).toContain('resumed');
    expect({ answered: done.state, server: atResponse.state, outcomeCleared: !atResponse.outcomeUnknown }).toEqual({ answered: 'active', server: 'active', outcomeCleared: true });
    expect(h.server()).toMatchObject({ state: 'active', generation: (await h.ext()).generation });
    expect(h.service.tools(h.id, () => true).tools.length).toBeGreaterThan(0);
  });

  it('W10b: the resumed event never arrives: resume_unconfirmed, the server stays paused (never written active from the response)', async () => {
    const h = await paused({ settleMs: 60 });
    h.suppress.add('resumed');
    const done = await answer(h.press()) as { state: string; code?: string };
    expect(done).toMatchObject({ state: 'paused', code: 'resume_unconfirmed' });
    expect(h.server().state).toBe('paused');
  });

  it('W11: a profile without app_resume_v1 gets update_extension and zero commands', async () => {
    const h = await paused({ capabilities: all => all.filter(name => name !== 'app_resume_v1') });
    const error = await h.refusal(h.press());
    expect(error).toMatchObject({ status: 409, code: 'update_extension', errorKey: 'browserExt.updateToResumeApp' });
    expect(h.resumes()).toBe(0);
  });

  it('W12: the extension save fails with a plain Error (extension_error): Chrome is re-paused, the server stays paused, errorResumeFailed', async () => {
    const h = await paused();
    failNextSave(h);
    const error = await h.refusal(h.press());
    expect(error).toMatchObject({ status: 409, errorKey: 'browserExt.owner.errorResumeFailed' });
    await h.settle();
    const ext = await h.ext();
    expect(ext.state).toBe('paused'); expect(h.server().state).toBe('paused');
    expect(h.server().generation).toBe(ext.generation);
  });

  it('W12b: the follow-up pause is refused too: the connection is dropped, Chrome ends paused, errorResumeFailed', async () => {
    const h = await paused();
    failNextSave(h); h.refuse.set('pause', 'extension_error');
    const error = await h.refusal(h.press());
    expect(error).toMatchObject({ status: 409, errorKey: 'browserExt.owner.errorResumeFailed' });
    await h.settle();
    expect(h.drops).toEqual(['profile_1']);
    await h.reconnect(); await h.settle();
    expect((await h.ext()).state).toBe('paused');
  });

  it('W13: a Pause in Chrome lands while Resume reads the tab: errorResumeChanged, both paused, generations equal', async () => {
    const h = await paused();
    const gate = holdTabsGet(h);
    h.suppress.add('paused');   // the panel's paused event is lost: only the refusal's own read can bring the server's generation up
    const pressing = h.refusal(h.press());
    await reachedTabRead(gate, pressing);
    await h.f.runtime.handlePanel({ action: 'pause', bindingId: h.id });
    gate.release();
    const error = await pressing;
    expect(error).toMatchObject({ status: 409, errorKey: 'browserExt.owner.errorResumeChanged' });
    await h.settle();
    const ext = await h.ext();
    expect(ext.state).toBe('paused'); expect(h.server().state).toBe('paused'); expect(h.server().generation).toBe(ext.generation);
  });

  it('W13b: the host disconnects while the resume is in flight: errorResumeOffline, Chrome paused', async () => {
    const h = await paused();
    const gate = holdTabsGet(h);
    const pressing = h.refusal(h.press());
    await reachedTabRead(gate, pressing);
    await h.closePort(); gate.release();
    const error = await pressing;
    expect(error).toMatchObject({ status: 409, errorKey: 'browserExt.owner.errorResumeOffline' });
    await h.reconnect(); await h.settle();
    expect(h.server().state).toBe('paused'); expect((await h.ext()).state).toBe('paused');
  });

  it('W13c: an unlisted extension answer (the tab closed before Resume) is 409 errorResumeFailed, never a 500 (the resume_unconfirmed answer is witnessed on the HTTP route)', async () => {
    const h = await paused();
    h.f.tabs.delete(1);
    const error = await h.refusal(h.press());
    expect(error).toMatchObject({ status: 409, errorKey: 'browserExt.owner.errorResumeFailed' });
    expect(error.status).not.toBe(500);
  });

  it('W13c: a code the integration does not know (the broker is busy) is 409 errorResumeFailed too, never a 500', async () => {
    const h = await paused(); const real = h.service;
    (h.integration as unknown as { service: unknown }).service = { ...real, resumeFromApp: async () => { throw Object.assign(Error('broker_busy'), { code: 'broker_busy' }); } };
    const error = await h.refusal(h.press());
    expect(error).toMatchObject({ status: 409, code: 'broker_busy', errorKey: 'browserExt.owner.errorResumeFailed' });
  });

  it('W14: two presses in the same tick: one resume command, the second is resume_in_flight', async () => {
    const h = await paused();
    const generation = h.server().generation;
    const results = await Promise.allSettled([h.press(generation), h.press(generation)]);
    expect(h.resumes()).toBe(1);
    const failed = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[];
    expect(failed.length).toBe(1); expect(failed[0].reason).toMatchObject({ status: 409, code: 'resume_in_flight', errorKey: 'browserExt.owner.errorResumeBusy' });
    expect(h.server().state).toBe('active');
  });

  it('W17: an orphan-active extension (a panel Resume whose save failed) is re-fenced on the stale refusal; the next press resumes', async () => {
    const h = await paused();
    const g = h.server().generation;
    failNextSave(h);
    await h.f.runtime.handlePanel({ action: 'resume', bindingId: h.id }).catch(() => {});
    await h.settle();
    expect(await h.ext()).toMatchObject({ state: 'active', generation: g + 1 });
    expect(h.server()).toMatchObject({ state: 'paused', generation: g });
    const error = await h.refusal(h.press(g));
    expect(error).toMatchObject({ status: 409, errorKey: 'browserExt.owner.errorResumeFailed' });
    await h.settle();
    const ext = await h.ext();
    expect(ext.state).toBe('paused'); expect(h.server().state).toBe('paused'); expect(h.server().generation).toBe(ext.generation);
    const done = await answer(h.press()) as { state: string };
    expect(done.state).toBe('active');
  });

  it('W18: Chrome does not answer in time while connected: errorResumeSlow, no further command, the marker is cleared, a late resumed event is taken in', async () => {
    const h = await paused({ deadlineMs: 40 });
    const gate = holdTabsGet(h);
    const before = h.log.length;
    const error = await h.refusal(h.press());
    expect(error).toMatchObject({ status: 409, code: 'deadline_exceeded_uncertain', errorKey: 'browserExt.owner.errorResumeSlow' });
    expect(h.log.slice(before).filter(command => command.operation !== 'bind').length).toBe(1);   // the resume itself; nothing after it
    gate.release();
    await until(() => h.server().state === 'active', 'the late resumed event is taken in');
  });

  it('W19: every step-1 refusal sends zero commands of any kind (active, offline, stopped, hand-over)', async () => {
    const active = await harness(); const activeFrom = active.log.length;
    expect(await active.refusal(active.press())).toMatchObject({ status: 409, code: 'not_paused', errorKey: 'browserExt.owner.errorResumeChanged' });
    expect(active.log.length).toBe(activeFrom);
    const offline = await paused(); await offline.closePort(); const offlineFrom = offline.log.length;
    expect(await offline.refusal(offline.press())).toMatchObject({ status: 409, code: 'host_offline', errorKey: 'browserExt.owner.errorResumeOffline' });
    expect(offline.log.length).toBe(offlineFrom);
    const stopped = await harness(); await stopped.service.stop(stopped.id); await stopped.settle(); const stoppedFrom = stopped.log.length;
    expect(await stopped.refusal(stopped.press())).toMatchObject({ status: 409, code: 'binding_stopped', errorKey: 'browserExt.owner.errorStopped' });
    expect(stopped.log.length).toBe(stoppedFrom);
    // the hand-over row: a REAL hand-over (a saved hand-over pause the restarted service reloads), refused by the integration's check and,
    // called past it, by the service's own, each with zero commands
    const handoff = await harness();
    await handoff.restart(record => { record.state = 'paused'; record.pausedReason = 'handoff'; record.handoffText = 'Please do this step.'; });
    expect(handoff.server()).toMatchObject({ state: 'paused', pausedReason: 'handoff' });
    const handoffFrom = handoff.log.length;
    expect(await handoff.refusal(handoff.press())).toMatchObject({ status: 409, code: 'handoff_use_continue', errorKey: 'browserExt.owner.errorUseContinue' });
    expect(await handoff.refusal(handoff.service.resumeFromApp(handoff.id, handoff.server().generation))).toMatchObject({ code: 'handoff_use_continue' });
    expect(handoff.log.length).toBe(handoffFrom);
  });

  it('W20: a site the owner revoked while the task was paused is not reachable through the app Resume (site_denied, stays paused)', async () => {
    const h = await harness();
    await h.service.pause(h.id); await h.settle();
    await h.service.setSiteAccess(h.id, ORIGIN, 'ask'); await h.settle();
    const error = await h.refusal(h.press());
    expect(error).toMatchObject({ status: 409, code: 'site_denied', errorKey: 'browserExt.owner.errorResumeSite' });
    expect((await h.ext()).state).toBe('paused'); expect(h.server().state).toBe('paused');
  });
  it('W20b: the owner revoked a site while paused and that bind failed: the app Resume binds the server set first, so the revoked site is still refused (site_denied)', async () => {
    const h = await harness();
    await h.service.pause(h.id); await h.settle();
    h.refuse.set('bind', 'extension_error');
    await h.service.setSiteAccess(h.id, ORIGIN, 'ask').catch(() => {});
    h.refuse.delete('bind'); await h.settle();
    expect(h.server().state).toBe('paused');
    const error = await h.refusal(h.press());
    expect(error).toMatchObject({ status: 409, code: 'site_denied', errorKey: 'browserExt.owner.errorResumeSite' });
    expect((await h.ext()).state).toBe('paused'); expect(h.server().state).toBe('paused');
  });
});
