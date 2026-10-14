// SPDX-License-Identifier: AGPL-3.0-or-later
// First-paint splash. The real window loads the app from the local server, so
// it cannot exist before the server's port is known. Until then this tiny,
// inert window (no preload, no node, no app origin) says Murage is starting.
// It carries no app UI, so nothing in it can Send: the readiness gate stays
// exactly where it was (the real window is created only after /api/health).

import fs from "node:fs";
import path from "node:path";
import { formatDone, formatElapsed, formatTotal, tweenStep } from "../shared/upgrade-wait.mjs";
import { memoryUpgradeLocale } from "./memory-upgrade-status.mjs";

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
// comes next. A stage can only move the bar forward, never back. The words are
// in the eight shipped languages (STARTUP_TEXT); an unknown system language gets English.
export const STARTUP_STAGES = Object.freeze({
  "module.loaded": { pct: 30, line: "Opening your conversations" },
  "database.open": { pct: 45, line: "Loading your memory" },
  "store.ready": { pct: 50, line: "Checking your skills" },
  "skillSweep.done": { pct: 85, line: "Almost ready" },
  listen: { pct: 95, line: "Almost ready" },
  ready: { pct: 100, line: "Almost ready" },
});
const FIRST_LINE = "Starting Murage";
const LINE_ORDER = ["Opening your conversations", "Loading your memory", "Checking your skills", "Almost ready"];
/** The first lines of the window, the note about a first start after an update, and the four stage lines (in the order of LINE_ORDER). */
export const STARTUP_TEXT = Object.freeze({
  en: { first: FIRST_LINE, note: FIRST_AFTER_UPDATE_NOTE, lines: LINE_ORDER },
  de: { first: "Murage wird gestartet", note: "Der erste Start nach einem Update dauert etwas länger", lines: ["Deine Unterhaltungen werden geöffnet", "Dein Gedächtnis wird geladen", "Deine Skills werden angesehen", "Gleich fertig"] },
  es: { first: "Iniciando Murage", note: "El primer inicio tras una actualización tarda un poco más", lines: ["Abriendo tus conversaciones", "Cargando tu memoria", "Revisando tus habilidades", "Casi listo"] },
  fr: { first: "Démarrage de Murage", note: "Le premier démarrage après une mise à jour prend un peu plus de temps", lines: ["Ouverture de tes conversations", "Chargement de ta mémoire", "Examen de tes compétences", "Presque prêt"] },
  hi: { first: "Murage शुरू हो रहा है", note: "अपडेट के बाद पहली बार शुरू होने में थोड़ा ज़्यादा समय लगता है", lines: ["आपकी बातचीत खुल रही है", "आपकी मेमोरी लोड हो रही है", "आपके स्किल देखे जा रहे हैं", "लगभग तैयार"] },
  ja: { first: "Murage を起動しています", note: "アップデート後の最初の起動は少し時間がかかります", lines: ["会話を開いています", "メモリを読み込んでいます", "スキルを確認しています", "まもなく完了"] },
  pt: { first: "Iniciando o Murage", note: "A primeira inicialização após uma atualização demora um pouco mais", lines: ["Abrindo suas conversas", "Carregando sua memória", "Conferindo suas habilidades", "Quase pronto"] },
  zh: { first: "正在启动 Murage", note: "更新后的首次启动会稍慢一些", lines: ["正在打开你的对话", "正在加载你的记忆", "正在检查你的技能", "即将就绪"] },
});
/** The words for a stage line, in a language. */
export function startupLine(language, line) {
  const table = STARTUP_TEXT[memoryUpgradeLocale(language)] ?? STARTUP_TEXT.en;
  const at = LINE_ORDER.indexOf(line);
  return at < 0 ? table.first : table.lines[at];
}
/** The value for the page's `lang`: the system language tag when it is well formed, else the matched table's code. */
export function pageLanguage(language) {
  const tag = typeof language === "string" ? language.replace("_", "-") : "";
  return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/.test(tag) ? tag : memoryUpgradeLocale(language);
}

// The Murage mark (brand/mark.svg, lucide galaxy, ISC), inlined so the page
// loads nothing. Strokes follow the colour scheme through currentColor.
const MARK = `<svg class="m" width="64" height="64" viewBox="0 0 24 24" role="img" aria-label="Murage" ` +
  `fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">` +
  `<path d="M16.005 15.108a5.041 6.52 28.25 00-8.008-6.217 5.041 6.52 28.25 008.008 6.217A11.884 7.288-60.76 014.029 7.001"/>` +
  `<path d="M17 21h.01"/><path d="M7 3h.01"/><path d="M7.997 8.891a11.885 7.288-60.756 0111.977 8.107"/>` +
  `<circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/></svg>`;

