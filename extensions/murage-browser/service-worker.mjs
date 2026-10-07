// SPDX-License-Identifier: AGPL-3.0-or-later
import { createBrowserExtensionRuntime } from './runtime.mjs';
const api = globalThis.chrome;
let port, attempts = 0, nextRetryAt = 0, retryTimer, connecting = false, reconnectBlocked = false;
let disconnecting = Promise.resolve(), savingRetry = Promise.resolve();
const runtime = createBrowserExtensionRuntime(api, { emit: message => {
  const current = port;
  try { current?.postMessage(message); } catch { void disconnect(current); }
} });
const RETRY_KEY = 'murageBrowserReconnect';
const RECONNECT_ALARM = 'murage-reconnect';
const UPDATE_ALARM = 'murage-update';
const ready = Promise.all([runtime.initialize(), api.storage.local.get(RETRY_KEY)]).then(([, stored]) => {
  const retry = stored[RETRY_KEY];
  attempts = Number.isSafeInteger(retry?.attempts) && retry.attempts >= 0 ? Math.min(retry.attempts, 10) : 0;
  nextRetryAt = Number.isSafeInteger(retry?.nextRetryAt) && retry.nextRetryAt >= 0 ? retry.nextRetryAt : 0;
});
// Positive jitter keeps mature retries at least ten minutes apart in each profile.
const retryDelay = () => Math.ceil(Math.min(1000 * 2 ** attempts, 600000) * (1 + Math.random() * 0.2));
function persistRetry() {
  const value = { attempts, nextRetryAt };
  savingRetry = savingRetry.then(() => api.storage.local.set({ [RETRY_KEY]: value }));
  return savingRetry;
}
function stopRetry() {
  clearTimeout(retryTimer);
  void api.alarms.clear?.(RECONNECT_ALARM);
}
function retry() {
  clearTimeout(retryTimer);
  if (port || reconnectBlocked) return;
  const delay = Math.max(0, nextRetryAt - Date.now());
  // A short timer handles the first retries; the alarm survives worker suspension.
  if (delay < 30000) retryTimer = setTimeout(() => { void connect().catch(() => {}); }, delay);
  api.alarms.create(RECONNECT_ALARM, { when: Math.max(nextRetryAt, Date.now() + 30000) });
}
function disconnect(current) {
  if (port !== current) return disconnecting;
  port = undefined;
  stopRetry();
  disconnecting = (async () => {
    try {
      // Local Port.disconnect does not fire this end's onDisconnect. Fence explicitly.
      const fenced = runtime.connection(false);
      try { current?.disconnect(); } catch { /* The port may already be closed. */ }
      await fenced;
      if (nextRetryAt <= Date.now()) { nextRetryAt = Date.now() + retryDelay(); await persistRetry(); }
      if (!port) retry();
    } catch { reconnectBlocked = true; stopRetry(); } // A failed durable fence must not reconnect.
  })();
  return disconnecting;
}
async function connect(force = false) {
  await ready;
  await disconnecting;
  if (reconnectBlocked) throw Object.assign(new Error('Reconnect unavailable'), { code: 'reconnect_required' });
  if (port || connecting) return;
  if (!force && Date.now() < nextRetryAt) { retry(); return; }
  connecting = true;
  stopRetry();
  let current;
  try {
    attempts = force ? 1 : Math.min(attempts + 1, 10);
    nextRetryAt = Date.now() + retryDelay();
    // Record the next allowed attempt before opening the host, including a synchronous failure.
    try { await persistRetry(); } catch (error) { reconnectBlocked = true; throw error; }
    retry();
    current = api.runtime.connectNative('com.murage.browser');
    port = current;
    stopRetry();
    current.onMessage.addListener(async message => {
      if (port !== current) return;
      if (message?.type === 'host.error') return disconnect(current);
      // The broker is talking to us: this connection is healthy, so the next loss starts the backoff over.
      try {
        if (message?.type === 'command' && (attempts || nextRetryAt)) { attempts = 0; nextRetryAt = 0; await persistRetry(); }
        if (port !== current) return;
        const response = await runtime.handleRequest(message);
        if (port === current) {
          current.postMessage(response);
          // Exhaustion ends this connection; no command is retained or retried.
          if (response.error?.code === 'reconnect_required') await disconnect(current);
        }
      }
      catch { await disconnect(current); }
    });
    current.onDisconnect.addListener(() => disconnect(current));
    const hello = await runtime.connection(true);
    if (port === current) { current.postMessage(hello); for (const report of runtime.restartReports()) current.postMessage(report); }
  } catch (error) {
    await disconnect(current);
    if (reconnectBlocked) throw error;
  } finally { connecting = false; }
}
api.runtime.onMessage.addListener((message, sender, respond) => {
  // Only this extension's packaged side panel is an owner-control surface.
  if (sender.id !== api.runtime.id || sender.url !== api.runtime.getURL('sidepanel/index.html')) return false;
  ready.then(async () => {
    // Reconnect replaces a live connection too (a broker that refuses further requests on it needs that).
    if (message.action === 'reconnect') { if (port) await disconnect(port); await connect(true); }
    return runtime.handlePanel(message.action === 'reconnect' ? { action: 'status' } : message);
  }).then(result => respond({ result }), error => respond({ error: error.code ?? 'extension_error' }));
  return true;
});
for (const event of [api.webNavigation.onCommitted, api.webNavigation.onHistoryStateUpdated, api.webNavigation.onReferenceFragmentUpdated]) event.addListener(details => { void ready.then(() => runtime.navigation(details)); });
api.downloads.onCreated.addListener(item => { void ready.then(() => runtime.downloadCreated(item)); });
// Every download waits for this answer; it is always given (suggest with no name keeps Chrome's own choice).
api.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const answer = () => { try { suggest(); } catch { /* cancelled, or already answered */ } };
  ready.then(() => runtime.downloadDetermining(item)).then(answer, answer);
  return true;
});
api.tabs.onCreated.addListener(tab => { void ready.then(() => runtime.tabCreated(tab)); });
// The real source of a new tab (a link with target=_blank, window.open): tabs.onCreated can name the wrong opener.
api.webNavigation.onCreatedNavigationTarget.addListener(details => { void ready.then(() => runtime.navigationTarget(details)); });
api.tabs.onRemoved.addListener(tabId => { void ready.then(() => runtime.removed(tabId)); });
api.debugger.onDetach.addListener(source => { if (source.tabId !== undefined) void ready.then(() => runtime.detached(source.tabId)); });
// Runtime filters to owned active tabs and an explicit metadata-only event list.
api.debugger.onEvent.addListener((source, method, params) => { void ready.then(() => runtime.debuggerEvent(source, method, params)); });
api.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
api.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== RECONNECT_ALARM && alarm.name !== UPDATE_ALARM) return;
  if (alarm.name === RECONNECT_ALARM) void connect().catch(() => {});
  void ready.then(maybeUpdate).catch(() => {});
});
// Update checks have their own alarm, only while an update is pending.
let updatePending = false;
function busy() { try { return runtime.busy() !== false; } catch { return true; } }
// A waiting update applies at a quiet moment (no action running): bindings are fenced and released first, so the reload never cuts a
// grant off mid-air, and the restarted worker starts every binding paused.
async function maybeUpdate() {
  if (!updatePending) return;
  if (!busy()) {
    try { await runtime.pauseDriving?.(); } catch { /* the reload below ends every binding anyway */ }
    if (!busy()) {
      try { api.runtime.reload(); updatePending = false; void api.alarms.clear?.(UPDATE_ALARM); return; } catch { /* Retry while the update remains pending. */ }
    }
  }
  api.alarms.create(UPDATE_ALARM, { when: Date.now() + 30000 });
}
api.runtime.onUpdateAvailable?.addListener(() => {
  updatePending = true;
  void ready.then(() => {
    runtime.setUpdateWaiting?.(true);
    if (busy()) Promise.resolve(api.runtime.sendMessage({ type: 'update_pending', botName: runtime.drivingBotName() })).catch(() => {});
    maybeUpdate();
  }).catch(() => {});
});
api.tabs.onReplaced?.addListener((added, removed) => { void ready.then(() => runtime.replaced(added, removed)); });
api.tabs.onUpdated?.addListener((tabId, change) => { if (change?.discarded) void ready.then(() => runtime.discarded(tabId)); });
// After a sleep the host may be gone: re-probe it. A paused binding stays paused (nothing here resumes it).
let wasLocked = false;
api.idle?.onStateChanged.addListener(state => {
  if (state === 'locked') { wasLocked = true; return; }
  if (state === 'active' && wasLocked) {
    wasLocked = false;
    void ready.then(async () => { const hadPort = !!port; if (port) await disconnect(port); await connect(hadPort); }).catch(() => {});
  }
});
api.commands?.onCommand.addListener(command => { if (command === 'pause') void ready.then(() => runtime.pauseDriving()); });
void connect().catch(() => {});
