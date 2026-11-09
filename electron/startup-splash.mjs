// SPDX-License-Identifier: AGPL-3.0-or-later
// First-paint splash. The real window loads the app from the local server, so
// it cannot exist before the server's port is known. Until then this tiny,
// inert window (no preload, no node, no app origin) says Murage is starting.
// It carries no app UI, so nothing in it can Send: the readiness gate stays
// exactly where it was (the real window is created only after /api/health).
//
// 1.0.19 (FIRSTRUN-1019 slice A): the splash waits a short grace before it
// appears (a fast start shows nothing of ours), holds a short minimum once it
// has, fades once from the Chief at rest to the Chief looking up on a slow
// daily start, and hands off to the main window when that is ready.

import fs from "node:fs";
import path from "node:path";
import { formatDone, formatElapsed, formatTotal, tweenStep } from "../shared/upgrade-wait.mjs";
import { lockupSvg } from "../shared/murage-lockup.mjs";
import { memoryUpgradeLocale } from "./memory-upgrade-status.mjs";

// Said only when it is true: the first start of a new version is the slow one
// (macOS checks the new app, nothing is cached yet). A vague "still starting"
// on a timer reads as "something is wrong"; a specific reason does not.
export const FIRST_AFTER_UPDATE_NOTE = "First start after an update takes a little longer";
const LAUNCHED_VERSION_FILE = "last-started-version";

// Timing (FIRSTRUN-1019 section 0). All times are milliseconds since launch.
/** The splash is not drawn before this: a window that is ready inside it just opens. */
export const SPLASH_GRACE_MS = 600;
/** Once drawn, the splash stays at least this long before the main window replaces it. */
export const SPLASH_MIN_DWELL_MS = 1200;
/** The one cross-fade on a daily start that is still loading. */
export const SPLASH_FADE_AT_MS = 1600;
export const SPLASH_FADE_MS = 800;
export const SPLASH_SIZE = Object.freeze({ width: 480, height: 270 });
export const UPGRADE_SIZE = Object.freeze({ width: 480, height: 470 });
/** The splash screens: a daily start (one tip), the first start after an update, and a brand-new install. */
export const SPLASH_MODES = Object.freeze(["tip", "update", "first"]);

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

/** Which splash this start shows: "update" on the first start of a new version, "first" on a true first start (no record of any
 * version and no saved picture), otherwise "tip". Any read failure counts as a daily start. */
