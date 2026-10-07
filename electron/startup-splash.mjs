// SPDX-License-Identifier: AGPL-3.0-or-later
// First-paint splash. The real window loads the app from the local server, so
// it cannot exist before the server's port is known. Until then this tiny,
// inert window (no preload, no node, no app origin) says Murage is starting.
// It carries no app UI, so nothing in it can Send: the readiness gate stays
// exactly where it was (the real window is created only after /api/health).

import fs from "node:fs";
import path from "node:path";

// Said only when it is true: the first start of a new version is the slow one
// (macOS checks the new app, nothing is cached yet). A vague "still starting"
// on a timer reads as "something is wrong"; a specific reason does not.
export const FIRST_AFTER_UPDATE_NOTE = "First start after an update takes a little longer";
const LAUNCHED_VERSION_FILE = "last-started-version";

/** True when a different app version last finished starting on this machine.
 * A brand-new install (no record yet) is not an update, so it is false. Any read failure counts as "not first": the note is never shown by mistake. */
export function firstStartOfVersion({ userData, appVersion, fsImpl = fs } = {}) {
  try {
    if (typeof userData === "function") userData = userData();
    if (typeof appVersion === "function") appVersion = appVersion();
    if (typeof userData !== "string" || !path.isAbsolute(userData) || !appVersion) return false;
    const file = path.join(userData, LAUNCHED_VERSION_FILE);
    if (!fsImpl.existsSync(file)) return false;
    return fsImpl.readFileSync(file, "utf8").trim() !== String(appVersion);
  } catch { return false; }
}
/** Record that this version started (called once the real window is up). */
export function noteVersionStarted({ userData, appVersion, fsImpl = fs } = {}) {
  try {
    if (typeof userData === "function") userData = userData();
    if (typeof appVersion === "function") appVersion = appVersion();
    if (typeof userData !== "string" || !path.isAbsolute(userData) || !appVersion) return;
    fsImpl.writeFileSync(path.join(userData, LAUNCHED_VERSION_FILE), `${appVersion}\n`, { mode: 0o600 });
  } catch { /* cosmetic */ }
}

// Real server stages (sent by the server as { type: "startup-stage" }) and the
// bar position each one earns, roughly by measured time. The line says what
// comes next. A stage can only move the bar forward, never back.
export const STARTUP_STAGES = Object.freeze({
  "module.loaded": { pct: 30, line: "Opening your conversations" },
  "database.open": { pct: 45, line: "Loading your memory" },
  "store.ready": { pct: 50, line: "Checking your skills" },
  "skillSweep.done": { pct: 85, line: "Almost ready" },
  listen: { pct: 95, line: "Almost ready" },
  ready: { pct: 100, line: "Almost ready" },
});
const FIRST_LINE = "Starting Murage";

// The Murage mark (brand/mark.svg, lucide galaxy, ISC), inlined so the page
// loads nothing. Strokes follow the colour scheme through currentColor.
const MARK = `<svg class="m" width="64" height="64" viewBox="0 0 24 24" role="img" aria-label="Murage" ` +
  `fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">` +
  `<path d="M16.005 15.108a5.041 6.52 28.25 00-8.008-6.217 5.041 6.52 28.25 008.008 6.217A11.884 7.288-60.76 014.029 7.001"/>` +
  `<path d="M17 21h.01"/><path d="M7 3h.01"/><path d="M7.997 8.891a11.885 7.288-60.756 0111.977 8.107"/>` +
  `<circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/></svg>`;

export function splashPage({ dark = false, pct = 0, line = FIRST_LINE, note = "" } = {}) {
  const width = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  const bg = dark ? "#16171a" : "#f7f7f8";
  const fg = dark ? "#e8e8ea" : "#1b1b1f";
  const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const html = `<!doctype html><meta charset="utf-8"><title>Murage</title>` +
    `<style>html,body{margin:0;height:100%;background:${bg};color:${fg};` +
    `font:15px -apple-system,Segoe UI,sans-serif;display:flex;flex-direction:column;align-items:center;` +
    `justify-content:center;gap:18px;-webkit-app-region:drag;user-select:none}` +
    `.m{color:#e8541a}@media (prefers-color-scheme:dark){.m{color:#ff6b35}}` +
    `.r{display:flex;align-items:center}` +
    `.bar{width:200px;height:4px;border-radius:2px;background:${fg}26;overflow:hidden}` +
    `.bar b{display:block;height:100%;width:${width}%;background:#ff6b35}` +
    `i{display:inline-block;width:8px;height:8px;border-radius:50%;background:${fg};` +
    `margin-right:10px;opacity:.4;animation:p 1s ease-in-out infinite}` +
    `@keyframes p{50%{opacity:1}}` +
    `.n{font-size:12px;opacity:.55;margin-top:-10px}</style>` +
    `<body>${MARK}<div class="bar"><b></b></div><div class="r"><i></i><span>${esc(line)}</span></div>` +
    (note ? `<div class="n">${esc(note)}</div>` : "") + `</body>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

export function createStartupSplash({ BrowserWindow, dark = false, icon, note = "" } = {}) {
  let win = null;
  let pct = 0;
  try {
    win = new BrowserWindow({
      width: 360,
      height: 200,
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      center: true,
      show: true,
      skipTaskbar: true,
      backgroundColor: dark ? "#16171a" : "#f7f7f8",
      ...(icon ? { icon } : {}),
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    void Promise.resolve(win.loadURL(splashPage({ dark, note }))).catch(() => {});
  } catch {
    win = null; // a splash is cosmetic: never let it break startup
  }
  return {
    /** Move the bar to a real stage. Unknown stages and stages that do not
     * move it forward are ignored. Reloads the inert data: page, same colours. */
    stage(name) {
      const entry = Object.hasOwn(STARTUP_STAGES, name) ? STARTUP_STAGES[name] : null;
      if (!win || !entry || entry.pct <= pct) return false;
      pct = entry.pct;
      try {
        void Promise.resolve(win.loadURL(splashPage({ dark, pct, line: entry.line, note }))).catch(() => {});
      } catch { /* cosmetic */ }
      return true;
    },
    close() {
      const w = win;
      win = null;
      try { if (w && !w.isDestroyed()) w.destroy(); } catch { /* already gone */ }
    },
    get open() { return Boolean(win); },
  };
}
