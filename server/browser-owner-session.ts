import { browserCopy } from '../shared/browser-copy.ts';
import type { UnifiedBrowserController, BrowserStatus, Trailing } from './browser-control.ts';
import type { BrowserLifecycleGate } from './browser-lifecycle-gate.ts';

type OwnerBot = { id: string; name: string; selectionRevision?: number };
type Options = {
  controller: UnifiedBrowserController; lifecycle: BrowserLifecycleGate;
  bot: () => OwnerBot | undefined; currentKey: () => string | null;
  bind: () => Promise<{ key: string }>; owner: string; canReclaim: boolean;
  active: () => boolean; cloudDesktop?: boolean; afterHoldEnded: (key: string) => void;
};
export function browserOwnerFailure(code: string, name: string, status = 409) {
  const messages: Record<string, string> = {
    revision_changed: browserCopy("browser.server.browser-owner-session.1",{value0: name}),
    browser_closing: browserCopy("browser.server.browser-owner-session.2",{value0: name}),
    browser_close_failed: browserCopy("browser.server.browser-owner-session.3",{value0: name}),
  };
  return Object.assign(new Error(messages[code] ?? code), { code, status });
}
export function validateBrowserOwnerFields(body: Record<string, unknown>, cloudDesktop = false) {
  if (!Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 0 || typeof body.expectedKey !== 'string' || !body.expectedKey) {
    throw Object.assign(new Error(cloudDesktop ? browserCopy("browser.server.browser-owner-session.4") : browserCopy("browser.server.browser-owner-session.5")), { code: 'client_outdated', status: 409 });
  }
}
/** The only owner acquisition layer. Controller steps return plans; every
 * drain, daemon close and Allow prompt runs after both gates are released. */
export async function browserOwnerSessionRequest(o: Options, method: string, body: Record<string, unknown> = {}, frameGeneration?: number): Promise<BrowserStatus & { owned: boolean; canReclaim: boolean; selectionRevision: number; sessionKey: string }> {
  const bot = o.bot();
  const valid = () => { if (!bot || !o.active() || !o.owner) throw Object.assign(new Error(browserCopy("browser.server.browser-owner-session.6")), { status: 401, code: 'browser_inactive' }); };
  valid();
  if (method !== 'GET' && method !== 'POST') throw Object.assign(new Error(browserCopy("browser.server.browser-owner-session.7")), { status: 405 });
  if (method === 'POST') validateBrowserOwnerFields(body, o.cloudDesktop);
  if (JSON.stringify(body).length > 16384) throw Object.assign(new Error(browserCopy("browser.server.browser-owner-session.8")), { status: 413 });
  const c = o.controller;
  const currentKey = () => o.currentKey() ?? c.failedKeyForBot(bot!.id);
  let key = currentKey(); let rebound = false;
  if (key && c.holdState(key)?.closeFailed && method === 'GET') {
    if (await c.recoverClosed(key)) { key = (await o.bind()).key; rebound = true; }
  }
  // A held registered key keeps status and Hand back reachable even if Chrome
  // has a new endpoint. Restored close failures need no ordinary registration.
  const state = key ? c.holdState(key) : null;
  if (!rebound && (!key || !(state?.closeFailed || (state?.held && state.registered) || state?.closing || state?.forgetting))) key = (await o.bind()).key;
  if (!key) throw new Error(browserCopy("browser.server.browser-owner-session.9"));
  const sessionKey = key;
  const revision = () => o.bot()?.selectionRevision ?? 0;
  const decorate = (status: BrowserStatus) => ({ ...status, ...(status.closeFailed ? { problem: browserOwnerFailure('browser_close_failed', bot!.name).message } : status.closing ? { problem: browserOwnerFailure('browser_closing', bot!.name).message } : {}), owned: status.owner === o.owner, canReclaim: o.canReclaim, selectionRevision: revision(), sessionKey });
  const checkRevision = () => {
    valid();
    if (body.expectedRevision !== revision() || body.expectedKey !== sessionKey || currentKey() !== sessionKey) throw browserOwnerFailure('revision_changed', bot!.name);
  };
  try {
    if (method === 'GET') {
      if (frameGeneration !== undefined) return c.frame(sessionKey, frameGeneration) as never;
      const result = await c.refresh(sessionKey); valid(); return decorate(result);
    }
    if (body.action === 'input') {
      checkRevision();
      if (!body.event || typeof body.event !== 'object' || Array.isArray(body.event) || !Number.isSafeInteger(body.generation)) throw Object.assign(new Error(browserCopy("browser.server.browser-owner-session.10")), { status: 400 });
      await c.input(sessionKey, o.owner, body.generation as number, body.event as Record<string, unknown>);
      valid(); return decorate(c.status(sessionKey));
    }
    const plan: Trailing = await o.lifecycle.run(bot!.id, () => c.sessionGate.run([sessionKey], token => {
      checkRevision();
      const generation = body.generation as number;
      const control = Number.isSafeInteger(body.control) ? body.control as number : undefined;
      if (!['take', 'restart', 'retry'].includes(String(body.action)) && !(body.action === 'release' && control !== undefined) && !Number.isSafeInteger(generation)) throw Object.assign(new Error(browserCopy("browser.server.browser-owner-session.11")), { status: 400 });
      switch (body.action) {
        case 'take': return c.takeLocked(token, sessionKey, o.owner);
        case 'reclaim':
          if (!o.canReclaim) throw Object.assign(new Error(browserCopy("browser.server.browser-owner-session.12")), { status: 403 });
          return c.reclaimLocked(token, sessionKey, o.owner);
        case 'release': return c.releaseLocked(token, sessionKey, o.owner, generation, control);
        case 'restart': return c.restartLocked(token, sessionKey, o.owner);
        case 'reopen': return c.reopenLocked(token, sessionKey, o.owner, generation);
        case 'retry': return c.retryLocked(token, sessionKey);
        case 'navigate':
          if (typeof body.url !== 'string') throw new Error(browserCopy("browser.server.browser-owner-session.13"));
          return c.navigateLocked(token, sessionKey, o.owner, generation, body.url);
        default: throw Object.assign(new Error(browserCopy("browser.server.browser-owner-session.14")), { status: 400 });
      }
    }));
    // Enqueue before refresh; a deleted key or failed refresh cannot skip it.
    if (body.action === 'release') o.afterHoldEnded(sessionKey);
    const result = await plan.run();
    // Hand back already succeeded under both gates. Its hook may have
    // committed the queued selection while refresh ran; that cannot turn the
    // captured success into a spurious authentication failure.
    if (body.action === 'release') return { ...decorate(result), selectionRevision: body.expectedRevision as number };
    valid(); return decorate(result);
  } catch (error) {
    const e = error as { code?: string; status?: number };
    if (e.code && ['browser_closing', 'browser_close_failed', 'revision_changed'].includes(e.code)) throw browserOwnerFailure(e.code, bot!.name, e.status);
    throw error;
  }
}