// The page's own script. It receives every change as one object through `window.__set` (the shell calls it with executeJavaScript), so
// the window is never reloaded between stages: nothing flashes, and the counters can glide. Four helpers are embedded from
// shared/upgrade-wait.mjs (they are self-contained for exactly this). Everything on the page is text set with textContent.
export const SPLASH_SCRIPT = `(() => {
const $ = (id) => document.getElementById(id);
const reduce = Boolean(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
const formatDone = ${formatDone.toString()};
const formatTotal = ${formatTotal.toString()};
const formatElapsed = ${formatElapsed.toString()};
const tweenStep = ${tweenStep.toString()};
const GLIDE_MS = 600, ARIA_EVERY_MS = 10000;
let locale = "en", counter = null, shown = 0, from = 0, glideAt = 0, raf = 0, elapsed = null, ticker = 0, mode = "", ariaAt = 0, ariaText = "", high = 0, sent = 0;
const text = (id, value) => { const el = $(id); if (el && el.textContent !== value) el.textContent = value; };
const paintCounter = () => {
  if (!counter) { text("c", ""); return; }
  if (counter.kind === "text") { text("c", counter.text); return; }
  text("c", counter.template.replace("{done}", formatDone(shown, locale)).replace("{total}", formatTotal(counter.total, locale)));
};
const frame = (now) => {
  raf = 0;
  if (!counter || counter.kind !== "count") return;
  shown = tweenStep(from, counter.done, now - glideAt, GLIDE_MS);
  paintCounter();
  if (shown < counter.done) raf = requestAnimationFrame(frame);
};
const setCounter = (next) => {
  if (!next) { counter = null; shown = 0; paintCounter(); return; }
  if (next.kind !== "count") { counter = next; paintCounter(); return; }
  if (!counter || counter.kind !== "count") { shown = 0; from = 0; }
  counter = next; from = Math.min(shown, next.done);
  if (reduce) { shown = next.done; paintCounter(); return; }
  glideAt = performance.now();
  if (!raf) raf = requestAnimationFrame(frame);
};
const paintElapsed = () => { if (elapsed) text("e", formatElapsed(elapsed.base + (performance.now() - elapsed.at), locale)); };
const setElapsed = (ms) => {
  if (typeof ms !== "number") { elapsed = null; text("e", ""); if (ticker) { clearInterval(ticker); ticker = 0; } return; }
  elapsed = { base: ms, at: performance.now() };
  paintElapsed();
  if (!reduce && !ticker) ticker = setInterval(paintElapsed, 1000);
};
// one bar for the whole wait, and it never goes back: start-up milestones carry no percent (the bar only shows activity) until the upgrade
// reports real progress, and every figure after that can only move the single high-water mark forward
const setBar = (pct) => {
  const bar = $("bar"), box = $("pb");
  if (typeof pct === "number" && Number.isFinite(pct)) high = Math.max(high, Math.max(0, Math.min(100, pct)));
  if (bar) bar.style.width = high + "%";
  if (box) { if (high > 0) box.setAttribute("aria-valuenow", String(Math.round(high))); else if (box.removeAttribute) box.removeAttribute("aria-valuenow"); }
};
const activity = (on) => { const box = $("pb"); if (box && box.classList) box.classList.toggle("act", on); };
const send = (action) => { sent += 1; document.title = "murage-splash:" + action + ":" + sent; };
const onClick = (id, action) => { const el = $(id); if (el && el.addEventListener) el.addEventListener("click", () => send(action)); };
onClick("min", "minimize"); onClick("quit", "quit");
const announce = (sentence, force) => {
  const now = performance.now();
  if (!force && now - ariaAt < ARIA_EVERY_MS) return;
  ariaAt = now;
  if (sentence !== ariaText) { ariaText = sentence; text("s", sentence); const box = $("pb"); if (box) box.setAttribute("aria-valuetext", sentence); }
};
window.__set = (state) => {
  if (!state || typeof state !== "object") return;
  if (state.kind === "stage") { setBar(state.pct); activity(typeof state.pct !== "number"); text("p", state.line); return; }
  if (state.kind === "bar") { setBar(state.pct); activity(false); if (counter && counter.kind === "count") { counter = { ...counter, done: counter.total }; shown = counter.total; paintCounter(); } return; }
  if (state.kind !== "upgrade") return;
  locale = state.locale || "en";
  if (document.documentElement) document.documentElement.lang = locale;
  const changed = state.mode !== mode;
  mode = state.mode;
  document.body.dataset.mode = mode;
  text("n", "");
  text("t", state.title || ""); text("l", state.lead || ""); text("p", state.line || ""); text("f", state.footer || "");
  setBar(state.percent);
  activity(state.indeterminate === true || typeof state.percent !== "number");
  const ctl = state.controls || {};
  text("min", ctl.minimize || ""); text("quit", ctl.quit || ""); text("q", ctl.quitNote || "");
  setCounter(state.counter || null);
  setElapsed(state.indeterminate ? state.elapsedMs : null);
  announce(state.aria || state.line || "", changed);
};
})();`;