export function splashMode({ userData, appVersion, picture = null, fsImpl = fs } = {}) {
  if (firstStartOfVersion({ userData, appVersion, fsImpl })) return "update";
  try {
    const dir = typeof userData === "function" ? userData() : userData;
    if (typeof dir === "string" && path.isAbsolute(dir) && !picture && !fsImpl.existsSync(path.join(dir, LAUNCHED_VERSION_FILE))) return "first";
  } catch { /* a daily start */ }
  return "tip";
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
/** The first lines of the window, the note about a first start after an update, and the four stage lines (in the order of LINE_ORDER).
 * `tip` and `tryIt` label a tip, `updating` and `whatsNew` are the update screen's heading and button, and `defaultTip` is the one tip shown
 * before a picture has been saved (it names nobody, so it needs no names). `{key}` is the search shortcut for this computer. */
export const STARTUP_TEXT = Object.freeze({
  en: { first: FIRST_LINE, note: FIRST_AFTER_UPDATE_NOTE, lines: LINE_ORDER, tip: "TIP", tryIt: "Try it:", updating: "Finishing the update", whatsNew: "What's new",
    defaultTip: { head: "Find anything in a second", line: "Every chat, note and file your team has touched is one search away.", try: "Press {key} and type a name" } },
  de: { first: "Murage wird gestartet", note: "Der erste Start nach einem Update dauert etwas länger", lines: ["Deine Unterhaltungen werden geöffnet", "Dein Gedächtnis wird geladen", "Deine Skills werden angesehen", "Gleich fertig"], tip: "TIPP", tryIt: "Probier es:", updating: "Das Update wird abgeschlossen", whatsNew: "Was ist neu",
    defaultTip: { head: "Alles in einer Sekunde finden", line: "Jeder Chat, jede Notiz und jede Datei deines Teams ist nur eine Suche entfernt.", try: "Drücke {key} und tippe einen Namen" } },
  es: { first: "Iniciando Murage", note: "El primer inicio tras una actualización tarda un poco más", lines: ["Abriendo tus conversaciones", "Cargando tu memoria", "Revisando tus habilidades", "Casi listo"], tip: "CONSEJO", tryIt: "Pruébalo:", updating: "Terminando la actualización", whatsNew: "Novedades",
    defaultTip: { head: "Encuentra cualquier cosa en un segundo", line: "Cada chat, nota y archivo que tu equipo ha tocado está a una búsqueda de distancia.", try: "Pulsa {key} y escribe un nombre" } },
  fr: { first: "Démarrage de Murage", note: "Le premier démarrage après une mise à jour prend un peu plus de temps", lines: ["Ouverture de tes conversations", "Chargement de ta mémoire", "Examen de tes compétences", "Presque prêt"], tip: "ASTUCE", tryIt: "Essaie :", updating: "Fin de la mise à jour", whatsNew: "Nouveautés",
    defaultTip: { head: "Trouve n'importe quoi en une seconde", line: "Chaque conversation, note et fichier touché par ton équipe est à une recherche.", try: "Appuie sur {key} et tape un nom" } },
  hi: { first: "Murage शुरू हो रहा है", note: "अपडेट के बाद पहली बार शुरू होने में थोड़ा ज़्यादा समय लगता है", lines: ["आपकी बातचीत खुल रही है", "आपकी मेमोरी लोड हो रही है", "आपके स्किल देखे जा रहे हैं", "लगभग तैयार"], tip: "टिप", tryIt: "आज़माएँ:", updating: "अपडेट पूरा हो रहा है", whatsNew: "नया क्या है",
    defaultTip: { head: "कुछ भी एक सेकंड में खोजें", line: "आपकी टीम की हर चैट, नोट और फ़ाइल बस एक खोज दूर है।", try: "{key} दबाएँ और कोई नाम लिखें" } },
  ja: { first: "Murage を起動しています", note: "アップデート後の最初の起動は少し時間がかかります", lines: ["会話を開いています", "メモリを読み込んでいます", "スキルを確認しています", "まもなく完了"], tip: "ヒント", tryIt: "試してみる:", updating: "アップデートを仕上げています", whatsNew: "新機能",
    defaultTip: { head: "何でも1秒で見つかる", line: "チームが触れたチャット、メモ、ファイルは、検索ひとつで見つかります。", try: "{key} を押して名前を入力" } },
  pt: { first: "Iniciando o Murage", note: "A primeira inicialização após uma atualização demora um pouco mais", lines: ["Abrindo suas conversas", "Carregando sua memória", "Conferindo suas habilidades", "Quase pronto"], tip: "DICA", tryIt: "Experimente:", updating: "Concluindo a atualização", whatsNew: "Novidades",
    defaultTip: { head: "Encontre qualquer coisa em um segundo", line: "Cada conversa, nota e arquivo que sua equipe tocou está a uma busca de distância.", try: "Pressione {key} e digite um nome" } },
  zh: { first: "正在启动 Murage", note: "更新后的首次启动会稍慢一些", lines: ["正在打开你的对话", "正在加载你的记忆", "正在检查你的技能", "即将就绪"], tip: "提示", tryIt: "试试看：", updating: "正在完成更新", whatsNew: "新功能",
    defaultTip: { head: "一秒找到任何内容", line: "你的团队接触过的每个聊天、笔记和文件，一次搜索就能找到。", try: "按 {key} 并输入名称" } },
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

// One small glyph per tip, drawn here (never taken from the saved picture), keyed by the tip's id. An id with no glyph here gets a plain dot.
const TIP_GLYPHS = Object.freeze({
  search: `<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>`,
  brief: `<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>`,
  hire: `<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0M19 8v6M16 11h6"/>`,
  drop: `<path d="M12 15V3M7 8l5-5 5 5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>`,
  needs: `<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21a2 2 0 0 0 4 0"/>`,
  routines: `<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`,
  byname: `<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>`,
  voice: `<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4"/>`,
  today: `<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>`,
  levels: `<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>`,
  phone: `<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>`,
  notify: `<path d="M3 11v2a1 1 0 0 0 1 1h3l5 4V6L7 10H4a1 1 0 0 0-1 1zM16 9a4 4 0 0 1 0 6"/>`,
});
const GLYPH_DOT = `<circle cx="12" cy="12" r="3"/>`;

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
onClick("min", "minimize"); onClick("quit", "quit"); onClick("wn", "whatsnew");
const announce = (sentence, force) => {
  const now = performance.now();
  if (!force && now - ariaAt < ARIA_EVERY_MS) return;
  ariaAt = now;
  if (sentence !== ariaText) { ariaText = sentence; text("s", sentence); const box = $("pb"); if (box) box.setAttribute("aria-valuetext", sentence); }
};
const body = document.body, dataset = body && body.dataset ? body.dataset : null;
const layout = dataset && dataset.layout ? dataset.layout : "";
const strip = layout === "tip" || layout === "first";
if (strip && !reduce) setElapsed(0);
window.__set = (state) => {
  if (!state || typeof state !== "object") return;
  if (state.kind === "show") { if (strip && !reduce) setElapsed(typeof state.elapsedMs === "number" ? state.elapsedMs : 0); return; }
  if (state.kind === "fade") { if (!reduce && dataset) dataset.fade = "1"; return; }
  if (state.kind === "stage") { setBar(state.pct); activity(typeof state.pct !== "number"); text("p", state.line); return; }
  if (state.kind === "bar") { setBar(state.pct); activity(false); if (counter && counter.kind === "count") { counter = { ...counter, done: counter.total }; shown = counter.total; paintCounter(); } return; }
  if (state.kind !== "upgrade") return;
  locale = state.locale || "en";
  if (document.documentElement) document.documentElement.lang = locale;
  const changed = state.mode !== mode;
  mode = state.mode;
  document.body.dataset.mode = mode;
  document.body.dataset.layout = "upgrade";
  const upg = typeof document.querySelector === "function" ? document.querySelector(".hero.upg") : null;
  if (upg && typeof DOMParser === "function" && !upg.firstChild && upg.dataset.lockup) { try { const doc = new DOMParser().parseFromString(upg.dataset.lockup, "image/svg+xml"); if (doc.documentElement && doc.documentElement.nodeName === "svg") upg.appendChild(document.importNode(doc.documentElement, true)); } catch (e) { /* cosmetic */ } }
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

const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** A saved face (standalone SVG text) as an image data URI. It is only ever an <image> source, never markup, so nothing in it can run. */
function faceUri(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(String(svg), "utf8").toString("base64")}`;
}

/** The roster row of a daily start: the person's own teammates' real faces as images (data URIs only), up to five, then "+N". */
function teamRow(picture) {
  const team = picture && picture.team;
  if (!team || !Array.isArray(team.faces) || team.faces.length === 0) return "";
  const faces = team.faces.slice(0, 5).map((svg) => `<img src="${faceUri(svg)}" width="22" height="22" alt="">`).join("");
  const more = Number.isInteger(team.more) && team.more > 0 ? `<span class="more">+${team.more}</span>` : "";
  return `<div class="team" aria-hidden="true">${faces}${more}</div>`;
}

/** The hero block of each screen. The lockup builder is shared/murage-lockup.mjs; a saved face goes in as a data URI. */
function heroBlock({ layout, picture, words, dark, platform, version }) {
  const light = !dark;
  const faceA = picture ? faceUri(picture.faceA) : null;
  const faceB = picture ? faceUri(picture.faceB) : null;
  // a cached face that fails the lockup's checks is never fatal: the bundled Ember is drawn instead
  const lockup = (size, face) => { try { return lockupSvg({ size, light, face, ember: "static" }); } catch { return lockupSvg({ size, light, ember: "static" }); } };
  if (layout === "first") return `<div class="hero first">${lockupSvg({ size: 52, light, ember: "none" })}</div>`;
  if (layout === "update") return `<div class="hero upd">${lockup(40, faceA)}</div>`;
  const tip = picture
    ? picture.tip
    : { id: "search", ...words.defaultTip, try: words.defaultTip.try.replace("{key}", platform === "darwin" ? "Cmd+K" : "Ctrl+K") };
  const glyph = Object.hasOwn(TIP_GLYPHS, tip.id) ? TIP_GLYPHS[tip.id] : GLYPH_DOT;
  return `<div class="hero tip"><div class="stack"><div class="lka">${lockup(30, faceA)}</div><div class="lkb">${lockup(30, faceB ?? faceA)}</div></div>` + teamRow(picture) +
    `<div class="eb"><svg class="gl" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${glyph}</svg>${esc(words.tip)}</div>` +
    `<h3>${esc(tip.head)}</h3><p>${esc(tip.line)}</p><div class="try">${esc(words.tryIt)} ${esc(tip.try)}</div></div>`;
}

export function splashPage({ dark = false, pct = 0, line, note = "", language, mode, picture = null, version = "", platform = process.platform } = {}) {
  const words = STARTUP_TEXT[memoryUpgradeLocale(language)] ?? STARTUP_TEXT.en;
  line = line ?? words.first;
  const layout = SPLASH_MODES.includes(mode) ? mode : "classic";
  // a note given as `true` (or the English text) is said in the page's language; the update screen always has its one true line
  note = note || layout === "update" ? words.note : "";
  const fresh = layout !== "classic";
  const width = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  const bg = fresh ? (dark ? "#111" : "#f7f7f8") : (dark ? "#16171a" : "#f7f7f8");
  const fg = dark ? "#e8e8ea" : "#1b1b1f";
  const hero = fresh ? heroBlock({ layout, picture, words, dark, platform, version }) : "";
  // the memory upgrade reuses this window and takes the same calm look: the lockup (44 px, the Chief's face when there is a picture)
  const upgradeHero = fresh ? `<div class="hero upg" data-lockup="${esc((() => { try { return lockupSvg({ size: 44, light: !dark, face: picture ? faceUri(picture.faceA) : undefined, ember: "static" }); } catch { return lockupSvg({ size: 44, light: !dark, ember: "static" }); } })())}"></div>` : "";
  const heading = layout === "update" ? esc(words.updating) : "";
  const pill = layout === "update" ? `<button type="button" id="wn" class="pill">${esc(words.whatsNew)}</button>` : "";
  const html = `<!doctype html><html lang="${esc(pageLanguage(language))}"><meta charset="utf-8"><title>Murage</title>` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">` +
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
    `.strip{display:contents}.hero,.pill{display:none}.ver{display:none}` +
    // the new screens: one hero, then a strip (a daily or first start) or the update lines
    `body[data-layout=tip] .hero.tip,body[data-layout=first] .hero.first,body[data-layout=update] .hero.upd{display:flex}` +
    `body[data-layout=tip] .m,body[data-layout=first] .m,body[data-layout=update] .m{display:none}` +
    `.hero{flex-direction:column;align-items:center;justify-content:center;line-height:0}.hero svg{display:block}` +
    `.team{display:flex;align-items:center;justify-content:center;gap:6px;margin:-4px 0 14px}.team img{display:block;width:22px;height:22px;border-radius:50%}` +
    `.team .more{font:600 11px/22px -apple-system,Segoe UI,sans-serif;color:#8a8a92;margin-left:2px}` +
    `.hero.upd{margin-bottom:-4px}.hero.first{margin-bottom:24px}` +
    `.stack{display:grid;margin-bottom:14px}.stack>div{grid-area:1/1;line-height:0}` +
    `.lkb{opacity:0}body[data-fade] .lkb{opacity:1;transition:opacity ${SPLASH_FADE_MS}ms ease}body[data-fade] .lka{opacity:0;transition:opacity ${SPLASH_FADE_MS}ms ease}` +
    `.hero.tip .eb{display:flex;align-items:center;justify-content:center;gap:6px;font:600 10px/1 -apple-system,Segoe UI,sans-serif;letter-spacing:.14em;color:${dark ? "#6e6e76" : "#6e6e76"};margin-bottom:7px}` +
    `.hero.tip .gl{width:11px;height:11px;color:${dark ? "#ff8a5c" : "#c4501f"}}` +
    `.hero.tip h3{margin:0;font:600 16px/1.3 -apple-system,Segoe UI,sans-serif;letter-spacing:-.01em;color:${dark ? "#f2f2f3" : "#1b1b1f"}}` +
    `.hero.tip p{margin:6px 0 0;font-size:12.5px;line-height:1.45;color:${dark ? "#9a9aa2" : "#5a5a62"};max-width:360px}` +
    `.hero.tip .try{margin-top:9px;font-size:12px;line-height:1.4;color:${dark ? "#ff9c74" : "#b8481f"}}` +
    `body[data-layout=tip],body[data-layout=first]{gap:0;padding-bottom:34px}` +
    `body[data-layout=tip] .strip,body[data-layout=first] .strip{position:absolute;left:0;right:0;bottom:0;height:34px;display:flex;align-items:center;justify-content:center;gap:10px;font-size:11px;color:#6e6e76;font-variant-numeric:tabular-nums}` +
    `body[data-layout=tip] .strip .bar,body[data-layout=first] .strip .bar{width:120px;height:3px;order:2}` +
    `body[data-layout=tip] .strip .r,body[data-layout=first] .strip .r{order:1;font-size:11px}body[data-layout=tip] .strip .e,body[data-layout=first] .strip .e,body[data-layout=tip] .strip .c,body[data-layout=first] .strip .c{order:3;font-size:11px;opacity:1}` +
    `body[data-layout=tip] .strip i,body[data-layout=first] .strip i,body[data-layout=update] .strip i{display:none}` +
    `body[data-layout=update]{gap:0}body[data-layout=update] h1{order:1;margin-top:12px;font-size:17px;line-height:1.25}` +
    `body[data-layout=update] .n{order:2;display:block;margin:5px 0 0;font-size:12.5px;line-height:1.45;opacity:1;color:${dark ? "#9a9aa2" : "#5a5a62"};max-width:360px}body[data-layout=update] .n:empty{display:none}` +
    `body[data-layout=update] .bar{order:3;margin-top:14px;width:220px;height:3px}body[data-layout=update] .r{order:4;margin-top:9px;font:500 11px/1 -apple-system,Segoe UI,sans-serif;color:#6e6e76;font-variant-numeric:tabular-nums}` +
    `body[data-layout=update] .ver{display:inline;white-space:pre}body[data-layout=update] .pill{order:5;display:block}` +
    `.pill{margin-top:14px;border:0;border-radius:999px;background:${dark ? "#f2f2f3" : "#1b1b1f"};color:${dark ? "#111" : "#fff"};font:600 12px/1 -apple-system,Segoe UI,sans-serif;padding:8px 16px;cursor:pointer;-webkit-app-region:no-drag}` +
    `.pill:focus-visible{outline:2px solid #ff6b35;outline-offset:2px}` +
    `body[data-layout=upgrade] .hero:not(.upg),body[data-layout=upgrade] .pill{display:none}body[data-layout=upgrade] .m{display:block}` +
    `body[data-layout=upgrade] .hero.upg{display:flex;margin-bottom:4px}body[data-layout=upgrade] .hero.upg~.m{display:none}` +
    `body[data-layout=upgrade] #min{border:0;border-radius:999px;background:${dark ? "#f2f2f3" : "#1b1b1f"};color:${dark ? "#111" : "#fff"};font-weight:600;padding:8px 16px}` +
    `body[data-layout=upgrade] #quit{border:0;background:none;text-decoration:underline;opacity:.8;padding:4px 6px}` +
    `@media (prefers-reduced-motion:reduce){i,.bar.act::after{animation:none}.bar b{transition:none}.lkb{transition:none!important}}</style>` +
    `<body data-layout="${layout}">${hero}${upgradeHero}${MARK}<h1 id="t">${heading}</h1><div class="l" id="l"></div>` +
    `<div class="strip"><div class="bar${width ? "" : " act"}" id="pb" role="progressbar" aria-label="Murage" aria-valuemin="0" aria-valuemax="100"${width ? ` aria-valuenow="${width}"` : ""}><b id="bar"></b></div>` +
    `<div class="r"><i></i><span class="ver">Murage ${esc(version)} · </span><span id="p">${esc(line)}</span></div><div class="c" id="c" aria-hidden="true"></div><div class="e" id="e" aria-hidden="true"></div></div>` +
    `<div class="f" id="f"></div>` +
    `<div class="ctl" id="ctl"><button type="button" id="min"></button><button type="button" id="quit" aria-describedby="q"></button></div><div class="q" id="q"></div>` +
    `<div class="n" id="n">${esc(note)}</div>${pill}` + `<div class="sr" id="s" role="status" aria-live="polite"></div><script>${SPLASH_SCRIPT}</script></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

const TITLE_ACTION = /^murage-splash:(minimize|quit|whatsnew):\d+$/;

/**
 * The splash window and its clock.
 *
 * The window is created hidden and drawn only after the grace (SPLASH_GRACE_MS since launch); a start that finishes first never shows it
 * (`whenRevealable` cancels the grace). `whenRevealable(fn)` is how the main window is revealed: it calls `fn` at
 * max(ready, shownAt + dwell, fadeStart + fade), so the splash never flashes and never holds the window more than its dwell. A window
 * with no `mode` (the memory-upgrade window made when there was no splash) is drawn at once, as before.
 *
 * `timers` ({ now, setTimeout, clearTimeout }) is for tests.
 */
export function createStartupSplash({ BrowserWindow, dark = false, icon, note = "", language, onUserClose, onWhatsNew, onMark, mode, picture = null, version = "", reducedMotion = false, platform = process.platform, sinceLaunchMs = 0, grace, timers } = {}) {
  // a monotonic clock: a system clock change mid-start can neither stretch nor cut the dwell
  const clock = { now: () => performance.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (handle) => clearTimeout(handle), ...timers };
  const layout = SPLASH_MODES.includes(mode) ? mode : "classic";
  const graceMs = layout === "classic" ? 0 : Math.max(0, Number.isFinite(grace) ? grace : SPLASH_GRACE_MS);
  // `version` and `sinceLaunchMs` may be given as functions: asked once, and a failure reads as "unknown" (the splash is cosmetic)
  const asked = (value, fallback) => { try { return typeof value === "function" ? value() : value; } catch { return fallback; } };
  version = String(asked(version, "") ?? "");
  const early = Math.max(0, Math.min(10000, Number(asked(sinceLaunchMs, 0)) || 0));
  const createdAt = clock.now();
  const handles = new Set();
  const later = (fn, ms) => {
    const handle = clock.setTimeout(() => { handles.delete(handle); fn(); }, Math.max(0, ms));
    try { handle?.unref?.(); } catch { /* cosmetic */ }
    handles.add(handle);
    return handle;
  };
  const cancel = (handle) => { if (handle) { try { clock.clearTimeout(handle); } catch { /* cosmetic */ } handles.delete(handle); } };
  const mark = (name) => { try { onMark?.(name); } catch { /* cosmetic */ } };
  let win = null;
  let pct = 0;
  let shownAt = null;
  let fadeStartedAt = null;
  let graceTimer = null;
  let fadeTimer = null;
  let revealRequested = false;
  // true from the first upgrade view on: the stage messages stop writing text (the upgrade view owns it) and closing the window is a choice to quit
  let upgrading = false;
  let closing = false;
  const run = (code) => {
    try { void Promise.resolve(win?.webContents?.executeJavaScript?.(code)).catch(() => {}); } catch { /* cosmetic */ }
  };
  const call = (state) => run(`window.__set(${JSON.stringify(state)})`);
  /** Draw the window now (once). */
  const showNow = () => {
    if (!win || shownAt !== null) return;
    cancel(graceTimer); graceTimer = null;
    shownAt = clock.now();
    try { win.show?.(); } catch { /* cosmetic */ }
    call({ kind: "show", elapsedMs: early + (shownAt - createdAt) });
    mark("splash.shown");
  };
  /** The one cross-fade, only on a daily start that is still loading. */
  const startFade = () => {
    fadeTimer = null;
    if (!win || closing || revealRequested || upgrading || fadeStartedAt !== null || shownAt === null || layout !== "tip" || reducedMotion) return;
    fadeStartedAt = clock.now();
    call({ kind: "fade", ms: SPLASH_FADE_MS });
    mark("splash.fade");
  };
  try {
    win = new BrowserWindow({
      width: SPLASH_SIZE.width,
      height: SPLASH_SIZE.height,
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      center: true,
      show: graceMs <= 0,
      skipTaskbar: true,
      backgroundColor: layout === "classic" ? (dark ? "#16171a" : "#f7f7f8") : (dark ? "#111111" : "#f7f7f8"),
      ...(icon ? { icon } : {}),
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    // The person's way out while the upgrade is the only thing on screen (Windows and Linux have no menu here): closing quits, which stops the
    // child. The next start picks up from the last whole step.
    // The controls on the page (it has no frame) tell the shell through the page title, since the page has no preload: minimize, quit (the
    // same as closing, which the page explains beside the button), or What's new on the update screen. Three explicit cases and nothing else:
    // what's new can never fall into the quit branch, and any other title is ignored.
    win.webContents.on("page-title-updated", (event, title) => {
      const action = TITLE_ACTION.exec(String(title))?.[1];
      if (!action) return;
      try { event?.preventDefault?.(); } catch { /* cosmetic */ }
      switch (action) {
        case "minimize": try { win?.minimize?.(); } catch { /* cosmetic */ } break;
        case "quit": if (upgrading) { try { onUserClose?.(); } catch { /* cosmetic */ } } break;
        case "whatsnew": try { onWhatsNew?.(); } catch { /* cosmetic */ } break;
        default: break;
      }
    });
    win.on?.("close", () => { if (upgrading && !closing) { try { onUserClose?.(); } catch { /* cosmetic */ } } });
    void Promise.resolve(win.loadURL(splashPage({ dark, note: layout === "update" ? true : layout === "classic" ? note : "", language, mode: layout === "classic" ? undefined : layout, picture, version, platform }))).catch(() => {});
    if (graceMs <= 0) { shownAt = createdAt; } else {
      graceTimer = later(showNow, graceMs - early);
    }
    if (layout === "tip" && !reducedMotion) fadeTimer = later(startFade, SPLASH_FADE_AT_MS - early);
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
     * the upgrade needs Murage to stay open, minimizable and listed in the taskbar. An upgrade is never held back by the grace and never fades. */
    set(view) {
      if (!win || !view || typeof view !== "object") return false;
      if (!upgrading) {
        upgrading = true;
        cancel(fadeTimer); fadeTimer = null;
        showNow();
        try { win.setSize?.(UPGRADE_SIZE.width, UPGRADE_SIZE.height); win.center?.(); } catch { /* cosmetic */ }
      }
      try { win.setMinimizable?.(view.keepOpen !== false); win.setSkipTaskbar?.(view.keepOpen === false); } catch { /* cosmetic */ }
      call({ ...view, kind: "upgrade" });
      return true;
    },
    /**
     * Run `fn` (the main window's reveal) when the splash allows it: at once when the splash was never drawn (the window was ready inside the
     * grace, so nothing of ours appears), or at max(now, shownAt + minimum dwell, fadeStart + fade). The wait is never more than the dwell
     * (1.2 s) and fires once per call; closing the splash first drops it (the caller's own checks cover a window closed or swapped meanwhile).
     * Returns the milliseconds waited.
     */
    whenRevealable(fn) {
      if (typeof fn !== "function") return 0;
      revealRequested = true;
      cancel(fadeTimer); fadeTimer = null;
      const now = clock.now();
      let at = now;
      if (win && !closing && !upgrading && shownAt !== null) {
        at = Math.max(at, shownAt + SPLASH_MIN_DWELL_MS);
        if (fadeStartedAt !== null) at = Math.max(at, fadeStartedAt + SPLASH_FADE_MS);
      } else { cancel(graceTimer); graceTimer = null; }
      const wait = at - now;
      if (wait <= 0) { fn(); return 0; }
      later(fn, wait);
      return wait;
    },
    close() {
      const w = win;
      win = null;
      closing = true;
      for (const handle of [...handles]) cancel(handle);
      graceTimer = fadeTimer = null;
      try { if (w && !w.isDestroyed()) w.destroy(); } catch { /* already gone */ }
    },
    get win() { return win; },
    get open() { return Boolean(win); },
    get upgrading() { return upgrading; },
    /** True once the window has been drawn (the grace has passed or an upgrade needed it). */
    get visible() { return shownAt !== null && Boolean(win); },
    get faded() { return fadeStartedAt !== null; },
  };
}
