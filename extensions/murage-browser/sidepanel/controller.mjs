// SPDX-License-Identifier: AGPL-3.0-or-later
// Side panel controller (PNL stage 1). Holds the status the panel shows and decides what to draw; panel.js only wires it to
// chrome.*. Status arrives by push (PANEL-CONTRACT.md); polling is the fallback for a runtime that does not push yet.
export const CONTRACT_VERSION = 1;
export const PUSH_TYPE = 'murage.panel.status';
export const FAILURES_BEFORE_OFFLINE = 3;
export const POLL_MS = 2000;
export const PUSH_QUIET_MS = 30000;
export const URGENT = ['stop', 'pause'];
const BASE_ACTIONS = ['stop', 'pause', 'resume', 'share', 'unshare', 'reconnect'];
const ERRORS = { host_offline: 'spErrHostOffline', site_denied: 'spErrSiteDenied', human_handover: 'spErrHumanHandover', binding_inactive: 'spErrBindingInactive', tab_owned: 'spErrTabOwned', unknown_binding: 'spErrUnknownBinding', binding_stopped: 'spErrBindingStopped',
  handoff_use_continue: 'spErrHandoffUseContinue', not_handoff: 'spErrNotHandoff', incognito_denied: 'spErrIncognitoDenied', persistence_failed: 'spErrPersistenceFailed', update_required: 'spErrUpdateRequired', storage_unavailable: 'spErrStorageUnavailable' };
// What the runtime reports when it is running but cannot keep state (status.recovery.code), and the sentence for each.
const RECOVERY = { update_required: 'spErrUpdateRequired', storage_unavailable: 'spErrStorageUnavailable', reshare_required: 'spRecoveryReshare', persistence_failed: 'spErrPersistenceFailed' };
const OFFLINE = Object.freeze({ connected: false, bindings: [], profileId: '' });

// The bot the panel shows: the owner's explicit pick, else the bot that owns the current tab, else the first running bot.
export function pickBinding(bindings, tabId, manual) {
  if (manual && bindings.some(b => b.bindingId === manual && b.state !== 'stopped')) return manual;
  const owner = tabId === undefined ? undefined : bindings.find(b => b.state !== 'stopped' && b.tabs?.some(t => t.tabId === tabId));
  return (owner ?? bindings.find(b => b.state !== 'stopped') ?? bindings[0])?.bindingId;
}

export function createController({ send, extensionId, now = Date.now, onChange }) {
  let pushes = 0, running = [], status = OFFLINE, tabId, manual, feedback = '', shortcut = '', failures = 0, lastPush = -Infinity, versionAhead = false;
  const bindings = () => status.bindings ?? [];
  const selected = () => pickBinding(bindings(), tabId, manual);
  const changed = () => onChange?.(view());
  function view() {
    const sel = selected(), b = bindings().find(x => x.bindingId === sel);
    const recovery = RECOVERY[status.recovery?.code] ?? (status.persistenceFailed ? RECOVERY.persistence_failed : '');
    return { ...status, contractAhead: versionAhead, selected: sel, feedback, pending: running[0] ?? '', recovery, shortcut, supports: [...new Set([...BASE_ACTIONS, ...(b?.panelActions ?? [])])] };
  }
  function apply(next) {
    if (!next || typeof next !== 'object') throw Error('spErrGeneric');
    failures = 0; feedback = '';
    versionAhead = Number(next.version) > CONTRACT_VERSION;
    status = { connected: Boolean(next.connected), bindings: Array.isArray(next.bindings) ? next.bindings : [], profileId: String(next.profileId ?? ''), version: next.version,
      ...(next.recovery && typeof next.recovery === 'object' ? { recovery: { code: String(next.recovery.code ?? '') } } : {}), persistenceFailed: next.persistenceFailed === true };
    changed();
  }
  async function request(action, extra = {}) {
    const response = await send({ action, bindingId: selected(), ...extra });
    if (response?.error) throw Error(ERRORS[response.error] ?? 'spErrGeneric');
    return response?.result;
  }
  return {
    view,
    selected,
    async refresh() {
      const seen = pushes;
      try { const next = await request('status'); if (pushes === seen) apply(next); else failures = 0; }
      catch { failures++; if (failures >= FAILURES_BEFORE_OFFLINE) { status = OFFLINE; changed(); } }
    },
    // A pushed status. Only this extension's own runtime may send one.
    push(message, sender) {
      if (!message || message.type !== PUSH_TYPE || sender?.id !== extensionId || !message.status || typeof message.status !== 'object') return false;
      pushes++; lastPush = now(); apply(message.status); return true;
    },
    // Called on a timer: polls only while pushes are not arriving.
    async tick() { if (now() - lastPush >= PUSH_QUIET_MS) await this.refresh(); },
    // One owner action at a time, except that Stop and Pause always go through: a slow action must never leave the owner unable to stop the bot.
    async act(action, extra) {
      if (running.length && !URGENT.includes(action)) return;
      feedback = ''; running.push(action); changed();
      try { await request(action, extra); running.splice(running.indexOf(action), 1); await this.refresh(); }
      catch (error) { running.splice(running.indexOf(action), 1); feedback = String(error.message).startsWith('spErr') ? error.message : 'spErrGeneric'; changed(); }
    },
    select(id) { manual = id; changed(); },
    setTab(id) { if (id !== tabId) { tabId = id; manual = undefined; changed(); } },
    setShortcut(s) { shortcut = s ?? ''; changed(); },
    get failures() { return failures; },
  };
}
