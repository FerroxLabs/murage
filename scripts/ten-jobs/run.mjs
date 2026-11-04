#!/usr/bin/env node
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The ten-jobs driver: walks the owner jobs in paths.mjs on a PACKAGED app
// (an unmodified dmg / exe / AppImage or deb extract) from a fresh data dir,
// by mouse or by keyboard only, and writes one verdict for that build, OS and mode.
//
//   node scripts/ten-jobs/run.mjs --exe <app exe> --root <fresh dir> --pw <dir holding node_modules/playwright-core>
//        --tree <40-hex build commit> --mode mouse|keyboard [--jobs 0,1,2] [--out <verdict.json>] [--port 18799]
//
// Selectors are role + visible English name only: no test ids, no hover, no scroll-to-find.
// The real engine is Fuigo through Flux Router. The rig passes the Flux key as a FILE
// (TEN_JOBS_FLUX_KEY_FILE, a throwaway gate key named fuigo.key); it is typed into the
// first-run key field like an owner pastes it, and never printed or written out.
// It never touches ~/.murage and never listens on 8799 (it holds 8799 so a stray
// launch cannot reach the owner's own app).
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildVerdict, gateFilesSha256, judgeJob, judgeSeen, pickInput, seenActionable, seenVisible, setupPoint, verdictProblems } from "./core.mjs";
import { PATHS } from "./paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const EXE = opt("--exe"), ROOT = opt("--root") && resolve(opt("--root")), PW = opt("--pw"), TREE = opt("--tree"), MODE = opt("--mode", "mouse");
const PORT = opt("--port", "18799");
if (!EXE || !ROOT || !PW || !/^[0-9a-f]{40}$/.test(String(TREE)) || !["mouse", "keyboard"].includes(MODE)) {
  console.error("usage: run.mjs --exe <exe> --root <fresh dir> --pw <dir> --tree <40-hex sha> --mode mouse|keyboard [--jobs 0,1] [--out f]");
  process.exit(2);
}
if (PORT === "8799") { console.error("refused: 8799 is the owner's own app"); process.exit(2); }
if (existsSync(join(ROOT, "data"))) { console.error("refused: root already has data (fresh root only)"); process.exit(2); }
if (/\.murage(\/|\\|$)/.test(ROOT)) { console.error("refused: root names .murage"); process.exit(2); }
const BUDGETS = JSON.parse(readFileSync(join(HERE, "budgets.json"), "utf8")).jobs;
const WANT = opt("--jobs") ? opt("--jobs").split(",").map(Number) : BUDGETS.map((b) => b.id);
const OUT = opt("--out", join(ROOT, `ten-jobs-${TREE.slice(0, 12)}-${platform()}-${MODE}.json`));
const pathsSha256 = gateFilesSha256(readFileSync(join(HERE, "paths.mjs")), readFileSync(join(HERE, "budgets.json")));

