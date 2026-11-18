import * as nodeFs from 'node:fs';
import { dirname } from 'node:path';

const MAX_OS_ATTEMPTS = 3;

export function updateNotificationsEnabled({ packaged, mas = false, windowsStore = false }) {
  return Boolean(packaged && !mas && !windowsStore);
}

/** Process-owned receipts: disk failures never disable the optional OS surface. */
export function createUpdateNotifications({ Notification, authorization, recordPath, getWindow, getState,
  requestNotice, check, refreshState = () => {}, ensureWindow = () => {}, now = Date.now, enabled = true, fs = nodeFs }) {
  let records = { notified: [], dismissed: [], permissionRequested: false };
  let permissionAttempted = false;
  let dirty = false, unreadable = false, pending = false, lastWake = -Infinity, reportVersion = null, lastReport = null;
  const active = new Map(), receiptOwners = new Map(), attempts = new Map(), takeBacks = new Set();
  readRecords();
  function readRecords() {
    let text;
    try { text = fs.readFileSync(recordPath, 'utf8'); }
    catch (error) {
      unreadable = error.code !== 'ENOENT';
      if (unreadable) dirty = true;
      return !unreadable;
    }
    unreadable = false;
    try {
      const value = JSON.parse(text);
      if (!value || !Array.isArray(value.notified) || !Array.isArray(value.dismissed) ||
          ![...value.notified, ...value.dismissed].every(v => typeof v === 'string') ||
          typeof value.permissionRequested !== 'boolean') throw Error('Invalid receipts');
      records.dismissed = [...new Set([...records.dismissed, ...value.dismissed])];
      records.notified = [...new Set([...records.notified, ...value.notified.filter(v => !takeBacks.has(v))])];
      records.permissionRequested ||= value.permissionRequested;
    } catch { dirty = true; }
    return true;
  }
  function flushDirectory() {
    let directory;
    try {
      directory = fs.openSync(dirname(recordPath), 'r');
      fs.fsyncSync(directory);
    } catch { /* Rename landed. Even EIO/EACCES cannot undo success. */ }
    finally {
      try { if (directory !== undefined) fs.closeSync(directory); } catch { /* Same durability limit. */ }
    }
  }
  function save() {
    dirty = true;
    if (unreadable && !readRecords()) return false;
    try {
      const fd = fs.openSync(`${recordPath}.tmp`, 'w', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(records));
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.renameSync(`${recordPath}.tmp`, recordPath);
    } catch { return false; }
    flushDirectory();
    dirty = false;
    return true;
  }
  function clearActive(attempt) {
    if (active.get(attempt.version) === attempt) active.delete(attempt.version);
  }
  function rollback(attempt) {
    if (attempt.failed) return;
    attempt.failed = true;
    clearActive(attempt);
    if (attempt.added && receiptOwners.get(attempt.version) === attempt) {
      // Only a receipt this attempt wrote is taken back. One from an earlier launch still stands.
      takeBacks.add(attempt.version);
      receiptOwners.delete(attempt.version);
      records.notified = records.notified.filter(v => v !== attempt.version);
      save();
    }
  }
  function show(version) {
    const attempt = { version, failed: false, added: false, notice: null };
    attempts.set(version, (attempts.get(version) ?? 0) + 1);
    try {
      const notice = new Notification({ title: lastReport.title, silent: true });
      attempt.notice = notice;
      active.set(version, attempt);
      notice.on('failed', () => rollback(attempt));
      notice.on('close', () => clearActive(attempt));
      notice.on('click', () => {
        if (ready() !== version) return;
        ensureWindow();
        const win = getWindow();
        if (!win || win.isDestroyed()) return;
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        focus();
      });
      notice.show();
      if (attempt.failed) return;
      attempt.added = true;
      receiptOwners.set(version, attempt);
      records.notified.push(version);
      save();
    } catch { rollback(attempt); }
  }
  function ready() {
    const state = getState();
    return enabled && state.status === 'downloaded' && typeof state.version === 'string' &&
      state.version !== state.currentVersion && !records.dismissed.includes(state.version) ? state.version : null;
  }
  function background() {
    const win = getWindow();
    return !win || win.isDestroyed() || !win.isVisible() || win.isMinimized() || !win.isFocused();
  }
  function focus() {
    const version = ready();
    if (version) requestNotice(version);
  }
  async function report(value) {
    const state = getState();
    if (!enabled || !value || value.version !== state.version || typeof value.version !== 'string' ||
        (value.dismissed !== true && (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 300))) return;
    if (dirty) save();
    reportVersion = value.version;
    lastReport = value;
    if (value.dismissed === true) {
      if (!records.dismissed.includes(value.version)) { records.dismissed.push(value.version); save(); }
      try { active.get(value.version)?.notice.close(); } catch { /* cosmetic */ }
      active.delete(value.version);
      return;
    }
    const version = ready();
    if (!version || (attempts.get(version) ?? 0) >= MAX_OS_ATTEMPTS || pending || records.notified.includes(version) || !background() ||
        typeof value.title !== 'string' || !value.title.trim() || value.title.length > 300) return;
    pending = true;
    try {
      if (!Notification.isSupported()) return;
      const eligible = () => ready() === version && reportVersion === version &&
        !records.notified.includes(version) && background() &&
        typeof lastReport?.title === 'string' && lastReport.title.trim() && lastReport.title.length <= 300;
      let permission = await authorization.current();
      // The owner may have returned, dismissed, or started installing while the OS answered.
      if (!eligible()) return;
      if (permission.status === 'not-determined' && !records.permissionRequested && !permissionAttempted) {
        // A timeout does not cancel the native consent request. Retry only next launch.
        permissionAttempted = true;
        permission = await authorization.ensure();
        if (['authorized', 'denied', 'not-required'].includes(permission.status)) {
          records.permissionRequested = true;
          save();
        }
      }
      if (!permission.authorized || !eligible()) return;
      show(version);
    } catch { /* OS support and permission failures never replace the in-app notice. */ }
    finally {
      pending = false;
      // Only a different version gets a follow-up; a failed attempt never retries itself.
      if (lastReport && !lastReport.dismissed && lastReport.version !== version) void report(lastReport);
    }
  }
  function resume() {
    if (!enabled) return;
    refreshState();
    focus();
    if (now() - lastWake < 5 * 60 * 1000) return;
    lastWake = now();
    try { void Promise.resolve(check()).catch(() => {}); } catch { /* silent check */ }
  }
  return { report, focus, resume, stateChanged: () => lastReport ? report(lastReport) : Promise.resolve() };
}