export function splashPage({ dark = false, pct = 0, line, note = "", language } = {}) {
  const words = STARTUP_TEXT[memoryUpgradeLocale(language)] ?? STARTUP_TEXT.en;
  line = line ?? words.first;
  // a note given as `true` (or the English text) is said in the page's language
  note = note ? words.note : "";
  const width = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  const bg = dark ? "#16171a" : "#f7f7f8";
  const fg = dark ? "#e8e8ea" : "#1b1b1f";
  const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const html = `<!doctype html><html lang="${esc(pageLanguage(language))}"><meta charset="utf-8"><title>Murage</title>` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">` +
    `<style>html,body{margin:0;height:100%;background:${bg};color:${fg};` +
    `font:15px -apple-system,Segoe UI,sans-serif;display:flex;flex-direction:column;align-items:center;` +
    `justify-content:center;gap:16px;-webkit-app-region:drag;user-select:none}` +
    `body{box-sizing:border-box;padding:0 28px;text-align:center}` +
    `.m{color:#e8541a}@media (prefers-color-scheme:dark){.m{color:#ff6b35}}` +
    `.r{display:flex;align-items:center;justify-content:center}` +
    `.bar{position:relative;width:200px;height:4px;border-radius:2px;background:${fg}26;overflow:hidden}` +
    `body[data-mode] .bar{width:min(320px,100%);height:6px;border-radius:3px}` +
    `.bar b{display:block;height:100%;width:${width}%;background:#ff6b35;transition:width .4s ease-out}` +
    `.bar.act::after{content:"";position:absolute;top:0;bottom:0;width:30%;background:linear-gradient(90deg,transparent,#ffffff55,transparent);animation:s 1.6s ease-in-out infinite}` +
    `@keyframes s{from{left:-30%}to{left:100%}}` +
    `i{display:inline-block;width:8px;height:8px;border-radius:50%;background:${fg};` +
    `margin-right:10px;opacity:.4;animation:p 1s ease-in-out infinite}` +
    `@keyframes p{50%{opacity:1}}` +
    `h1{font-size:17px;font-weight:600;margin:0}` +
    `.l,.f,.n,.c,.e{opacity:.7;line-height:1.5;max-width:380px}` +
    `.l{font-size:15px;opacity:.85}.f{font-size:13px}.c,.e{font-size:13px;font-variant-numeric:tabular-nums}` +
    `.n{font-size:12px;margin-top:-6px}.n:empty{display:none}` +
    `.q{font-size:13px;opacity:.7;line-height:1.5;max-width:380px}` +
    `.ctl{display:flex;gap:8px;-webkit-app-region:no-drag}` +
    `.ctl button{font:inherit;font-size:13px;color:inherit;background:${fg}14;border:1px solid ${fg}33;border-radius:6px;padding:4px 12px;cursor:pointer;-webkit-app-region:no-drag}` +
    `.ctl button:hover{background:${fg}26}.ctl button:focus-visible{outline:2px solid #ff6b35;outline-offset:2px}` +
    `.ctl,.q{display:none}body[data-mode] .ctl{display:flex}body[data-mode] .q{display:block}` +
    `body[data-mode=finishing] .ctl,body[data-mode=finishing] .q{display:none}.ctl button:empty,.q:empty{display:none}` +
    `h1:empty,.l:empty,.c:empty,.e:empty,.f:empty{display:none}` +
    `.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}` +
    `@media (prefers-reduced-motion:reduce){i,.bar.act::after{animation:none}.bar b{transition:none}}</style>` +
    `<body>${MARK}<h1 id="t"></h1><div class="l" id="l"></div>` +
    `<div class="bar${width ? "" : " act"}" id="pb" role="progressbar" aria-label="Murage" aria-valuemin="0" aria-valuemax="100"${width ? ` aria-valuenow="${width}"` : ""}><b id="bar"></b></div>` +
    `<div class="r"><i></i><span id="p">${esc(line)}</span></div><div class="c" id="c" aria-hidden="true"></div><div class="e" id="e" aria-hidden="true"></div>` +
    `<div class="f" id="f"></div>` +
    `<div class="ctl" id="ctl"><button type="button" id="min"></button><button type="button" id="quit" aria-describedby="q"></button></div><div class="q" id="q"></div>` +
    `<div class="n" id="n">${esc(note)}</div>` + `<div class="sr" id="s" role="status" aria-live="polite"></div><script>${SPLASH_SCRIPT}</script></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

const UPGRADE_SIZE = { width: 480, height: 470 };

export function createStartupSplash({ BrowserWindow, dark = false, icon, note = "", language, onUserClose } = {}) {
  let win = null;
  let pct = 0;
  // true from the first upgrade view on: the stage messages stop writing text (the upgrade view owns it) and closing the window is a choice to quit
  let upgrading = false;
  let closing = false;
  const run = (code) => {
    try { void Promise.resolve(win?.webContents?.executeJavaScript?.(code)).catch(() => {}); } catch { /* cosmetic */ }
  };
  const call = (state) => run(`window.__set(${JSON.stringify(state)})`);
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
    // The person's way out while the upgrade is the only thing on screen (Windows and Linux have no menu here): closing quits, which stops the
    // child. The next start picks up from the last whole step.
    // The two window controls on the page (it has no frame) tell the shell through the page title, since the page has no preload: minimize, or
    // quit (the same as closing, which the page explains beside the button).
    win.webContents.on("page-title-updated", (event, title) => {
      const action = /^murage-splash:(minimize|quit):\d+$/.exec(String(title))?.[1];
      if (!action) return;
      try { event?.preventDefault?.(); } catch { /* cosmetic */ }
      if (action === "minimize") { try { win?.minimize?.(); } catch { /* cosmetic */ } } else if (upgrading) { try { onUserClose?.(); } catch { /* cosmetic */ } }
    });
    win.on?.("close", () => { if (upgrading && !closing) { try { onUserClose?.(); } catch { /* cosmetic */ } } });
    void Promise.resolve(win.loadURL(splashPage({ dark, note, language }))).catch(() => {});
  } catch {
    win = null; // a splash is cosmetic: never let it break startup
  }
  return {
    /** Move the bar to a real stage. Unknown stages and stages that do not move it forward are ignored. The page is not reloaded.
     * While an upgrade view is up it owns the text, so only the end of start-up (ready) still moves the bar, to the end. */
    stage(name) {
      const entry = Object.hasOwn(STARTUP_STAGES, name) ? STARTUP_STAGES[name] : null;
      if (!win || !entry || entry.pct <= pct) return false;
      pct = entry.pct;
      if (upgrading) { if (name === "ready") call({ kind: "bar", pct: 100 }); return true; }
      // a milestone is not a percentage of anything the owner can count on: only the end of start-up (ready) fills the bar
      call({ kind: "stage", pct: name === "ready" ? 100 : null, line: startupLine(language, entry.line) });
      return true;
    },
    /** Show an upgrade view (electron/upgrade-screen.mjs) in this same window. The first one makes the window larger, and, while the view says
     * the upgrade needs Murage to stay open, minimizable and listed in the taskbar. */
    set(view) {
      if (!win || !view || typeof view !== "object") return false;
      if (!upgrading) {
        upgrading = true;
        try { win.setSize?.(UPGRADE_SIZE.width, UPGRADE_SIZE.height); win.center?.(); } catch { /* cosmetic */ }
      }
      try { win.setMinimizable?.(view.keepOpen !== false); win.setSkipTaskbar?.(view.keepOpen === false); } catch { /* cosmetic */ }
      call({ ...view, kind: "upgrade" });
      return true;
    },
    close() {
      const w = win;
      win = null;
      closing = true;
      try { if (w && !w.isDestroyed()) w.destroy(); } catch { /* already gone */ }
    },
    get open() { return Boolean(win); },
    get upgrading() { return upgrading; },
  };
}