const DATA = join(ROOT, "data"), UD = join(ROOT, "ud"), SHOTS = join(ROOT, "shots");
for (const d of [DATA, UD, SHOTS]) mkdirSync(d, { recursive: true });
const T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms} ms: ${what}`)), ms))]);

// The Flux key: only a throwaway gate key file named fuigo.key, never the Flux TEST key.
const keyFile = process.env.TEN_JOBS_FLUX_KEY_FILE || join(homedir(), ".config", "flux", "fuigo.key");
if (!/fuigo\.key$/.test(keyFile) || /flux-test|test-key/i.test(keyFile)) { console.error("refused: only the throwaway fuigo.key"); process.exit(2); }
const SECRETS = { fluxKey: existsSync(keyFile) ? readFileSync(keyFile, "utf8").trim() : null };

const hold = createServer();
await new Promise((r) => { hold.once("error", () => r()); hold.listen(8799, "127.0.0.1", r); });
const { _electron: electron } = createRequire(join(resolve(PW), "x.js"))("playwright-core");
let app, page;

const launch = async () => {
  const env = { ...process.env, MURAGE_DATA_DIR: DATA, MURAGE_USER_DATA: UD, MURAGE_PORT: PORT };
  delete env.FLUX_API_KEY; delete env.ANTHROPIC_API_KEY; delete env.OPENAI_API_KEY; // a fresh owner has none set
  app = await electron.launch({ executablePath: EXE, args: [`--user-data-dir=${UD}`, "--disable-gpu", ...(platform() === "linux" ? ["--no-sandbox"] : [])], cwd: ROOT, env, timeout: 120000 });
  const end = Date.now() + 180000;
  for (;;) {
    for (const w of [...app.windows()].reverse()) {
      try { if (!w.isClosed() && /^http:\/\/127\.0\.0\.1:/.test(w.url())) { await w.waitForLoadState("domcontentloaded", { timeout: 4000 }); page = w; break; } } catch { /* next */ }
    }
    if (page) break;
    if (Date.now() > end) throw new Error("no app window on its local server in 180 s");
    await sleep(1000);
  }
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => { /* fixed window */ });
  log(`app window ${page.url()}`);
};

// API reads for END checks only (never for steps): the desktop surface the app's own window uses.
const api = (method, path, body) => withTimeout(page.evaluate(async ({ method, path, body }) => {
  const r = await fetch(path, { method, headers: { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": window.muragebox?.desktopSurfaceSecret ?? "" }, body: body === undefined ? undefined : JSON.stringify(body) });
  let b = null; try { b = await r.json(); } catch { /* none */ } return { status: r.status, body: b };
}, { method, path, body }), 20000, `${method} ${path}`);

const locator = (s) => s.role ? page.getByRole(s.role, { name: s.name, exact: s.exact ?? false })
  : s.label ? page.getByLabel(s.label, { exact: s.exact ?? false })
  : s.placeholder ? page.getByPlaceholder(s.placeholder, { exact: s.exact ?? false })
  : page.getByText(s.text, { exact: s.exact ?? false });

// What an owner can see right now, measured BEFORE acting (Playwright would scroll for us otherwise).
// The page reports raw facts (box, window, opacity and visibility up the ancestor chain, hit tests at
// probe points); core.judgeSeen decides. `want` picks the first candidate that is good enough.
async function measure(loc, want = seenActionable) {
  let n = 0; try { n = await loc.count(); } catch { return { seen: { found: false } }; }
  let fallback = null;
  for (let i = 0; i < Math.min(n, 8); i++) {
    const el = loc.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const raw = await el.evaluate((e) => {
      const b = e.getBoundingClientRect(); const vw = window.innerWidth, vh = window.innerHeight;
      const chain = [];
      for (let n = e; n && n.nodeType === 1; n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null) {
        const cs = getComputedStyle(n); chain.push({ opacity: cs.opacity, visibility: cs.visibility, display: cs.display });
      }
      // An owner clicks the part they can see (a tall field whose lower half sits under a dialog footer is
      // still clickable at its top), so probe the centre, then the top band, then the top-left corner.
      const probes = [];
      const dy = Math.min(12, b.height / 2), dx = Math.min(12, b.width / 2);
      for (const [px, py] of [[b.width / 2, b.height / 2], [b.width / 2, dy], [dx, dy]]) {
        const x = b.left + px, y = b.top + py;
        if (x < 0 || y < 0 || x > vw || y > vh) { probes.push({ x: px, y: py, hit: "none" }); continue; }
        const h = document.elementFromPoint(x, y);
        probes.push({ x: px, y: py, hit: !h ? "none" : h === e ? "self" : e.contains(h) ? "inside" : h.contains(e) ? "ancestor" : "other" });
      }
      const rect = { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height };
      return { rect, vw, vh, chain, probes, disabled: Boolean(e.disabled) || e.getAttribute("aria-disabled") === "true" };
    }).catch(() => null);
    if (!raw) continue;
    const { seen, point } = judgeSeen(raw);
    // Where to click, in window coordinates: a mouse click there never scrolls the page.
    const xy = point ? { x: raw.rect.left + point.x, y: raw.rect.top + point.y } : null;
    if (want(seen)) return { seen, el, point, xy };
    fallback ??= { seen, el };
  }
  return fallback ?? { seen: { found: false } };
}
async function waitSeen(s) {
  const end = Date.now() + (s.waitMs ?? 15000); let last;
  for (;;) {
    last = await measure(locator(s));
    if (seenActionable(last.seen)) return last;
    if (Date.now() > end) return last;
    await sleep(400);
  }
}
const isFocused = (el) => el.evaluate((e) => e === document.activeElement || e.contains(document.activeElement)).catch(() => false);
// Move focus by pressing `key` until `el` has it; every press is an owner input and is recorded.
async function pressTo(el, key, max, press) {
  for (let t = 0; t <= max; t++) { if (await isFocused(el)) return true; if (t === max) break; await press(key); await sleep(60); }
  return false;
}
const MENU_ROLES = new Set(["menuitem", "menuitemradio", "menuitemcheckbox"]);
// An error on screen with no next click: an alert that offers no button.
async function stuckError() {
  return page.evaluate(() => {
    for (const a of document.querySelectorAll('[role="alert"],[role="alertdialog"]')) {
      const r = a.getBoundingClientRect(); if (!r.width || !r.height) continue;
      const t = (a.textContent || "").trim();
      if (/went wrong|could ?n.t|failed|error/i.test(t) && !a.querySelector("button,a[href]")) return t.slice(0, 300);
    }
    return null;
  }).catch(() => null);
}

// One path step. rec.inputs lists every owner input it took (the step ruling): each click, each key
// press (Tab, arrows, Enter, Space, Esc, chords) and one entry per field typed into.
async function doStep(s) {
  const rec = { kind: s.kind, label: s.title ?? `${s.kind} ${s.role ?? (s.placeholder ? "placeholder" : s.label ? "label" : "")} "${s.name ?? s.placeholder ?? s.label ?? s.chord ?? s.text ?? ""}"`, decision: Boolean(s.decision), taken: false, inputs: [] };
  const press = async (key) => { await page.keyboard.press(key); rec.inputs.push({ input: "key", key }); };
  // A mouse click lands on the measured visible point, so nothing scrolls the target into view for the owner.
  const click = async () => { await page.mouse.click(xy.x, xy.y); rec.inputs.push({ input: "click" }); };
  const typeInto = async (el, text) => { await el.fill(text); rec.inputs.push({ input: "type" }); };
  if (s.kind === "key") {
    rec.seen = { found: true, inViewport: true, covered: false, viaHelp: Boolean(s.help), named: true };
    await press(s.chord); rec.taken = true; await sleep(s.settleMs ?? 500); return rec;
  }
  const { seen, el, xy } = await waitSeen(s); rec.seen = seen;
  if (s.optional && !seen.found) { rec.kind = "skipped"; rec.label += " (not on this machine)"; return { ...rec, taken: true }; }
  if (!seenActionable(seen)) return rec;
  const text = s.secret ? SECRETS[s.secret] : s.valueFrom ? s.valueFrom(ctx) : s.value;
  if (s.kind === "type" && text == null) { rec.seen = { ...seen, found: false }; rec.label += " (no value for the field)"; return rec; }
  if (MODE === "keyboard") {
    // Inside an open menu an owner moves with the arrow keys (WAI-ARIA menu pattern), else with Tab.
    const menu = MENU_ROLES.has(s.role);
    let there = await pressTo(el, menu ? "ArrowDown" : "Tab", menu ? 30 : 80, press);
    if (!there && menu) there = await pressTo(el, "Tab", 80, press); // a menu whose items take Tab
    if (!there) { rec.seen = { ...seen, unreachable: true }; return rec; }
    if (s.kind === "type") await typeInto(el, text);
    else if (s.option) {
      // A focused native list moves one choice per arrow press; press them for real and check where it landed.
      const { cur, want } = await el.evaluate((e, label) => ({ cur: e.selectedIndex, want: [...e.options].findIndex((o) => o.label === label) }), s.option);
      if (want < 0) { rec.seen = { ...seen, found: false }; rec.label += ` (no choice "${s.option}")`; return rec; }
      for (let i = 0; i < Math.abs(want - cur); i++) { await press(want > cur ? "ArrowDown" : "ArrowUp"); await sleep(60); }
      if ((await el.evaluate((e) => e.selectedIndex)) !== want) { rec.seen = { ...seen, unreachable: true }; rec.label += " (arrow keys did not pick the choice)"; return rec; }
    } else await press(["checkbox", "switch", "radio"].includes(s.role) ? "Space" : "Enter");
  } else if (s.kind === "type") {
    if (!(await isFocused(el))) await click(); // an owner clicks into the field unless it already has the cursor
    await typeInto(el, text);
  } else if (s.option) {
    // MurageMain 11-03: the open list of a native select is drawn by the OS, outside the page. The rig drives
    // the real control (selectOption) and records ONE step, only when the choice actually changed to the one
    // wanted; a choice that did not change records nothing, so the step fails as not taken by the owner.
    const label = (e) => e.selectedOptions[0]?.label ?? null;
    const before = await el.evaluate(label);
    await el.selectOption({ label: s.option });
    const input = pickInput(before, await el.evaluate(label), s.option);
    if (input) rec.inputs.push(input); else rec.label += " (the choice did not change)";
  } else await click();
  rec.taken = true;
  if (s.submit) await press("Enter");
  await sleep(s.settleMs ?? 600);
  return rec;
}

async function checkEnd(job, ctx) {
  const e = job.end; const end = Date.now() + (e.ms ?? 20000); let why = "not seen";
  for (;;) {
    try {
      if (e.probe) { const r = await e.probe(ctx); if (r === true) return { ok: true }; if (typeof r === "string") why = r; }
      else {
        // End evidence must be on screen, not hidden by a parent and not covered: what an owner would see.
        const m = await measure(locator(e), seenVisible);
        if (seenVisible(m.seen)) return { ok: true };
        why = !m.seen.found ? "not seen" : !m.seen.inViewport ? "off screen" : m.seen.hoverOnly || m.seen.hidden ? "hidden" : "covered";
      }
    } catch (err) { why = String(err?.message ?? err).slice(0, 200); }
    if (Date.now() > end) return { ok: false, reason: `${e.what ?? "end"}: ${why} after ${Math.round((e.ms ?? 20000) / 1000)} s` };
    await sleep(1000);
  }
}

// Every job after the first starts where an owner starts: the main window, nothing open.
async function home() {
  for (let i = 0; i < 3; i++) { await page.keyboard.press("Escape").catch(() => {}); await sleep(150); }
  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  await sleep(2500);
}

const results = []; const walks = {};
// A job's setup puts its start state in place BEFORE the counted walk. A setup click is measured like a
// step (on screen without scrolling, visible, uncovered) and lands by coordinates, which never scroll;
// a target an owner could not see fails the job instead of being scrolled to.
async function setupClick(loc, what) {
  const { x, y } = setupPoint(await measure(loc), what);
  await page.mouse.click(x, y);
}
const ctx = { api, get page() { return page; }, sleep, log, setupClick, state: {}, secrets: { has: (k) => SECRETS[k] != null } };
const save = () => {
  const v = buildVerdict({ tree: TREE, version: ctx.state.appVersion ?? null, os: platform(), mode: MODE, jobs: results, budgets: BUDGETS.filter((b) => WANT.includes(b.id)), pathsSha256, engine: "fuigo", walks });
  v.partial = WANT.length !== BUDGETS.length;
  v.standIns = String(process.env.TEN_JOBS_STAND_INS ?? "").split(",").filter(Boolean); // local stand-ins the rig put in place
  writeFileSync(OUT, JSON.stringify(v, null, 2)); return v;
};
// The verdict binds to the commit the PACKAGE was built from (vite bakes it into the About "Source code" link),
// read from the package's own UI files, not to what the caller says: a mismatch means the wrong bytes are under test.
const bakedCommits = () => {
  const res = platform() === "darwin" ? join(dirname(dirname(EXE)), "Resources") : join(dirname(EXE), "resources");
  const dir = join(res, "ui", "assets"); const hits = new Set();
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".js")) continue;
      const t = readFileSync(join(dir, f), "utf8"); if (!t.includes("FerroxLabs/murage")) continue;
      for (const m of t.matchAll(/"([0-9a-f]{40})"/g)) if (t.slice(Math.max(0, m.index - 4000), m.index + 4000).includes("FerroxLabs/murage")) hits.add(m[1]);
    }
  } catch { /* not readable */ }
  return [...hits];
};
const baked = bakedCommits();
log(`build commit baked into the package: ${baked.join(",") || "not found"}`);
if (baked.length === 1 && baked[0] !== TREE) { console.error(`refused: --tree ${TREE} but the package was built from ${baked[0]}`); process.exit(2); }
if (baked.length !== 1) { console.error("refused: could not read exactly one build commit from the package"); process.exit(2); }
await launch();
try { ctx.state.appVersion = await app.evaluate(({ app: a }) => a.getVersion()); } catch { /* unknown */ }
log(`Murage ${ctx.state.appVersion} mode ${MODE} jobs ${WANT.join(",")}; Flux key file ${SECRETS.fluxKey ? "present" : "MISSING"}`);
for (const id of WANT) {
  const job = PATHS.find((p) => p.id === id); const budget = BUDGETS.find((b) => b.id === id);
  if (!job || !budget) { log(`job ${id}: no path or budget`); continue; }
  const t = Date.now(); const walk = { steps: [], end: null, error: null };
  try {
    if (id !== 0) await home();
    if (job.setup) await job.setup(ctx);
    for (const s of job.path) {
      const rec = await doStep(s); walk.steps.push(rec);
      if (!rec.taken) break;
      const err = await stuckError(); if (err) { walk.error = err; break; }
    }
    if (walk.steps.every((s) => s.taken) && !walk.error) walk.end = await checkEnd(job, ctx);
    else walk.end = { ok: false, reason: "walk stopped" };
  } catch (err) { walk.error = String(err?.message ?? err).slice(0, 300); walk.end ??= { ok: false, reason: "walk threw" }; }
  walk.ms = Date.now() - t; walks[id] = walk;
  const j = judgeJob(budget, walk, MODE); results.push(j);
  if (j.pass !== true) await page.screenshot({ path: join(SHOTS, `job-${id}-${MODE}.png`) }).catch(() => {});
  if (j.reportOnly) console.log(`JOB ${id} REPORT steps ${j.steps} (${MODE} report only)${j.reason ? ` ${j.reason}` : ""}`);
  else console.log(`JOB ${id} ${j.pass ? "PASS" : "FAIL"} steps ${j.steps}/${j.budget}${j.reason ? ` ${j.reason}` : ""}`);
  save();
}
const v = save();
const problems = verdictProblems(v);
console.log(`VERDICT ${v.reportOnly ? "REPORT (no pass or fail)" : v.pass ? "PASS" : "FAIL"} ${results.filter((j) => j.pass).length}/${results.length} jobs, ${platform()} ${MODE}, tree ${TREE.slice(0, 12)}${problems.length ? `, PROBLEMS ${problems.join("; ")}` : ""} -> ${OUT}`);
try { await withTimeout(app.close(), 30000, "close"); } catch { try { app.process().kill("SIGKILL"); } catch { /* gone */ } }
hold.close();
process.exit((v.pass || v.reportOnly) && !problems.length ? 0 : 1);
