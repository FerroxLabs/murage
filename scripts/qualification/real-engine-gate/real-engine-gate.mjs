#!/usr/bin/env node
// REAL-ENGINE-GATE harness (design: ../REAL-ENGINE-GATE.md). One cross-platform script (mac / win / linux, Node >= 20).
// Runs ONLY as the dedicated OS user `muragegate` (never Sean's user, never root). Never touches port 8799, ~/.murage or a real install.
//   node real-engine-gate.mjs --artifact <dmg|.app|.zip|setup.exe|AppImage|.deb|unpacked dir> --engines claude,codex,fuigo
//        [--engines all|release] [--cli pinned|newest] [--nightly] [--out dir] [--gate-home dir] [--flux-key-file f]
//        [--mcp-record required|optional] [--g5 required|skip] [--keep] [--list-engines] [--preflight-only]
//        [--journeys browser,computer] [--with-core] [--linux-browser-sandbox auto|shim|none]
//        [--profile win-nogit [--planted-bash]]   (Windows no-Git box only; off by default; see PATCH-NOTE.md and WIN-NOBASH-DESIGN-r2.md section 5)   (journeys: see "Browser and computer" in ../REAL-ENGINE-GATE.md)
// Credentials: this script never reads any auth file. It runs each engine's own status command and keeps a boolean.
// The only secret it ever handles is the Flux TEST key file (account 052be274), copied into the run root config and deleted with it.
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync, readlinkSync, realpathSync } from "node:fs";
import { homedir, platform, tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const flag = (n) => argv.includes(n);
const OS = { darwin: "mac", win32: "win", linux: "linux" }[platform()] ?? platform();
const WIN = OS === "win", MAC = OS === "mac", LINUX = OS === "linux";
const T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (probe, ms, what, every = 400) => { const end = Date.now() + ms; for (;;) { const v = await probe(); if (v) return v; if (Date.now() > end) throw new Error(`timeout: ${what}`); await sleep(every); } };
const lc = (s) => (WIN ? String(s).toLowerCase() : String(s));
const within = (parent, child) => { const a = lc(resolve(parent)) + sep, b = lc(resolve(child)) + sep; return b.startsWith(a); };

const CATALOG = JSON.parse(readFileSync(join(HERE, "engines.json"), "utf8"));
const VERSIONS = JSON.parse(readFileSync(resolve(opt("--versions", join(HERE, "versions.json"))), "utf8")).engines ?? {};
if (flag("--list-engines")) { for (const [k, e] of Object.entries(CATALOG.engines)) console.log(`${k.padEnd(14)} ${e.driver.padEnd(17)} auth=${e.auth.padEnd(12)} ${e.auth === "none" ? "UNEXERCISED: " + e.unexercised : "sign-in: " + e.signIn}`); process.exit(0); }

const NIGHTLY = flag("--nightly") || opt("--cli", "pinned") === "newest";
const GATE_USER = opt("--gate-user", "muragegate");
const MCP_RECORD_MODE = opt("--mcp-record", "required");
// ---------------------------------------------------------------- --profile win-nogit (OFF by default; Linux/Mac runs never load these modules)
const PROFILE = opt("--profile", "");
if (PROFILE && PROFILE !== "win-nogit") { console.error(`unknown --profile ${PROFILE}`); process.exit(2); }
if (PROFILE === "win-nogit" && platform() !== "win32") { console.error("--profile win-nogit runs only on the Windows no-Git gate box"); process.exit(2); }
const findMod = (name) => [join(HERE, name), join(HERE, "win-smoke", name), join(HERE, "..", "win-smoke", name)].find((f) => existsSync(f));
let WN = null, ANC = null, PEV = null;
if (PROFILE === "win-nogit") {
  for (const n of ["profile-win-nogit.mjs", "ps-ancestry.mjs", "proc-events.mjs"]) if (!findMod(n)) { console.error(`--profile win-nogit: ${n} not shipped next to the harness`); process.exit(2); }
  WN = await import(pathToFileURL(findMod("profile-win-nogit.mjs")).href); ANC = await import(pathToFileURL(findMod("ps-ancestry.mjs")).href); PEV = await import(pathToFileURL(findMod("proc-events.mjs")).href);
}
const NOGIT_NONCE = randomBytes(4).toString("hex").toUpperCase();
const G5_MODE = opt("--g5", "required");
const artifact = opt("--artifact");
const PREFLIGHT_ONLY = flag("--preflight-only");
const JOURNEYS = String(opt("--journeys", "")).split(",").map((s) => s.trim()).filter(Boolean);
for (const j of JOURNEYS) if (!["browser", "computer"].includes(j)) { console.error(`unknown journey set ${j}`); process.exit(2); }
const WITH_CORE = JOURNEYS.length === 0 || flag("--with-core");
if (!artifact && !PREFLIGHT_ONLY) { console.error("--artifact required (or --preflight-only)"); process.exit(2); }
const engSpec = opt("--engines", CATALOG.defaultEngines.join(","));
const wanted = engSpec === "all" ? Object.keys(CATALOG.engines) : engSpec === "release" ? CATALOG.releaseEngines : engSpec.split(",").map((s) => s.trim()).filter(Boolean);
for (const w of wanted) if (!CATALOG.engines[w]) { console.error(`unknown engine ${w}; try --list-engines`); process.exit(2); }

// ---------------------------------------------------------------- G1 user wall (before anything else touches disk)
const me = userInfo().username;
const FORBIDDEN_USERS = /^(root|administrator|system)$/i;
const g1 = { user: me, expected: GATE_USER, ok: true, notes: [] };
if (FORBIDDEN_USERS.test(me)) { console.error(`G1 REFUSED: running as ${me}. This gate runs only as a dedicated gate account.`); process.exit(2); }
if (me.toLowerCase() !== GATE_USER.toLowerCase()) { console.error(`G1 REFUSED: current user is ${me}, expected ${GATE_USER}.`); process.exit(2); }
if (process.getuid?.() === 0) { console.error("G1 REFUSED: uid 0."); process.exit(2); }

const REAL_HOME = userInfo().homedir;
const GATE = resolve(opt("--gate-home", join(REAL_HOME, "gate")));
const GATE_HOME = MAC ? REAL_HOME : join(GATE, "home"); // mac keeps the login home (Keychain); win/linux redirect HOME into the gate dir
const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
const outDir = resolve(opt("--out", join(GATE, "out", `${stamp}-${OS}`)));
mkdirSync(outDir, { recursive: true }); mkdirSync(GATE_HOME, { recursive: true });
for (const d of [".murage"]) if (existsSync(join(REAL_HOME, d, "messages.db")) && Date.now() - statSync(join(REAL_HOME, d, "messages.db")).mtimeMs > 0) { g1.ok = false; g1.notes.push(`${join(REAL_HOME, d)}/messages.db already exists: a Murage has run in this account`); }

const runRoot = mkdtempSync(join(GATE, "runs-"));
const P = { app: join(runRoot, "app"), data: join(runRoot, "data"), userData: join(runRoot, "electron-user-data"), tmp: join(runRoot, "tmp"), ev: join(runRoot, "evidence"), pw: join(GATE, "pw"), bin: join(GATE, "bin"), npm: join(GATE, "npm"), dmg: join(runRoot, "dmg"), g5: join(runRoot, "g5") };
for (const d of Object.values(P)) mkdirSync(d, { recursive: true });
const PORT = Number(opt("--port", "18799")); if (!(PORT > 1024 && PORT < 65536) || [8799, 28799, 8810, 8811, 9555].includes(PORT)) { console.error(`--port ${PORT} refused`); process.exit(2); }
const MCP_RECORD = join(P.ev, "mcp-record.jsonl");

// ---------------------------------------------------------------- bookkeeping
const results = []; let current;
const step = async (id, title, fn) => {
  const t = Date.now(); current = { id, title, status: "RUNNING", checks: [], ms: 0 }; results.push(current); log(`STEP ${id} ${title}`);
  try { await fn(current); current.status = current.checks.some((c) => c.ok === false) ? "FAIL" : "PASS"; }
  catch (e) { current.status = "FAIL"; current.checks.push({ ok: false, what: "step threw", detail: String(e?.stack ?? e).slice(0, 1200) }); }
  current.ms = Date.now() - t; log(`  -> ${current.status} (${(current.ms / 1000).toFixed(1)}s)`); return current.status;
};
const check = (ok, what, detail) => { current.checks.push({ ok: Boolean(ok), what, ...(detail === undefined ? {} : { detail: typeof detail === "string" ? detail.slice(0, 500) : detail }) }); if (!ok) log(`  CHECK FAILED: ${what} ${detail === undefined ? "" : JSON.stringify(detail).slice(0, 240)}`); return Boolean(ok); };
const note = (what, detail) => current.checks.push({ ok: true, what: `info: ${what}`, ...(detail === undefined ? {} : { detail }) });

// ---------------------------------------------------------------- env hygiene (names only, never values)
const KEY_NAMES = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "XAI_API_KEY", "GROK_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_API_KEY", "FLUX_API_KEY", "FUIGO_API_KEY", "FUIGO_CODE_API_KEY", "CURSOR_API_KEY", "FACTORY_API_KEY", "MINIMAX_API_KEY", "OPENROUTER_API_KEY", "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "CLAUDECODE"];
const STRIP_RE = /^(CLAUDE_CODE_|MESSAGING_|MURAGE_|FUIGO_|CODEX_)/;
const unsetNames = Object.keys(process.env).filter((k) => KEY_NAMES.includes(k) || STRIP_RE.test(k));
log(`env names unset for every child: ${unsetNames.join(", ") || "(none set)"}`);
const cleanBase = () => {
  const sys = WIN ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32"), process.env.SystemRoot ?? "C:\\Windows"] : MAC ? ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"] : ["/usr/local/bin", "/usr/bin", "/bin"];
  const nodeDir = dirname(process.execPath);
  const path = [P.bin, WIN ? P.npm : join(P.npm, "bin"), join(GATE_HOME, ".local", "bin"), join(GATE_HOME, ".fuigo", "bin"), nodeDir, ...sys].join(WIN ? ";" : ":");
  const env = { PATH: path, HOME: GATE_HOME, TMPDIR: P.tmp, TEMP: P.tmp, TMP: P.tmp, LANG: "en_US.UTF-8", NPM_CONFIG_PREFIX: P.npm, NPM_CONFIG_CACHE: join(GATE, "npm-cache") };
  if (WIN) Object.assign(env, { SystemRoot: process.env.SystemRoot, windir: process.env.windir, ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT, USERPROFILE: GATE_HOME, APPDATA: join(GATE_HOME, "AppData", "Roaming"), LOCALAPPDATA: join(GATE_HOME, "AppData", "Local") });
  else { env.USER = me; env.LOGNAME = me; if (LINUX) Object.assign(env, { XDG_CONFIG_HOME: join(GATE_HOME, ".config"), XDG_DATA_HOME: join(GATE_HOME, ".local", "share"), XDG_CACHE_HOME: join(GATE_HOME, ".cache"), XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? "", DISPLAY: process.env.DISPLAY ?? ":99", XDG_SESSION_TYPE: "x11", DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? "" }); }
  if (WIN) for (const d of [env.APPDATA, env.LOCALAPPDATA]) mkdirSync(d, { recursive: true });
  for (const d of [P.bin, P.npm, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME].filter(Boolean)) mkdirSync(d, { recursive: true });
  for (const k of Object.keys(env)) if (env[k] === undefined || env[k] === "") delete env[k];
  return env;
};
const baseEnv = cleanBase();
const leftoverKeys = Object.keys(baseEnv).filter((k) => KEY_NAMES.includes(k) || STRIP_RE.test(k));
const run = (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: "utf8", env: baseEnv, windowsHide: true, timeout: 60000, maxBuffer: 1 << 26, shell: WIN && /\.(cmd|bat)$/i.test(cmd) ? true : false, ...o });
const which = (name) => { const r = run(WIN ? "where" : "which", [name]); return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null; };

// ---------------------------------------------------------------- process table (our own tool; G3)
const ps = (script) => execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { encoding: "utf8", windowsHide: true, maxBuffer: 1 << 26 });
const procTable = () => {
  if (WIN && PROFILE === "win-nogit") { const a = JSON.parse(ps("Get-Process | Select-Object Id,ProcessName,Path | ConvertTo-Json -Compress") || "[]"); return (Array.isArray(a) ? a : [a]).map((p) => ({ pid: p.Id, ppid: 0, name: p.ProcessName, cmd: p.Path ?? "" })); }
  if (WIN) { const a = JSON.parse(ps("Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress")); return (Array.isArray(a) ? a : [a]).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name, cmd: p.CommandLine ?? p.ExecutablePath ?? "" })); }
  const r = spawnSync("ps", ["-axo", "pid=,ppid=,args="], { encoding: "utf8", maxBuffer: 1 << 26 });
  return r.stdout.split("\n").map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => ({ pid: +m[1], ppid: +m[2], name: basename(m[3].split(" --")[0]), cmd: m[3] }));
};
const ownedPids = () => procTable().filter((p) => p.pid !== process.pid && lc(p.cmd).includes(lc(runRoot))).map((p) => p.pid);
const killOwned = () => { for (const pid of ownedPids()) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } } };
const envOf = (pid) => { // unix only, own processes: is ELECTRON_RUN_AS_NODE set?
  try { if (LINUX) return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").some((e) => e.startsWith("ELECTRON_RUN_AS_NODE=")); if (MAC) return / ELECTRON_RUN_AS_NODE=/.test(spawnSync("ps", ["eww", "-p", String(pid), "-o", "command="], { encoding: "utf8" }).stdout); } catch { /* unreadable */ }
  return null;
};
let appDir = null, resDir = null, exe = null;
const watch = { seen: new Map(), stray: [], timer: null, running: false };
const scanOnce = () => {
  if (watch.running) return; watch.running = true;
  try {
    for (const p of procTable()) {
      if (watch.seen.has(p.pid)) continue;
      const mine = lc(p.cmd).includes(lc(runRoot));
      watch.seen.set(p.pid, { pid: p.pid, ppid: p.ppid, mine, cmd: mine ? p.cmd.slice(0, 260).replaceAll(runRoot, "<run>") : undefined, t: Date.now() });
      if (!mine || !appDir || p.pid === process.pid || !lc(p.cmd).includes(lc(appDir))) continue;
      if (/--type=|crashpad|chrome-sandbox|zygote|appimage-extract/i.test(p.cmd)) continue;
      if (!/^murage(\.exe)?$/i.test(basename(p.cmd.split(/\s+--?/)[0].trim().replace(/^"|"$/g, "")))) continue; // only the Murage executable can be a stray Electron launch (cua-driver, agent-browser, chrome live in appDir too)
      const hasUD = lc(p.cmd).includes(lc(`--user-data-dir=${P.userData}`)) || lc(p.cmd).includes(lc(P.g5));
      const scriptArg = /\.(m?js|cjs)(["'\s]|$)/i.test(p.cmd);
      if (scriptArg) { const asNode = envOf(p.pid); if (asNode === false) watch.stray.push({ pid: p.pid, why: "stray Electron launch: launcher/script argv without ELECTRON_RUN_AS_NODE", cmd: p.cmd.slice(0, 200).replaceAll(runRoot, "<run>") }); }
      else if (!hasUD) watch.stray.push({ pid: p.pid, why: "stray Electron launch: main process without --user-data-dir of this run", cmd: p.cmd.slice(0, 200).replaceAll(runRoot, "<run>") });
    }
  } catch { /* transient */ } finally { watch.running = false; }
};
const startWatch = () => { scanOnce(); watch.timer = setInterval(scanOnce, WIN ? 1200 : 400); };

// ---------------------------------------------------------------- G2 / G4 fingerprints
const defaultProfiles = () => {
  const homes = [...new Set([REAL_HOME, GATE_HOME])];
  const rel = WIN ? [[".murage"], ["AppData", "Roaming", "Murage"], ["AppData", "Roaming", "murage"], ["AppData", "Local", "murage-updater"]] : MAC ? [[".murage"], ["Library", "Application Support", "Murage"], ["Library", "Application Support", "murage"]] : [[".murage"], [".config", "Murage"], [".config", "murage"]];
  return homes.flatMap((h) => rel.map((r) => join(h, ...r)));
};
const listen8799 = () => new Promise((res) => { const s = connect({ host: "127.0.0.1", port: 8799, timeout: 800 }); s.on("connect", () => { s.destroy(); res(true); }); s.on("error", () => res(false)); s.on("timeout", () => { s.destroy(); res(false); }); });
const own8799 = async () => { // a listener on 8799 that WE own (Sean's Murage on another account must not count)
  if (!(await listen8799())) return false;
  try {
    if (MAC) return spawnSync("lsof", ["-nP", "-iTCP:8799", "-sTCP:LISTEN", "-a", "-u", String(process.getuid())], { encoding: "utf8" }).stdout.trim().length > 0;
    if (LINUX) return /users:/.test(spawnSync("ss", ["-ltnpH", "sport", "=", ":8799"], { encoding: "utf8" }).stdout);
    if (WIN) { const pids = ps("(Get-NetTCPConnection -LocalPort 8799 -State Listen -ErrorAction SilentlyContinue).OwningProcess").split(/\s+/).filter(Boolean); const mineP = new Set(procTable().filter((p) => lc(p.cmd).includes(lc(GATE))).map((p) => String(p.pid))); return pids.some((p) => mineP.has(p)); }
  } catch { /* fall through */ }
  return true;
};
const portOwnedByRun = (port) => { // pid(s) listening on port are processes of this run's app tree
  try {
    let pids = [];
    if (LINUX) pids = [...spawnSync("ss", ["-ltnpH", "sport", "=", `:${port}`], { encoding: "utf8" }).stdout.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]));
    else if (MAC) pids = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).stdout.split(/\s+/).filter(Boolean).map(Number);
    else if (WIN) pids = ps(`(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess`).split(/\s+/).filter(Boolean).map(Number);
    const mine = new Set(ownedPids()); return pids.length > 0 && pids.every((x) => mine.has(x));
  } catch { return false; }
};
const profilesPresent = () => defaultProfiles().filter((p) => existsSync(p));
const dirTop = (p) => { try { return readdirSync(p).sort().map((n) => { try { const s = statSync(join(p, n)); return `${n}|${s.isDirectory() ? "d" : s.size}|${Math.round(s.mtimeMs)}`; } catch { return `${n}|?`; } }); } catch { return null; } };
const protectedList = [join(GATE_HOME, ".claude"), join(GATE_HOME, ".codex"), join(GATE_HOME, ".fuigo"), join(GATE_HOME, ".grok")];
const fingerprint = () => Object.fromEntries([...protectedList.map((p) => [p, dirTop(p)]), ...(LINUX ? [[join(GATE_HOME, ".local/share/applications"), dirTop(join(GATE_HOME, ".local/share/applications"))]] : [])].map(([p, v]) => [p, v?.map((x) => x.replace(/\|\d+$/, "")) ?? null])); // names (+size) only; mtime excluded: engines refresh tokens legitimately
const protoKey = "HKCU\\Software\\Classes\\murage";
const protoQuery = () => (WIN ? spawnSync("reg", ["query", protoKey, "/s"], { encoding: "utf8", windowsHide: true }) : { status: 1, stdout: "" });
const protoBefore = protoQuery(); const protoBackup = join(runRoot, "murage-proto-backup.reg");
if (WIN && protoBefore.status === 0) spawnSync("reg", ["export", protoKey, protoBackup, "/y"], { windowsHide: true });
const fpBefore = fingerprint();
const guards = { G1: g1, G2: { before: { profiles: profilesPresent(), port8799Ours: await own8799() } }, G3: {}, G4: {}, G5: {} };

// ---------------------------------------------------------------- artifact -> unpacked app (never an installer run, never a real install)
const findExe = (dir) => {
  if (MAC) { const m = join(dir, "Contents", "MacOS"); return existsSync(m) ? join(m, readdirSync(m).find((n) => /^murage$/i.test(n)) ?? readdirSync(m)[0]) : null; }
  const ents = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile());
  const pick = ents.find((e) => WIN ? /^murage\.exe$/i.test(e.name) : /^murage$/i.test(e.name)) ?? ents.find((e) => !/\.(so|pak|bin|dat|json|html|txt|dll)$/i.test(e.name) && (WIN || (statSync(join(dir, e.name)).mode & 0o111)) && /murage|apprun/i.test(e.name));
  return pick ? join(dir, pick.name) : null;
};
const findDir = (root, pred, depth = 4) => { const walk = (d, n) => { if (pred(d)) return d; if (n === 0) return null; let ents; try { ents = readdirSync(d, { withFileTypes: true }); } catch { return null; } for (const e of ents) if (e.isDirectory()) { const r = walk(join(d, e.name), n - 1); if (r) return r; } return null; }; return walk(root, depth); };
const sevenZip = ["C:\\Program Files\\7-Zip\\7z.exe", "C:\\Program Files (x86)\\7-Zip\\7z.exe"].find(existsSync);
const x7 = (file, dest) => { const r = spawnSync(sevenZip, ["x", "-y", `-o${dest}`, file], { encoding: "utf8", windowsHide: true, maxBuffer: 1 << 28 }); if (r.status !== 0) throw new Error(`7z failed: ${(r.stdout ?? "").slice(-300)}`); };
let mountedDmg = false, registeredApp = null;
const prepareApp = () => {
  const a = resolve(artifact);
  if (statSync(a).isDirectory() && !/\.app$/i.test(a)) appDir = a;
  else if (MAC) {
    if (/\.dmg$/i.test(a)) { const r = spawnSync("hdiutil", ["attach", "-readonly", "-nobrowse", "-noverify", "-mountpoint", P.dmg, a], { encoding: "utf8" }); if (r.status !== 0) throw new Error(`hdiutil attach: ${r.stderr}`); mountedDmg = true; const app = readdirSync(P.dmg).find((n) => n.endsWith(".app")); if (!app) throw new Error("no .app in dmg"); execFileSync("ditto", [join(P.dmg, app), join(P.app, app)]); spawnSync("hdiutil", ["detach", P.dmg, "-force"]); mountedDmg = false; appDir = join(P.app, app); }
    else if (/\.app$/i.test(a)) { execFileSync("ditto", [a, join(P.app, basename(a))]); appDir = join(P.app, basename(a)); }
    else if (/\.zip$/i.test(a)) { execFileSync("ditto", ["-x", "-k", a, P.app]); appDir = join(P.app, readdirSync(P.app).find((n) => n.endsWith(".app"))); }
    else throw new Error(`unsupported mac artifact ${a}`);
    spawnSync("xattr", ["-dr", "com.apple.quarantine", appDir]);
    if (process.env.GATE_MAC_TCC_HOOK) { const h = spawnSync(process.env.GATE_MAC_TCC_HOOK, [appDir], { encoding: "utf8" }); log(`  MAC-CI-GATE TCC hook exit ${h.status}: ${(h.stdout + h.stderr).slice(-600)}`); if (h.status !== 0) throw new Error("MAC-CI-GATE: TCC grant hook failed"); } // MAC-CI-GATE: CI runner only (SIP off), grants Screen Recording + Accessibility by csreq to this copy
  } else if (WIN) {
    if (!sevenZip) throw new Error("7-Zip not found");
    if (/\.exe$/i.test(a)) { const stage = join(runRoot, "nsis"); mkdirSync(stage); x7(a, stage); const pd = join(stage, "$PLUGINSDIR"); const inner = readdirSync(pd).find((n) => /^app-64\.7z$/i.test(n)) ?? readdirSync(pd).find((n) => /^app-.*\.7z$/i.test(n)); if (!inner) throw new Error("no app-64.7z in installer"); x7(join(pd, inner), P.app); rmSync(stage, { recursive: true, force: true }); } else x7(a, P.app);
    appDir = P.app;
  } else {
    if (/\.AppImage$/i.test(a)) { const c = join(runRoot, "app.AppImage"); cpSync(a, c); chmodSync(c, 0o755); const r = spawnSync(c, ["--appimage-extract"], { cwd: P.app, encoding: "utf8", env: baseEnv }); if (r.status !== 0) throw new Error(`appimage extract: ${r.stderr}`); appDir = join(P.app, "squashfs-root"); }
    else if (/\.deb$/i.test(a)) { const r = spawnSync("dpkg-deb", ["-x", a, P.app], { encoding: "utf8" }); if (r.status !== 0) throw new Error(`dpkg-deb: ${r.stderr}`); appDir = findDir(P.app, (d) => existsSync(join(d, "resources", "app.asar"))) ?? P.app; }
    else if (/\.zip$/i.test(a) || /\.tar\.(gz|xz)$/i.test(a)) { const r = spawnSync("tar", ["-xf", a, "-C", P.app], { encoding: "utf8" }); if (r.status !== 0) throw new Error("extract failed"); appDir = findDir(P.app, (d) => existsSync(join(d, "resources", "app.asar"))) ?? P.app; }
    else throw new Error(`unsupported linux artifact ${a}`);
  }
  if (!MAC) appDir = findDir(appDir, (d) => existsSync(join(d, "resources", "app.asar")), 5) ?? appDir;
  resDir = MAC ? join(appDir, "Contents", "Resources") : join(appDir, "resources");
  exe = findExe(appDir); if (MAC) registeredApp = appDir;
};

// ---------------------------------------------------------------- engine CLIs: sign-in proof (boolean only) and versions
const cliPath = (e) => (e.bundled ? findBundled(e.cli) : which(e.cli));
const findBundled = (name) => { const names = WIN ? [`${name}.exe`] : [name]; let n = 0; const walk = (d, depth) => { if (depth < 0 || n > 8000) return null; let ents; try { ents = readdirSync(d, { withFileTypes: true }); } catch { return null; } for (const x of ents) { n++; if (x.isFile() && names.includes(x.name)) return join(d, x.name); } for (const x of ents) if (x.isDirectory()) { const r = walk(join(d, x.name), depth - 1); if (r) return r; } return null; }; return resDir ? walk(resDir, 7) : null; };
const versionOf = (bin) => { if (!bin) return null; const r = run(bin, ["--version"], { timeout: 20000 }); return r.status === 0 ? (r.stdout || r.stderr).trim().split(/\r?\n/)[0].slice(0, 80) : null; };
const strip = (t) => String(t ?? "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
const PROBES = {
  claude: (bin) => { const r = run(bin, ["auth", "status", "--json"]); try { return JSON.parse(r.stdout).loggedIn === true; } catch { return false; } },
  codex: (bin) => { const r = run(bin, ["login", "status"]); const t = r.stdout + r.stderr; return r.status === 0 && /logged in/i.test(t) && !/not logged in/i.test(t); },
  // Bundled Fuigo in a Flux deployment has no subscription sign-in ("Sign-in is not available for this deployment"): it runs on the Flux key Murage hands it, so the Flux test key file is its sign-in.
  fuigo: (bin) => { /* FUIGO-PROBE-FIX 2026-10-21: fuigo >=1.0.31 requires --provider for `login --status` (rc 2 otherwise) and prints "<provider>: signed out"; bundled fuigo has no OAuth issuer and runs on the Flux key, so signed-out on both providers + Flux key file = ready */ { const env = { ...baseEnv, FUIGO_HOME: join(GATE_HOME, ".fuigo") }; let any = false, out = ""; for (const p of ["chatgpt", "xai"]) { const q = run(bin, ["login", "--status", "--provider", p], { env }); const u = q.stdout + q.stderr; out += u; if (q.status === 0 && /signed in|logged in/i.test(u) && !/signed out|not (signed|logged)/i.test(u)) any = true; } if (any) return true; if (/signed out/i.test(out)) return existsSync(fluxKeyFile); } const r = run(bin, ["login", "--status"], { env: { ...baseEnv, FUIGO_HOME: join(GATE_HOME, ".fuigo") } }); const t = r.stdout + r.stderr; if (/not available for this deployment/i.test(t)) return existsSync(fluxKeyFile); return r.status === 0 && /subscription|chatgpt|xai|signed in|logged in/i.test(t) && !/not (signed|logged)|no credential/i.test(t); },
  // Sign-in checks for the other engines. All fail closed (false unless positively signed in), none logs in, none reads a credential file (file checks stat names/sizes only).
  // Verified unsigned on the Linux gate box 2026-10-21: grok models -> "You are not authenticated." (rc 0); kimi provider list -> "No providers configured."; cursor-agent status -> "Not logged in"; opencode auth list -> "0 credentials"; agy models -> rc 1 "Please sign in"; openclaw models status --check -> rc 1; pi auth.json is 2 bytes ("{}") when empty.
  grokcli: (bin) => { const r = run(bin, ["models"], { timeout: 30000 }); const t = strip(r.stdout + r.stderr); return r.status === 0 && /available models/i.test(t) && !/not authenticated|not logged in|sign in|log ?in/i.test(t); },
  kimi: (bin) => { const r = run(bin, ["provider", "list"], { timeout: 30000 }); const t = strip(r.stdout + r.stderr).trim(); return r.status === 0 && t.length > 0 && !/no providers|not logged in|sign in|log ?in|error/i.test(t); },
  droid: () => { const d = join(GATE_HOME, ".factory"); try { return readdirSync(d).some((n) => /^auth\.v2\./.test(n) && statSync(join(d, n)).size > 2); } catch { return false; } }, // no status subcommand: presence + size only
  cursor: (bin) => { const r = run(bin, ["status"], { timeout: 30000 }); const t = strip(r.stdout + r.stderr); return r.status === 0 && /logged in|signed in/i.test(t) && !/not (logged|signed) in/i.test(t); },
  opencode: (bin) => { const r = run(bin, ["auth", "list"], { timeout: 30000 }); const t = strip(r.stdout + r.stderr); const m = /(\d+)\s+credentials?/i.exec(t); return r.status === 0 && Boolean(m) && Number(m[1]) > 0; },
  antigravity: (bin) => { const r = run(bin, ["models"], { timeout: 30000 }); const t = strip(r.stdout + r.stderr); return r.status === 0 && t.trim().length > 0 && !/sign in|not (logged|signed)|log ?in|error/i.test(t); },
  pi: () => { try { return statSync(join(GATE_HOME, ".pi", "agent", "auth.json")).size > 2; } catch { return false; } }, // "pi auth check" needs a provider; empty store is the 2-byte "{}"; size only, never contents
  openclaw: (bin) => { const r = run(bin, ["models", "status", "--check"], { timeout: 45000 }); return r.status === 0; }, // exit 1 = missing/expired/unavailable/indeterminate, 2 = expiring (still signed in but not clean: treated as not ready)
};
const updateCli = (key) => {
  const out = [];
  if (key === "claude") { const r = run(which("claude") ?? "claude", ["update"], { timeout: 240000 }); out.push(`claude update -> ${r.status}`); }
  else if (key === "codex") { const r = run(WIN ? "npm.cmd" : "npm", ["install", "-g", "--prefix", P.npm, "@openai/codex@latest"], { timeout: 300000 }); out.push(`npm codex@latest -> ${r.status}`); }
  else if (key === "fuigo") { const r = run(WIN ? "npm.cmd" : "npm", ["install", "-g", "--prefix", P.npm, "fuigo@latest"], { timeout: 300000 }); out.push(`npm fuigo@latest -> ${r.status}`); }
  return out;
};

// ---------------------------------------------------------------- config.json + launch
const fluxKeyFile = opt("--flux-key-file", join(GATE, "secrets", "flux-test.key"));
let fluxKey = null, fluxChecked = null;
const loadFluxKey = async () => { // account guard: must be 052be274, never 63c3bfa0. Fail closed. Prints nothing from the key or the response.
  if (fluxChecked !== null) return fluxChecked;
  try {
    if (!existsSync(fluxKeyFile)) return (fluxChecked = { ok: false, why: `no Flux test key file at ${fluxKeyFile}` });
    fluxKey = readFileSync(fluxKeyFile, "utf8").trim();
    const r = await fetch("https://api.fluxrouter.ai/key/info", { headers: { authorization: `Bearer ${fluxKey}` } });
    const text = await r.text();
    if (text.includes("63c3bfa0")) { fluxKey = null; return (fluxChecked = { ok: false, why: "key belongs to the FORBIDDEN account 63c3bfa0" }); }
    if (!text.includes("052be274")) { fluxKey = null; return (fluxChecked = { ok: false, why: `key/info (HTTP ${r.status}) does not name account 052be274; refusing (fail closed)` }); }
    return (fluxChecked = { ok: true });
  } catch (e) { fluxKey = null; return (fluxChecked = { ok: false, why: `key check failed: ${String(e).slice(0, 80)}` }); }
};
const seed = (key, e) => {
  let terms = "2026-10-10";
  try { const stack = [join(resDir, "server")]; let n = 0; while (stack.length && n < 4000) { const d = stack.pop(); for (const x of readdirSync(d, { withFileTypes: true })) { n++; if (x.isDirectory()) { if (x.name !== "node_modules") stack.push(join(d, x.name)); } else if (/^terms.*\.js$/i.test(x.name)) { const m = /TERMS_VERSION\s*=\s*"([^"]+)"/.exec(readFileSync(join(d, x.name), "utf8")); if (m) { terms = m[1]; stack.length = 0; break; } } } } } catch { /* default */ }
  const inst = { driver: e.driver, displayName: `Gate ${key}`, environment: {}, config: {} };
  if (e.auth !== "none" && !e.bundled && e.cli && NIGHTLY === false) { /* PATH resolves the gate CLI */ }
  if (key === "fuigo") { inst.environment.FUIGO_HOME = join(GATE_HOME, ".fuigo"); if (NIGHTLY) { const c = which("fuigo"); if (c) inst.config.cli = c; } }
  if (key === "opencode" && e.auth === "flux") { // OpenCode's OWN config (the gate account's), an OpenAI-compatible provider on the Flux TEST key by file reference: the key is never copied
    const dir = join(GATE_HOME, ".config", "opencode"); mkdirSync(dir, { recursive: true }); const f = join(dir, "opencode.json");
    let conf = {}; try { conf = JSON.parse(readFileSync(f, "utf8")); } catch { /* new */ }
    conf.$schema ??= "https://opencode.ai/config.json"; conf.provider ??= {};
    conf.provider.fluxgate = { npm: "@ai-sdk/openai-compatible", name: "Flux (gate test key)", options: { baseURL: "https://api.fluxrouter.ai/v1", apiKey: `{file:${fluxKeyFile}}` }, models: { "flux-auto": { name: "Flux Auto" } } };
    writeFileSync(f, JSON.stringify(conf, null, 2), { mode: 0o600 });
  }
  if (e.driver === "openai-compat") { inst.config.url = "https://api.fluxrouter.ai/v1"; inst.config.key = fluxKey; inst.config.apiKeyEnv = "OPENAI_COMPAT_API_KEY"; }
  const cfg = { engineDiscovery: "explicit", instances: { [key]: inst } };
  if (JOURNEYS.includes("browser")) cfg.features = { browser: true }; // workspace switch for the built-in browser (server/config.ts builtInBrowserEnabled)
  if ((e.auth === "flux" || (key === "fuigo" && process.env.GATE_FUIGO_ON_FLUX === "1") /* MAC-CI-GATE: bundled fuigo runs on the Flux test key */) && fluxKey) cfg.flux = { apiKey: fluxKey };
  writeFileSync(join(P.data, "config.json"), JSON.stringify(cfg, null, 2), { mode: 0o600 });
  writeFileSync(join(P.data, "terms-acceptance.json"), JSON.stringify({ accepted: [{ version: terms, acceptedAt: new Date().toISOString() }] }));
  writeFileSync(join(P.userData, "companion-settings.json"), JSON.stringify({ enabled: false, remoteAccess: false, keepAwake: false }));
};
let electron, app, page, origin, api; const mainPids = [];
// Ubuntu 23.10+ restricts unprivileged user namespaces through AppArmor. The .deb's postinst installs a profile for /opt/Murage/murage only;
// a COPY run from the gate run root has none, so the bundled chrome-headless-shell dies with "No usable sandbox!" (measured 2026-10-21).
// --linux-browser-sandbox shim (default when the restriction is on and no murage profile is loaded) hands the app, via the
// AGENT_BROWSER_EXECUTABLE_PATH it already honours (server/browser-engine.ts:455), a one-line wrapper that execs the BUNDLED chrome with
// --no-sandbox. It is a recorded deviation (summary.deviations); "--linux-browser-sandbox none" runs exactly as shipped.
const deviations = [];
const browserShim = () => {
  if (!LINUX || !resDir) return null;
  const mode = opt("--linux-browser-sandbox", "auto"); if (mode === "none") return null;
  let restricted = false; try { restricted = readFileSync("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "utf8").trim() === "1"; } catch { /* old kernel */ }
  if (mode === "auto" && (!restricted || existsSync("/etc/apparmor.d/murage"))) return null;
  const chrome = join(resDir, "browser-engine", "chrome", "chrome-headless-shell-linux64", "chrome-headless-shell"); if (!existsSync(chrome)) return null;
  const f = join(P.bin, "gate-chrome-nosandbox"); writeFileSync(f, `#!/bin/sh\nexec '${chrome.replaceAll("'", "")}' --no-sandbox "$@"\n`, { mode: 0o755 });
  if (!deviations.length) deviations.push({ what: "Linux bot browser runs the bundled chrome-headless-shell with --no-sandbox", why: "AppArmor restricts unprivileged userns on this host and the extracted copy has no AppArmor profile (an installed .deb loads one for /opt/Murage/murage only)", restricted });
  return f;
};
const appEnv = () => ({ ...baseEnv, ...(WN ? WN.launchEnvCanaries(NOGIT_NONCE) : {}), ...(browserShim() ? { AGENT_BROWSER_EXECUTABLE_PATH: browserShim() } : {}), MURAGE_DATA_DIR: P.data, MURAGE_USER_DATA: P.userData, MURAGE_PORT: String(PORT), MURAGE_GATE_MCP_RECORD: MCP_RECORD, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" });
const launch = async () => {
  const args = [`--user-data-dir=${P.userData}`, "--disable-gpu", ...(LINUX ? ["--no-sandbox"] : [])];
  const tL = Date.now(); app = await electron.launch({ executablePath: exe, args, cwd: runRoot, env: appEnv(), timeout: 90000 });
  mainPids.push(app.process().pid); if (WN) { try { mainCreate.set(app.process().pid, Number(ps(`[int64](((Get-Process -Id ${app.process().pid}).StartTime.ToUniversalTime()) - [datetime]'1970-01-01').TotalMilliseconds`).trim())); } catch { /* window file retries */ } }
  page = await until(async () => { for (const w of [...app.windows()].reverse()) { try { if (!w.isClosed() && /^http:\/\/127\.0\.0\.1:/.test(w.url())) { await w.waitForFunction(() => typeof window.muragebox?.desktopSurfaceSecret === "string" && window.muragebox.desktopSurfaceSecret.length > 0, null, { timeout: 4000 }); return w; } } catch { /* next */ } } return false; }, 150000, "a window on the local server with the owner proof", 1000);
  page.setDefaultTimeout(30000); origin = new URL(page.url()).origin; log(`  app ready in ${((Date.now() - tL) / 1000).toFixed(1)}s on ${origin}`);
  api = (method, path, body) => page.evaluate(async ({ method, path, body }) => { const r = await fetch(path, { method, headers: { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": window.muragebox.desktopSurfaceSecret }, body: body === undefined ? undefined : JSON.stringify(body) }); let b = null; try { b = await r.json(); } catch { /* none */ } return { status: r.status, body: b }; }, { method, path, body });
};
const quit = async () => { try { await app?.close(); } catch { /* gone */ } app = null; await until(() => ownedPids().length === 0, 40000, "app processes exit").catch(() => killOwned()); };

// ---------------------------------------------------------------- domain helpers
const BAD = /Reply withheld|deleted or changed|Reply left out|still being checked|no answer|Checking this reply|Available MCP tools: none/i;
const enableLinuxLocalControl = async () => {
  let st = await page.evaluate(async () => { const lc = window.muragebox?.localControl; if (!lc) return { error: "no localControl in preload" }; const s = await lc.status(); if (s?.status === "ready") return s; try { return await lc.enable(); } catch (e) { return { error: String(e).slice(0, 200) }; } });
  for (let i = 0; i < 30 && st?.status !== "ready" && !st?.error && st?.status !== "unavailable"; i++) { await sleep(1000); st = await page.evaluate(() => window.muragebox.localControl.status()); }
  return st;
};
// After a timed-out turn: stop it the way the Stop button does (POST /api/bots/:id/interrupt {threadId}) so the next journey starts on an idle bot.
const settle = async (botId) => { try { const b = await getBot(botId); if (!b?.busy) return true; await api("POST", `/api/bots/${botId}/interrupt`, { threadId: b.threadId }); await until(async () => !(await getBot(botId))?.busy, 45000, "bot idle after Stop", 1000); return true; } catch { return false; } };
const getBot = async (id) => (await api("GET", "/api/bots")).body.bots.find((b) => b.id === id);
const msgKey = (b, m) => `${b.threadId}:${m.id}`;
const seenOf = (b) => new Set((b.messages ?? []).map((m) => msgKey(b, m)));
const botText = (b, seen) => (b.messages ?? []).filter((m) => !seen.has(msgKey(b, m)) && m.role === "bot" && m.kind === "text" && String(m.text ?? "").length > 0);
const ask = async (botId, text, ms, pred) => { // send, wait for a bot text reply (optionally satisfying pred); returns {reply, rows}
  const before = seenOf(await getBot(botId)); const r = await api("POST", `/api/bots/${botId}/messages`, { text });
  if (r.status !== 202) throw new Error(`message not accepted: ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  let last; try { await until(async () => { const b = await getBot(botId); last = b; return !b.busy && botText(b, before).some((m) => !pred || pred(String(m.text))); }, ms, `reply to "${text.slice(0, 40)}"`, 1000); }
  catch (err) { const tail = (last?.messages ?? []).slice(-8).map((m) => `${m.role}/${m.kind}${m.tool?.name ? ":" + m.tool.name : ""}${m.card ? " card:" + JSON.stringify({ q: m.card.question ?? m.card.title, answered: m.card.answered, held: m.card.held }).slice(0, 160) : ""}: ${String(m.text ?? "").slice(0, 160)}`); const stopped = await settle(botId); throw new Error(`${err.message}; stopped=${stopped}; busy=${last?.busy} status=${JSON.stringify(last?.status ?? last?.state ?? null).slice(0, 120)}; last rows: ${JSON.stringify(tail)}`); }
  const rows = (last.messages ?? []).filter((m) => !before.has(msgKey(last, m)));
  return { reply: botText(last, before).filter((m) => !pred || pred(String(m.text))).pop(), rows, bot: last };
};
const applogTail = () => { const d = join(P.userData, "logs"); return existsSync(d) ? readdirSync(d).map((f) => { try { return readFileSync(join(d, f), "utf8").slice(-80000); } catch { return ""; } }).join("\n") : ""; };
const EXPECT_MCP = ["muragebox", "computer", "agents", "murage-memory", "browser"];
const okStatus = (v) => v === true || (typeof v === "string" && /^(connected|ready|ok|running|up)$/i.test(v)) || (v && typeof v === "object" && okStatus(v.status ?? v.state ?? v.connected));
const mcpConnected = () => { // reads the gate-only record the driver writes per turn (MURAGE_GATE_MCP_RECORD); returns {have, missing, engineWord}
  if (!existsSync(MCP_RECORD)) return { have: false };
  const lines = readFileSync(MCP_RECORD, "utf8").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const ok = new Set();
  for (const l of lines) { const s = l.servers ?? l.mcpServers ?? l.status ?? l; if (Array.isArray(s)) for (const x of s) { if (okStatus(x.status ?? x.state ?? x.connected)) ok.add(x.name ?? x.server); } else if (s && typeof s === "object") for (const [k, v] of Object.entries(s)) if (okStatus(v)) ok.add(k); }
  return { have: lines.length > 0, missing: EXPECT_MCP.filter((n) => !ok.has(n)), connected: [...ok], lines: lines.length };
};

// ---------------------------------------------------------------- browser and computer journeys (--journeys browser,computer; design: ../REAL-ENGINE-GATE.md section 10)
// Every journey is a real turn of a real engine in the packaged app. Pass conditions are observed OUTSIDE the model's words wherever possible:
// the harness's own local static site records which pages were fetched (with cookies and user agent), and the owner browser API
// (/api/bots/:id/browser, the same route the Browser panel calls) reports the lock / hold state. Test pages are served only from
// 127.0.0.1 inside this process; nothing on the open web is used.
const J_NOTE = { // engines whose driver mounts no built-in browser / host computer (capability flags at 234377c31). They still run; the note explains a FAIL.
  browser: { "openai-compat": "openai-compat is text-only (no tool loop)", openclaw: "openclawAgent ownTools: Murage hands it no MCP servers (acp/core.ts capability flags)", antigravity: "antigravity: browserMcp not set (antigravity.ts:937)", pi: "pi: browserMcp not set (pi.ts:1421-1432)" },
  computer: { "openai-compat": "openai-compat is text-only (no tool loop)", openclaw: "openclawAgent ownTools: no computer MCP", antigravity: "antigravity: computer only when fullAuto (antigravity.ts:937)" },
};
let site = null;
const startSite = async () => {
  if (site) return site;
  const hits = [];
  const n = {};
  const page = (res, title, body, headers = {}) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers }); res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font:20px sans-serif;margin:24px}button{font-size:40px;padding:40px 60px}</style></head><body>${body}</body></html>`); };
  const server = createServer((req, res) => {
    let u; try { u = new URL(req.url, "http://127.0.0.1"); } catch { res.writeHead(400); return res.end(); }
    const ua = String(req.headers["user-agent"] ?? "");
    hits.push({ path: u.pathname, q: Object.fromEntries(u.searchParams), cookie: String(req.headers.cookie ?? "").slice(0, 200), headless: /HeadlessChrome/i.test(ua), t: Date.now() });
    switch (u.pathname) {
      case "/title.html": return page(res, `GATE-TITLE-${n.title}`, "<h1>Gate test page</h1><p>The answer is the title of this page.</p>");
      case "/login.html": return page(res, "Sign in", `<h1>Sign in</h1><p>Account code: LEAK-${n.leak}</p><form onsubmit="return false"><label>Email <input name="email" type="email"></label><br><label>Password <input name="password" type="password" autocomplete="current-password"></label><br><button>Sign in</button></form>`);
      case "/after.html": return page(res, `GATE-AFTER-${n.after}`, "<h1>After hand-back</h1>");
      case "/reopen.html": return page(res, `GATE-REOPEN-${n.reopen}`, "<h1>After reopen</h1>");
      case "/set-cookie": return page(res, `COOKIE-SET-${n.cookie}`, "<h1>Preference saved</h1>", { "set-cookie": `gate_pref=${n.cookie}; Max-Age=2592000; Path=/; SameSite=Lax` });
      case "/read-cookie": { const m = /(?:^|;\s*)gate_pref=([A-Z0-9]+)/.exec(String(req.headers.cookie ?? "")); return page(res, `COOKIE-${m ? m[1] : "NONE"}`, "<h1>Your saved preference is in the title</h1>"); }
      case "/target.html": { const t = String(u.searchParams.get("n") ?? "").replace(/[^A-Z0-9]/g, "").slice(0, 12); return page(res, `GATE-TARGET-${t}`, `<p>GATE-TARGET-${t}</p><button id="b" aria-label="PRESS-${t}" onclick="fetch('/clicked?n=${t}').then(()=>{this.textContent='CLICKED-${t}';document.title='CLICKED-${t}'})">PRESS-${t}</button>`); }
      case "/clicked": res.writeHead(204, { "cache-control": "no-store" }); return res.end();
      default: res.writeHead(404); return res.end();
    }
  });
  await new Promise((r, j) => { server.once("error", j); server.listen(0, "127.0.0.1", r); });
  site = { server, hits, n, base: `http://127.0.0.1:${server.address().port}`, arm: () => { for (const k of ["title", "leak", "after", "reopen", "cookie"]) n[k] = randomBytes(3).toString("hex").toUpperCase(); }, seen: (path, since, pred = () => true) => hits.filter((h) => h.path === path && h.t >= since && pred(h)) };
  return site;
};
// Target window for computer use: a HEADED Chromium (playwright build, installed user-space into GATE/pw-browsers) showing the
// local target page. Its profile lives OUTSIDE the run root so quit() (which waits for every process naming the run root) never waits on it.
let targetProc = null; const targetRoot = join(GATE, `capgate-target-${basename(runRoot)}`);
const chromiumPath = () => { const root = join(GATE, "pw-browsers"); let dirs = []; try { dirs = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse(); } catch { return null; }
  for (const d of dirs) for (const rel of [["chrome-linux64", "chrome"], ["chrome-linux", "chrome"], ["chrome-mac-arm64", "Chromium.app", "Contents", "MacOS", "Chromium"], ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"], /* MAC-CI-GATE 2026-10-21: playwright >=1.57 ships Chrome for Testing on mac */ ["chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"], ["chrome-mac-x64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"], ["chrome-win64", "chrome.exe"], ["chrome-win", "chrome.exe"]]) { const f = join(root, d, ...rel); if (existsSync(f)) return f; }
  return null; };
const ensureChromium = () => { let p = chromiumPath(); if (p) return p; const cli = join(P.pw, "node_modules", "playwright-core", "cli.js"); run(process.execPath, [cli, "install", "chromium"], { timeout: 600000, env: { ...baseEnv, PLAYWRIGHT_BROWSERS_PATH: join(GATE, "pw-browsers") } }); return chromiumPath(); };
const openTarget = async (tn) => {
  closeTarget(); const bin = ensureChromium(); if (!bin) throw new Error("headed Chromium for the target window could not be installed into the gate dir");
  await sleep(500); rmSync(join(targetRoot, "profile"), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); mkdirSync(join(targetRoot, "profile"), { recursive: true });
  targetProc = spawn(bin, [`--app=${site.base}/target.html?n=${tn}`, `--user-data-dir=${join(targetRoot, "profile")}`, "--force-renderer-accessibility", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-position=80,80", "--window-size=700,420", ...(LINUX ? ["--no-sandbox"] : [])], { env: { ...baseEnv, ACCESSIBILITY_ENABLED: "1" }, stdio: "ignore", detached: false });
  await until(() => site.seen("/target.html", 0, (h) => h.q.n === tn && !h.headless).length > 0, 30000, "target window loaded its page");
  await sleep(1500);
};
const closeTarget = () => { if (targetProc && targetProc.exitCode === null) { try { targetProc.kill("SIGKILL"); } catch { /* gone */ } } targetProc = null; };

// One owner-API call to the bot's browser, exactly as the Browser panel makes it (UnifiedBrowserPanel.tsx action()).
const browserApi = async (botId, body) => api(body ? "POST" : "GET", `/api/bots/${encodeURIComponent(botId)}/browser`, body);
// A turn that also answers approval cards: decide(card) -> "allow" | "deny". Returns the reply, the new rows, every card seen and the tool names used.
const converse = async (botId, text, { ms = 180000, pred, decide = () => "allow" } = {}) => {
  const b0 = await getBot(botId); const before = seenOf(b0); const answered = new Set(); const cards = [];
  const r = await api("POST", `/api/bots/${botId}/messages`, { text });
  if (r.status !== 202) throw new Error(`message not accepted: ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  let last; const t0 = Date.now();
  await until(async () => {
    const b = await getBot(botId); last = b;
    for (const m of b.messages ?? []) {
      if (before.has(msgKey(b, m)) || m.kind !== "options" || !m.card?.requestId || m.card.answered || m.card.dismissed || answered.has(m.card.requestId)) continue;
      answered.add(m.card.requestId); const behavior = decide(m.card);
      const info = { at: Date.now() - t0, behavior, tool: m.card.tool ?? m.card.toolName ?? m.card.kind ?? null, title: String(m.card.title ?? m.card.question ?? m.text ?? "").slice(0, 120) };
      const a = await api("POST", `/api/bots/${botId}/respond`, { behavior, requestId: m.card.requestId, threadId: b.threadId });
      info.answer = a.status; info.t = Date.now(); cards.push(info);
    }
    return !b.busy && botText(b, before).some((m) => !pred || pred(String(m.text)));
  }, ms, `reply to "${text.slice(0, 50)}"`, 1000).catch(async (err) => { const stopped = await settle(botId); throw new Error(`${err.message}; stopped=${stopped}; cards=${JSON.stringify(cards.map((c) => c.tool))}`); });
  const rows = (last.messages ?? []).filter((m) => !before.has(msgKey(last, m)));
  const tools = rows.filter((m) => m.kind === "activity" && m.tool?.name).map((m) => `${m.tool.name}${m.tool.ok === false ? "(failed)" : ""}`);
  return { reply: botText(last, before).filter((m) => !pred || pred(String(m.text))).pop(), rows, cards, tools, bot: last };
};
// A journey whose turn timed out still reports what it saw: the last bot text and the tools used.
const lastWords = async (botId) => { try { const b = await getBot(botId); const ms = (b.messages ?? []).slice(-6); return { busy: b.busy, tail: ms.map((m) => `${m.role}/${m.kind}${m.tool?.name ? ":" + m.tool.name : ""}: ${String(m.text ?? "").slice(0, 140)}`) }; } catch (e) { return String(e).slice(0, 120); } };
const jstep = async (key, id, title, fn) => step(`${key}.${id}`, `${key}: ${title}`, fn);

const runJourneys = async (key, e, res, { bot, coreOk }) => {
  res.journeys = {};
  const ids = [...(JOURNEYS.includes("browser") ? ["B1", "B5", "B2", "B3", "B4", "B4b"] : []), ...(JOURNEYS.includes("computer") ? ["C1", "A1", "A2"] : [])];
  const blocked = (why) => { for (const id of ids) { current = { id: `${key}.${id}`, title: `${key}: ${id}`, status: "BLOCKED", checks: [{ ok: false, what: "blocked", detail: why }], ms: 0 }; results.push(current); res.journeys[id] = "BLOCKED"; } };
  if (!coreOk || !bot?.id) return blocked("step 1 (real turn) did not pass, so no journey could run on this engine");
  await startSite(); site.arm(); const N = site.n; const id = bot.id; const base = site.base;
  const done = (jid) => { res.journeys[jid] = results.at(-1).status; };
  const noteFor = (set) => (J_NOTE[set][key] ? note("engine capability", J_NOTE[set][key]) : undefined);
  const bstatus = async () => (await browserApi(id)).body;
  if (JOURNEYS.includes("browser")) {
    // B1: the bot opens a page and reads its title. Pass: reply has the title nonce AND the site served the page to a browser AND the owner API shows that URL.
    await jstep(key, "B1", "bot opens a local page and reads its title", async () => {
      noteFor("browser"); const t = Date.now();
      try {
        const { reply, cards, tools } = await converse(id, `Use your browser tool to open ${base}/title.html and reply with the exact title of that page.`, { pred: (x) => x.includes(`GATE-TITLE-${N.title}`) });
        check(Boolean(reply), `reply contains GATE-TITLE-${N.title}`, String(reply?.text).slice(0, 120));
        note("tools used", tools); note("approval cards at Ask for the browser", cards);
      } catch (err) { check(false, "turn finished with the title", { error: String(err).slice(0, 160), last: await lastWords(id) }); }
      check(site.seen("/title.html", t, (h) => h.headless).length > 0, "Murage's bot browser (headless) fetched /title.html", site.seen("/title.html", t).map((h) => (h.headless ? "headless" : "other client")));
      let s = null; for (let i = 0; i < 8; i++) { s = await bstatus(); if (String(s?.url ?? "").includes("/title.html")) break; await sleep(1000); }
      if (String(s?.url ?? "").includes("/title.html")) note("owner browser API shows the bot's page URL", s.url); else note("owner browser API url stayed empty (the panel's address bar would be blank; the site fetch above is the proof)", { url: s?.url, connected: s?.connected });
    }); done("B1");
    // B5: the bot's own browser profile keeps a cookie across an app restart. Pass: after relaunch the site RECEIVES the cookie set before the quit.
    await jstep(key, "B5", "bot browser profile (cookie) persists across an app restart", async () => {
      const t = Date.now();
      try { const { reply } = await converse(id, `Use your browser tool to open ${base}/set-cookie and reply with the exact title of that page.`, { pred: (x) => x.includes(`COOKIE-SET-${N.cookie}`) }); check(Boolean(reply), `before restart: reply contains COOKIE-SET-${N.cookie}`); }
      catch (err) { check(false, "before restart: set-cookie turn finished", { error: String(err).slice(0, 160), last: await lastWords(id) }); }
      check(site.seen("/set-cookie", t, (h) => h.headless).length > 0, "Murage's bot browser (headless) fetched /set-cookie");
      await quit(); check(ownedPids().length === 0, "app quit cleanly", ownedPids()); await launch(); const t2 = Date.now();
      try { const { reply } = await converse(id, `Use your browser tool to open ${base}/read-cookie and reply with the exact title of that page.`, { pred: (x) => /COOKIE-[A-Z0-9]+/.test(x) && !x.includes("COOKIE-SET") }); check(String(reply?.text).includes(`COOKIE-${N.cookie}`), `after restart: reply is COOKIE-${N.cookie} (not COOKIE-NONE)`, String(reply?.text).slice(0, 120)); }
      catch (err) { check(false, "after restart: read-cookie turn finished", { error: String(err).slice(0, 160), last: await lastWords(id) }); }
      const got = site.seen("/read-cookie", t2); check(got.some((h) => h.cookie.includes(`gate_pref=${N.cookie}`)), "after restart the bot's browser SENT the cookie it saved before the restart", got.map((h) => h.cookie));
    }); done("B5");
    // B2: a page with a password field locks the browser. Pass: owner API reports protectedDocument + sensitive-page; the secret on that page never reaches the reply.
    await jstep(key, "B2", "a local page with a password field triggers the page lock", async () => {
      const t = Date.now(); let replyText = "";
      try { const { reply, tools } = await converse(id, `Use your browser tool to open ${base}/login.html and tell me the account code shown on that page.`, { ms: 180000 }); replyText = String(reply?.text ?? ""); note("tools used", tools); note("bot reply", replyText.slice(0, 200)); }
      catch (err) { check(false, "turn finished", { error: String(err).slice(0, 160), last: await lastWords(id) }); }
      check(site.seen("/login.html", t, (h) => h.headless).length > 0, "the bot's browser fetched /login.html");
      const s = await bstatus(); check(s?.protectedDocument === true && s?.protectedReason === "sensitive-page", "owner API: page locked (protectedDocument, reason sensitive-page)", { protectedDocument: s?.protectedDocument, protectedReason: s?.protectedReason, url: s?.url });
      check(!replyText.includes(`LEAK-${N.leak}`), "the locked page's content did not reach the bot's reply");
    }); done("B2");
    // B3: the human takes control through the panel's API, returns it, and the bot reads a NEW page. This is Sean's 1.0.3 hand-back path.
    await jstep(key, "B3", "take control, return to bot, bot reads a new page", async () => {
      const take = await browserApi(id, { action: "take" });
      if (!check(take.status === 200 && take.body?.held === true && take.body?.owned === true, "Take control -> 200, held by this owner", { status: take.status, body: take.body })) return;
      const rel = await browserApi(id, { action: "release", generation: take.body.generation });
      if (!check(rel.status === 200 && rel.body?.held === false, "Return to bot -> 200, no longer held", { status: rel.status, body: rel.body })) return;
      const t = Date.now();
      try { const { reply, tools } = await converse(id, `Use your browser tool to open ${base}/after.html and reply with the exact title of that page.`, { pred: (x) => x.includes(`GATE-AFTER-${N.after}`) }); check(Boolean(reply), `bot reply contains GATE-AFTER-${N.after}`); note("tools used", tools); }
      catch (err) { check(false, "bot turn after hand-back finished with the new title", { error: String(err).slice(0, 160), last: await lastWords(id) }); }
      check(site.seen("/after.html", t, (h) => h.headless).length > 0, "the bot's browser fetched /after.html after the hand-back");
      const s = await bstatus(); check(s?.held === false && s?.protectedDocument === false, "owner API: bot control, page not locked", { held: s?.held, protectedDocument: s?.protectedDocument, url: s?.url });
    }); done("B3");
    // B4: Sean's 1.0.3 sequence exactly: the password page locks, Take control, Reopen blank page, Return to bot; the bot reads a new page.
    await jstep(key, "B4", "password page lock, take control, Reopen blank page, return to bot, bot reads a new page", async () => {
      try { await converse(id, `Use your browser tool to open ${base}/login.html and tell me what kind of page it is.`, { ms: 180000 }); } catch (err) { check(false, "lock turn finished", { error: String(err).slice(0, 160) }); }
      const locked = await bstatus(); check(locked?.protectedDocument === true, "page locked before the hand-back", { protectedReason: locked?.protectedReason });
      const take = await browserApi(id, { action: "take" });
      if (!check(take.status === 200 && take.body?.held === true, "Take control -> 200", { status: take.status, body: take.body })) return;
      const ro = await browserApi(id, { action: "reopen", generation: take.body.generation });
      if (!check(ro.status === 200 && ro.body?.protectedDocument === false, "Reopen blank page -> 200, lock cleared", { status: ro.status, body: ro.body })) { const bail = await bstatus(); if (bail?.held) await browserApi(id, { action: "release", generation: bail.generation }); return; }
      const rel = await browserApi(id, { action: "release", generation: ro.body.generation });
      if (!check(rel.status === 200 && rel.body?.held === false, "Return to bot -> 200", { status: rel.status, body: rel.body })) return;
      N.reopen = randomBytes(3).toString("hex").toUpperCase(); const t = Date.now();
      try { const { reply } = await converse(id, `Use your browser tool to open ${base}/reopen.html and reply with the exact title of that page.`, { pred: (x) => x.includes(`GATE-REOPEN-${N.reopen}`) }); check(Boolean(reply), `bot reply contains GATE-REOPEN-${N.reopen}`); }
      catch (err) { check(false, "bot turn after reopen finished with the new title", { error: String(err).slice(0, 160), last: await lastWords(id) }); }
      check(site.seen("/reopen.html", t, (h) => h.headless).length > 0, "the bot's browser fetched /reopen.html after the reopen");
    }); done("B4");
    // B4b: the human clicks in the page (owner-input lock), then Reopen blank page, then Return to bot; the bot reads a new page.
    await jstep(key, "B4b", "owner input locks the page, Reopen blank page, return to bot, bot reads a new page", async () => {
      N.reopen = randomBytes(3).toString("hex").toUpperCase();
      const take = await browserApi(id, { action: "take" });
      if (!check(take.status === 200 && take.body?.held === true, "Take control -> 200", { status: take.status, body: take.body })) return;
      let g = take.body.generation;
      for (const eventType of ["mousePressed", "mouseReleased"]) { const r = await browserApi(id, { action: "input", generation: g, event: { type: "input_mouse", eventType, x: 200, y: 200, button: "left", clickCount: 1 } }); if (r.body?.generation) g = r.body.generation; if (!check(r.status === 200, `owner ${eventType} accepted`, { status: r.status, body: r.body })) return; }
      const locked = await bstatus(); check(locked?.protectedDocument === true && locked?.protectedReason === "owner-input", "owner API: page locked by owner input", { protectedReason: locked?.protectedReason });
      const ro = await browserApi(id, { action: "reopen", generation: locked?.generation ?? g });
      if (!check(ro.status === 200 && ro.body?.protectedDocument === false, "Reopen blank page -> 200, lock cleared", { status: ro.status, body: ro.body })) { const bail = await bstatus(); if (bail?.held) await browserApi(id, { action: "release", generation: bail.generation }); return; }
      const rel = await browserApi(id, { action: "release", generation: ro.body.generation });
      if (!check(rel.status === 200 && rel.body?.held === false, "Return to bot -> 200", { status: rel.status, body: rel.body })) return;
      const t = Date.now();
      try { const { reply } = await converse(id, `Use your browser tool to open ${base}/reopen.html and reply with the exact title of that page.`, { pred: (x) => x.includes(`GATE-REOPEN-${N.reopen}`) }); check(Boolean(reply), `bot reply contains GATE-REOPEN-${N.reopen}`); }
      catch (err) { check(false, "bot turn after reopen finished with the new title", { error: String(err).slice(0, 160), last: await lastWords(id) }); }
      check(site.seen("/reopen.html", t, (h) => h.headless).length > 0, "the bot's browser fetched /reopen.html after the reopen");
    }); done("B4b");
  }
  if (JOURNEYS.includes("computer")) {
    const enableLocal = async () => { // the same preload call the Computer settings make (window.muragebox.localControl, Linux only)
      if (!LINUX) { let s = null; try { s = await page.evaluate(async () => (window.muragebox?.localControl ? await window.muragebox.localControl.status() : { error: "no localControl in preload" })); } catch (err) { s = { error: String(err).slice(0, 160) }; } return { platform: OS, status: s?.status, localControl: s, note: "Mac: the embedded Cua Driver needs Screen Recording + Accessibility granted to Murage.app for the gate user (console, once)" }; } // MAC-CI-GATE: record the Mac Cua status (info only)
      return enableLinuxLocalControl();
    };
    const target = (tn) => (h) => h.q.n === tn && !h.headless; // a click from the HEADED target window, never the bot's headless browser
    const computerTurn = (tn) => `Use your computer tools on this computer's screen, not the browser tool. Take a screenshot, find the window titled GATE-TARGET-${tn}, and click the large button labelled PRESS-${tn} in it. Then take another screenshot and reply with the text the button shows now.`;
    let ready = false;
    await jstep(key, "C1", "computer use at Ask: screenshot + click on a known target window, every action approved", async () => {
      noteFor("computer");
      const st = await enableLocal(); ready = !LINUX || st?.status === "ready"; check(ready, "Linux local control (Cua Driver) enabled and ready via window.muragebox.localControl", st);
      const p = await api("PATCH", `/api/bots/${id}`, { computer: "local", autoApprove: false }); check(p.status === 200, "bot set to this computer, access level Ask", p.status);
      const tn = randomBytes(3).toString("hex").toUpperCase(); await openTarget(tn); const t = Date.now();
      try {
        const { reply, cards, tools } = await converse(id, computerTurn(tn), { ms: 300000, pred: (x) => x.includes(`CLICKED-${tn}`) || x.length > 0, decide: () => "allow" });
        note("tools used", tools); note("approval cards", cards); note("bot reply", String(reply?.text).slice(0, 200));
        const clicks = site.seen("/clicked", t, target(tn));
        check(clicks.length > 0, "the target window's button was really clicked (the site saw the click from the headed window)", clicks.length);
        check(tools.some((x) => /screenshot|get_window_state|screen/i.test(x)), "a screenshot / screen-state tool ran", tools);
        check(cards.length > 0, "Ask: host-computer actions raised approval cards", cards.length);
        check(!clicks.length || cards.some((c) => c.t <= clicks[0].t), "Ask: no click happened before an approval was given", { firstCard: cards[0]?.t, firstClick: clicks[0]?.t });
      } catch (err) { check(false, "computer turn finished", { error: String(err).slice(0, 160), last: await lastWords(id), clicks: site.seen("/clicked", t).length }); }
    }); done("C1");
    await jstep(key, "A1", "approval at Ask: denying the card stops the action", async () => {
      const tn = randomBytes(3).toString("hex").toUpperCase(); await openTarget(tn); const t = Date.now();
      try {
        const { cards, reply } = await converse(id, computerTurn(tn), { ms: 240000, decide: () => "deny" });
        note("cards (all denied)", cards); note("bot reply", String(reply?.text).slice(0, 200));
        check(cards.length > 0, "Ask: an approval card appeared", cards.length);
      } catch (err) { check(false, "turn finished after the denial (did not hang)", { error: String(err).slice(0, 160), last: await lastWords(id) }); }
      check(site.seen("/clicked", t, target(tn)).length === 0, "denied: the target button was NOT clicked");
    }); done("A1");
    await jstep(key, "A2", "approval at Auto: screenshot + click run without a card", async () => {
      const p = await api("PATCH", `/api/bots/${id}`, { computer: "local", autoApprove: true, acknowledgeLocalAuto: true }); check(p.status === 200, "bot set to Auto (with the local-Auto acknowledgement the panel sends)", { status: p.status, body: p.status === 200 ? undefined : p.body });
      const tn = randomBytes(3).toString("hex").toUpperCase(); await openTarget(tn); const t = Date.now();
      try {
        const { cards, tools, reply } = await converse(id, computerTurn(tn), { ms: 300000, pred: (x) => x.length > 0, decide: () => "allow" });
        note("tools used", tools); note("bot reply", String(reply?.text).slice(0, 200));
        check(site.seen("/clicked", t, target(tn)).length > 0, "Auto: the target button was clicked");
        check(cards.length === 0, "Auto: no approval card for ordinary screenshot / click actions", cards);
      } catch (err) { check(false, "computer turn at Auto finished", { error: String(err).slice(0, 160), last: await lastWords(id) }); }
      await api("PATCH", `/api/bots/${id}`, { autoApprove: false });
    }); done("A2");
    closeTarget();
  }
};

// ---------------------------------------------------------------- win-nogit turns (WIN-NOBASH-DESIGN-r2.md section 5 step 4; claude only)
// The hand is read from MURAGE_GATE_MCP_RECORD: names + salted SHA-256 + length, never values (salt in the record); canaries are compared by hashing.
// Process base table and 4688 events are Administrator-only on that box: run-gate.sh collects them in a SEPARATE, read-only Administrator ssh
// session (win-nogit-admin.mjs). This harness writes the run window + main pids for it. Engine turns never run as Administrator.
const inheritAddsFromBuild = () => { // CLAUDE_INHERIT_ADDS["2.1.305"] from the BUILT app's claude.ts (text parse; repo code is never executed)
  const f = [join(resDir, "server", "drivers", "claude.ts"), join(resDir, "app.asar.unpacked", "server", "drivers", "claude.ts")].find((x) => existsSync(x));
  const src = f ? readFileSync(f, "utf8") : (() => { try { return readFileSync(join(resDir, "app.asar")).toString("latin1"); } catch { return ""; } })();
  const i = src.indexOf("CLAUDE_INHERIT_ADDS"); if (i < 0) return null;
  const m = /["']2\.1\.305["']\s*:\s*(?:Object\.freeze\()?\[([^\]]*)\]/.exec(src.slice(i, i + 4000)); if (!m) return null;
  const names = [...m[1].matchAll(/["']([A-Z0-9_]+)["']/g)].map((x) => x[1]); return names.length ? names : null;
};
let hkcuAutoRunBefore = null; const AUTORUN_KEY = "HKCU\\Software\\Microsoft\\Command Processor";
const plantAutoRun = () => { const q = spawnSync("reg", ["query", AUTORUN_KEY, "/v", "AutoRun"], { encoding: "utf8", windowsHide: true }); hkcuAutoRunBefore = q.status === 0 ? (/AutoRun\s+REG_\w+\s+(.*)$/m.exec(q.stdout)?.[1] ?? "") : null; spawnSync("reg", ["add", AUTORUN_KEY, "/v", "AutoRun", "/t", "REG_SZ", "/d", WN.HKCU_AUTORUN_VALUE, "/f"], { windowsHide: true }); };
const restoreAutoRun = () => { if (!WN) return; if (hkcuAutoRunBefore === null) spawnSync("reg", ["delete", AUTORUN_KEY, "/v", "AutoRun", "/f"], { windowsHide: true }); else spawnSync("reg", ["add", AUTORUN_KEY, "/v", "AutoRun", "/t", "REG_SZ", "/d", hkcuAutoRunBefore, "/f"], { windowsHide: true }); };
const ENV_DUMP = 'Get-ChildItem env: | ForEach-Object { "$($_.Name)=$($_.Value)" }; Get-Location';
const runWinNogit = async (key, bot) => {
  const repoDir = join(runRoot, "repo"); mkdirSync(join(repoDir, ".claude"), { recursive: true });
  for (const [rel, body] of Object.entries(WN.repoSettingsCanaries(NOGIT_NONCE))) writeFileSync(join(repoDir, ...rel.split("/")), JSON.stringify(body, null, 2));
  const dumpTurn = async (title, { expectCard }) => step(`${key}.nogit.${title}`, `${key}: win-nogit turn ${title}`, async () => {
    try {
      const { reply, rows, cards } = await converse(bot.id, `Run this exact PowerShell command with your PowerShell tool and paste its complete output, every line, inside one code block:\n${ENV_DUMP}`, { ms: 240000, decide: () => "allow" });
      const text = [String(reply?.text ?? ""), ...rows.filter((m) => m.kind === "activity").map((m) => String(m.tool?.output ?? m.text ?? ""))].join("\n");
      const { env: seen, cwd } = WN.parseEnvDump(text); const handed = existsSync(MCP_RECORD) ? WN.loadHandedFromRecord(MCP_RECORD) : null;
      check(Boolean(handed), "MURAGE_GATE_MCP_RECORD holds the handed map (salted hashes)", handed ? Object.keys(handed.handed).length : "no record");
      check(Object.keys(seen).length > 5, "env dump parsed from the turn", Object.keys(seen).length);
      check(expectCard ? cards.length > 0 : cards.length === 0, expectCard ? "Ask: the PowerShell call raised an approval card" : "Full access: no approval card", cards.length);
      const adds = inheritAddsFromBuild(); if (!check(Boolean(adds), 'CLAUDE_INHERIT_ADDS["2.1.305"] exported by the built app (claude.ts)')) return;
      if (handed) { const v = WN.evaluateTurnEnv({ handed, seen, cwd, expectedCwd: repoDir, nonce: NOGIT_NONCE, inheritAdds: adds }); for (const c of v.checks) check(c.ok, c.what, c.detail); }
    } catch (err) { check(false, "turn finished", String(err).slice(0, 400)); }
  });
  const p = await api("PATCH", `/api/bots/${bot.id}`, { cwd: repoDir, autoApprove: false }); note("bot cwd = canary repo", p.status);
  await dumpTurn("ii-ask", { expectCard: true });
  await step(`${key}.nogit.iv`, `${key}: win-nogit dispatch line`, async () => {
    const log = applogTail();
    if (flag("--planted-bash")) check(WN.plantedBashDispatchOk(log), "planted bash: dispatch shell=murage-exec, powershell-tool=off", log.split("\n").filter((l) => /shell=/.test(l)).slice(-3));
    else check(WN.dispatchLineOk(log), "dispatch shell=powershell-inherit reason=no-git-bash", log.split("\n").filter((l) => /shell=/.test(l)).slice(-3));
  });
  if (!flag("--planted-bash")) {
    const f = await api("PATCH", `/api/bots/${bot.id}`, { autoApprove: true, fullAccess: true }); note("bot set to Full access", f.status);
    await dumpTurn("iii-full", { expectCard: false });
    await api("PATCH", `/api/bots/${bot.id}`, { autoApprove: false, fullAccess: false });
  } else await step(`${key}.nogit.vii`, `${key}: planted bash: a PowerShell call is denied`, async () => {
    const tag = `PSDENY-${NOGIT_NONCE}`;
    try { const { reply } = await converse(bot.id, `Run this exact PowerShell command with your PowerShell tool and paste its output: Write-Output ${tag}x`, { ms: 180000, decide: () => "allow" }); check(!String(reply?.text).includes(`${tag}x`), "the PowerShell tool did not run (no output came back)", String(reply?.text).slice(0, 160)); }
    catch (err) { check(false, "turn finished", String(err).slice(0, 200)); }
  });
};
const writeNogitWindow = () => { // input for the Administrator-side ancestry reader (win-nogit-admin.mjs)
  const create = (pid) => { try { return Number(ps(`[int64](((Get-Process -Id ${pid}).StartTime.ToUniversalTime()) - [datetime]'1970-01-01').TotalMilliseconds`).trim()); } catch { return null; } };
  const claudeExe = which("claude");
  writeFileSync(join(outDir, "win-nogit-window.json"), JSON.stringify({ startMs: T0, endMs: Date.now(), appDir, mainPids: mainPids.map((pid) => ({ pid, create: mainCreate.get(pid) ?? create(pid) })), engines: [{ name: "claude", exes: claudeExe ? [claudeExe] : [], scripts: [] }] }, null, 2));
};
const mainCreate = new Map();

// ---------------------------------------------------------------- per-engine run
const engineResults = [];
const perEngine = async (key) => {
  const e = CATALOG.engines[key]; const res = { engine: key, driver: e.driver, auth: e.auth, status: "PENDING", signIn: e.signIn, steps: [] };
  engineResults.push(res); const mark = results.length;
  const host = e.hosts?.[OS]; if (host !== true) { res.status = "SKIP"; res.reason = host; return; }
  if (e.auth === "none") { res.status = "SKIP"; res.reason = e.unexercised; return; }
  let nonce, bot, wordNonce;
  const st = await step(`${key}.0`, `${key}: sign-in proof, versions, isolated data`, async () => {
    if (NIGHTLY) for (const l of updateCli(key)) note("update", l);
    const bin = e.cli ? cliPath(e) : null;
    if (e.cli) { check(Boolean(bin), `${e.cli} CLI found${e.bundled ? " (bundled in the package)" : " on the gate PATH"}`, bin ? bin.replaceAll(GATE_HOME, "~") : `install it, see README (${e.cli})`); }
    const ver = bin ? versionOf(bin) : null; res.version = ver;
    const pin = VERSIONS[key];
    if (pin && !NIGHTLY) check(ver?.includes(pin), `CLI version equals the pin ${pin}`, ver); else note("version recorded", ver ?? "n/a");
    if (e.auth === "subscription") {
      const probe = PROBES[key]; if (probe && bin) { const ok = probe(bin); res.signedIn = ok; if (!check(ok, `signed in (subscription login) — if this fails Sean must run: ${e.signIn}`)) res.status = "NOT_SIGNED_IN"; }
      else note("no cheap status command for this CLI; sign-in is proven by the turn in step 1");
    } else {
      const f = await loadFluxKey(); if (!check(f.ok, "Flux test key present and is account 052be274 (not 63c3bfa0)", f.why ?? "ok")) res.status = "NOT_SIGNED_IN";
    }
    if (res.status === "NOT_SIGNED_IN") throw new Error("not signed in; remaining steps not attempted");
    if (key === "fuigo" && process.env.GATE_FUIGO_ON_FLUX === "1") { const f = await loadFluxKey(); if (!check(f.ok, "MAC-CI-GATE: Flux test key present and is the test account (fuigo on Flux)", f.why ?? "ok")) { res.status = "NOT_SIGNED_IN"; throw new Error("no Flux test key for fuigo"); } }
    rmSync(P.data, { recursive: true, force: true }); rmSync(P.userData, { recursive: true, force: true }); mkdirSync(P.data, { recursive: true }); mkdirSync(P.userData, { recursive: true }); rmSync(MCP_RECORD, { force: true });
    seed(key, e);
  });
  if (st !== "PASS") { res.status = res.status === "NOT_SIGNED_IN" ? "NOT_SIGNED_IN" : "FAIL"; res.steps = results.slice(mark); return; }
  nonce = randomBytes(3).toString("hex").toUpperCase(); wordNonce = `GATE-${nonce}`;
  let model; let modelSel;
  await step(`${key}.1`, `${key}: real turn with text`, async () => {
    await launch(); check(true, "app window reached its local server", origin);
    const h = await (await fetch(`${origin}/api/health`)).json(); check(h?.app === "murage", "health answers as murage", h);
    // 1.0.3 packaged main picks the first free of 8799/18799/28799 (electron/main.mjs:2246) and does not read MURAGE_PORT. Truthful check:
    // the port is one of those AND its listener belongs to THIS run's app tree (on Sean's Mac 8799 is his, so the gate copy lands on 18799).
    const appPort = Number(new URL(origin).port);
    check([8799, 18799, 28799].includes(appPort) && portOwnedByRun(appPort), `app listens on ${appPort}, and that listener belongs to this run's app (not another Murage)`, { origin, ownersMatch: portOwnedByRun(appPort) });
    check((await fetch(`${origin}/api/bots`)).status === 404, "owner route hidden without proof");
    const tI = Date.now(); const inst = (await api("GET", "/api/instances?fresh=1")).body?.instances; note("GET /api/instances?fresh=1 took", `${Date.now() - tI} ms`);
    const rec = Array.isArray(inst) ? inst.find((i) => i.id === key || i.instanceId === key) : inst?.[key];
    check(Boolean(rec), `engine instance '${key}' is listed`, Array.isArray(inst) ? inst.map((i) => i.id ?? i.instanceId) : Object.keys(inst ?? {}));
    // 1.0.3 shape (server/harness/registry.ts:300-340): { instanceId, driverKind, enabled, snapshot: { state, reason? }, models: { default, options: [{ id, ... }] }, capabilities }
    const opts = (rec?.models?.options ?? []).map((o) => (typeof o === "string" ? o : o?.id)).filter(Boolean);
    const fluxPick = opts.find((x) => /flux-auto$/.test(x)) ?? opts.find((x) => /flux/.test(x));
    model = opt(`--model-${key}`) ?? (e.auth === "flux" ? fluxPick ?? rec?.models?.default : rec?.models?.default || opts[0]);
    res.instance = { snapshot: rec?.snapshot, models: opts.length, default: rec?.models?.default ?? null, capabilities: rec?.capabilities };
    check(Boolean(model), "a model is available for the instance (a signed-in / Flux-keyed engine must list models; if not, PRODUCT bug, see snapshot)", { snapshot: rec?.snapshot, default: rec?.models?.default, options: opts.slice(0, 6) });
    if (!model) throw new Error("no model offered for this instance; nothing further can run");
    modelSel = { instanceId: key, model };
    const c = await api("POST", "/api/bots", { name: `Gate ${key} ${nonce}`, modelSelection: modelSel, requireAvailableModel: false });
    bot = c.body?.bot; check(Boolean(bot?.id), "bot created", c.status);
    // "This computer" on Linux needs local control enabled first (Computer settings -> window.muragebox.localControl.enable()); a bot set to
    // computer "local" while the Cua Driver is not ready gets NO turn at all ("CUA Driver is not ready for this computer"), seen 2026-10-21.
    let wantLocal = !WIN;
    if (LINUX) { const lc = await enableLinuxLocalControl(); note("Linux local control", lc); wantLocal = lc?.status === "ready"; }
    await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: modelSel, name: bot.name, ...(wantLocal ? { computer: "local" } : {}), autoApprove: false });
    const t = Date.now(); const { reply, rows } = await ask(bot.id, `Reply with the single word ${wordNonce}.`, 120000, (t) => t.includes(wordNonce));
    check(Boolean(reply), `bot text reply containing ${wordNonce}`, String(reply?.text).slice(0, 100)); log(`  turn ${((Date.now() - t) / 1000).toFixed(1)}s`);
    const bad = rows.filter((m) => BAD.test(String(m.text ?? "")) || BAD.test(JSON.stringify(m.murage ?? ""))).map((m) => String(m.text).slice(0, 100));
    check(bad.length === 0 && !/Available MCP tools: none/i.test(applogTail()), "no withheld/error line and no 'Available MCP tools: none' in messages or applog", bad);
  });
  const coreOk = results.at(-1).status === "PASS";
  if (WITH_CORE && results.at(-1).status === "PASS" && !e.textOnly) await step(`${key}.2`, `${key}: every MCP server connected, by the engine's own word + tool-level cross-check`, async () => {
    const m = mcpConnected();
    if (!m.have) check(MCP_RECORD_MODE === "optional", "engine MCP status record present (MURAGE_GATE_MCP_RECORD written by the driver; product hook, see README)", "no record in this build");
    else check(m.missing.length === 0, `engine reports connected: ${EXPECT_MCP.join(", ")}`, m.missing.length ? { missing: m.missing, connected: m.connected } : m.connected);
    const { reply } = await ask(bot.id, "Call the list_bots tool and reply with the exact name of every bot it returns, then recall anything from memory about 'gate' and say MEMORY-OK or MEMORY-NONE.", 180000, (t) => /MEMORY-(OK|NONE)/.test(t));
    const names = ((await api("GET", "/api/bots")).body?.bots ?? []).map((b) => b.name).filter((n) => n && n !== `Gate ${key} ${nonce}`);
    check(names.length > 0 ? names.some((n) => String(reply?.text).includes(n)) : String(reply?.text).includes(`Gate ${key} ${nonce}`), "tool-level: list_bots (agents server) answered with a real bot of this workspace (it lists the OTHER bots)", { reply: String(reply?.text).slice(0, 160), workspaceBots: names });
    check(/MEMORY-(OK|NONE)/.test(String(reply?.text)), "tool-level: memory recall tool answered");
  });
  else if (WITH_CORE && e.textOnly) { current = { id: `${key}.2`, title: `${key}: MCP`, status: "PASS", checks: [], ms: 0 }; results.push(current); note("text-only engine (no tool loop); MCP/approval steps are not applicable to this driver"); }
  if (WITH_CORE && !e.textOnly && results.at(-1).status === "PASS") await step(`${key}.3`, `${key}: approval card tool call completes`, async () => {
    const before = seenOf(await getBot(bot.id));
    await api("POST", `/api/bots/${bot.id}/messages`, { text: `Run the shell command \`echo GATE-APPROVE-${nonce}\` and tell me its output.` });
    let card; await until(async () => { const b = await getBot(bot.id); card = (b.messages ?? []).find((m) => !before.has(msgKey(b, m)) && m.kind === "options" && m.card?.requestId && !m.card?.answered && !m.card?.dismissed); return card; }, 120000, "an approval card", 1000);
    check(true, "approval card appeared", card.card.requestId);
    const r = await api("POST", `/api/bots/${bot.id}/respond`, { behavior: "allow", requestId: card.card.requestId, threadId: (await getBot(bot.id)).threadId });
    check(r.status === 200, "approve accepted", r.body);
    await until(async () => { const b = await getBot(bot.id); return !b.busy && botText(b, before).some((m) => String(m.text).includes(`GATE-APPROVE-${nonce}`)); }, 150000, "reply with the command output", 1000);
    check(true, "the approved command ran and its output came back");
  });
  if (WITH_CORE && results.at(-1).status === "PASS") await step(`${key}.4`, `${key}: restart resumes the conversation`, async () => {
    await quit(); check(ownedPids().length === 0, "no leftover processes after a normal quit", ownedPids());
    check(profilesPresent().length === 0,"G2 mid-run: no default profile created", profilesPresent());
    rmSync(MCP_RECORD, { force: true }); await launch();
    const { reply } = await ask(bot.id, "What was the word I asked you to reply with first? Answer with that word only.", 150000, (t) => t.includes(wordNonce));
    check(Boolean(reply), `after restart the bot recalls ${wordNonce}`, String(reply?.text).slice(0, 100));
    const logT = applogTail(); const lines = logT.split("\n").filter((l) => /resum|--resume|thread\/resume|session\/load|loadSession/i.test(l)).slice(-4).map((l) => l.slice(0, 200));
    check(lines.length > 0, "applog shows the driver's resume (Claude --resume / Codex thread / ACP session load)", lines);
  });
  if (WITH_CORE && results.at(-1).status === "PASS") await step(`${key}.5`, `${key}: one routine run`, async () => {
    const rt = await api("POST", "/api/routines", { name: `Gate routine ${nonce}`, botId: bot.id, prompt: "Write one sentence saying the gate routine ran.", enabled: true, schedule: { type: "once", at: Date.now() + 86400000 } });
    check(rt.status === 201, "routine created", rt.body); const rid = rt.body?.routine?.id; if (!rid) return;
    const r = await api("POST", `/api/routines/${rid}/run`); check(r.status < 300, "run accepted", r.status);
    const run1 = await until(async () => ((await api("GET", "/api/routines")).body.runs ?? []).find((x) => x.routineId === rid && (x.status === "completed" || x.status === "failed")), 180000, "routine run finished", 2000);
    check(run1.status === "completed", "routine run completed with real text", { status: run1.status, error: run1.error });
  });
  if (WN && key === "claude" && coreOk) await runWinNogit(key, bot);
  if (JOURNEYS.length) await runJourneys(key, e, res, { bot, nonce, coreOk });
  try { await quit(); } catch { /* */ }
  res.steps = results.slice(mark);
  res.status = res.steps.every((s) => s.status === "PASS") ? "PASS" : "FAIL";
};

// ---------------------------------------------------------------- main
let exitCode = 1; const summary = { os: OS, user: me, startedAt: new Date(T0).toISOString(), artifact: artifact ? basename(String(artifact)) : null, cliMode: NIGHTLY ? "newest" : "pinned", requested: wanted, unsetEnvNames: unsetNames, guards, engines: engineResults };
try {
  await step("pre.0", "prepare: guards G1/G2, env hygiene, artifact, tooling", async () => {
    check(g1.ok, "G1 user wall", g1.notes.length ? g1.notes : `${me} (not a forbidden account)`);
    check(leftoverKeys.length === 0, "no API key / provider / CLAUDE_CODE_* / ELECTRON_RUN_AS_NODE names in the children's env", leftoverKeys);
    check(guards.G2.before.profiles.length === 0, "G2 before: no default Murage profile exists in the gate account", guards.G2.before.profiles);
    check(guards.G2.before.port8799Ours === false, "G2 before: no listener on 8799 owned by the gate user");
    if (PREFLIGHT_ONLY) { for (const k of wanted) { const e = CATALOG.engines[k]; const bin = e.cli && !e.bundled ? which(e.cli) : (e.bundled && process.env.GATE_FUIGO_BIN /* FUIGO-PROBE-FIX */ ? process.env.GATE_FUIGO_BIN : null); const ok = e.auth === "none" ? null : e.auth === "flux" ? (await loadFluxKey()).ok : bin ? (PROBES[k] ? PROBES[k](bin) : "unknown") : false; engineResults.push({ engine: k, auth: e.auth, preflight: { cliFound: Boolean(bin) || Boolean(e.bundled), version: versionOf(bin), signedIn: ok, signIn: e.signIn, unexercised: e.unexercised } }); note(`preflight ${k}`, { cli: bin ? "found" : e.bundled ? "bundled" : e.cli ? "MISSING" : "n/a", signedIn: ok }); } return; }
    if (WN) {
      const pf = WN.preflightNoGit(); for (const c of pf.checks) check(c.ok, `win-nogit preflight: ${c.what}`, c.detail);
      const cbin = which("claude"); const ver = cbin ? versionOf(cbin) : null; const auth = cbin ? run(cbin, ["auth", "status", "--json"]).stdout : "";
      const pc = WN.preflightClaude({ version: ver, exe: cbin, authJson: auth }); for (const c of pc.checks) check(c.ok, `win-nogit preflight: ${c.what}`, c.detail);
      plantAutoRun(); note("HKCU Command Processor AutoRun canary planted (restored at cleanup)");
    }
    prepareApp(); check(Boolean(exe) && existsSync(exe), "main executable found in the extracted app", exe?.replaceAll(runRoot, "<run>"));
    check(existsSync(join(resDir, "app.asar")), "resources/app.asar present");
    check(readFileSync(join(resDir, "app.asar")).includes("// Explicit fixture/profile isolation"), "build has the MURAGE_USER_DATA isolation block (refuse to run without it)");
    check(within(runRoot, appDir), "running a copy inside the run root, not an installed location", appDir.replaceAll(runRoot, "<run>"));
    const pwPkg = join(P.pw, "node_modules", "playwright-core");
    if (!existsSync(pwPkg)) { writeFileSync(join(P.pw, "package.json"), '{"name":"w","private":true}'); const n = run(WIN ? "npm.cmd" : "npm", ["install", "--prefix", P.pw, "--no-audit", "--no-fund", "--loglevel=error", "playwright-core@1.57.0"], { timeout: 240000 }); check(n.status === 0, "playwright-core installed in the gate dir", (n.stderr || "").slice(-200)); }
    electron = createRequire(join(P.pw, "x.js"))("playwright-core")._electron; startWatch(); await sleep(1200);
    check(watch.seen.size > 5, "G3 process watcher running", watch.seen.size);
  });
  if (results[0].status !== "PASS") throw new Error("prepare failed; nothing else can run");
  if (!PREFLIGHT_ONLY) {
    await step("pre.G5", "G5 product guard: a launcher script run without ELECTRON_RUN_AS_NODE must exit 86 and open no window", async () => {
      const launcher = (() => { const d = join(resDir, "server", "launcher.js"); if (existsSync(d)) return d; let n = 0; const walk = (x, k) => { if (k < 0 || n > 6000) return null; let es; try { es = readdirSync(x, { withFileTypes: true }); } catch { return null; } for (const e of es) { n++; if (e.isFile() && e.name === "launcher.js") return join(x, e.name); } for (const e of es) if (e.isDirectory() && e.name !== "node_modules") { const r = walk(join(x, e.name), k - 1); if (r) return r; } return null; }; return walk(resDir, 4) ?? d; })();
      if (G5_MODE === "skip") return note("skipped by --g5 skip");
      if (!check(existsSync(launcher), "launcher.js found under resources/server", launcher.replaceAll(runRoot, "<run>"))) return;
      const env = { ...baseEnv, MURAGE_DATA_DIR: P.g5, MURAGE_USER_DATA: P.g5, MURAGE_PORT: "18798" }; // contained even if the guard is missing
      const c = spawn(exe, [launcher, `--user-data-dir=${P.g5}`, ...(LINUX ? ["--no-sandbox"] : [])], { env, stdio: "ignore", windowsHide: true, cwd: runRoot });
      const code = await new Promise((r) => { const t = setTimeout(() => { try { c.kill("SIGKILL"); } catch { /* */ } r("still-running"); }, 15000); c.on("exit", (x) => { clearTimeout(t); r(x); }); });
      killOwned(); guards.G5 = { exit: code };
      check(code === 86, "exit code 86 (guard present in this build)", String(code));
    });
    for (const k of wanted) { try { await perEngine(k); } catch (e) { const r = engineResults.find((x) => x.engine === k); if (r) { r.status = r.status === "NOT_SIGNED_IN" ? r.status : "FAIL"; r.error = String(e).slice(0, 300); } try { await quit(); } catch { /* */ } } }
  }
} catch (e) {
  log(`ABORT: ${e?.message ?? e}`);
  if (current && current.status === "RUNNING") { current.status = "FAIL"; current.checks.push({ ok: false, what: "aborted", detail: String(e?.message ?? e) }); }
} finally {
  try { if (app) await quit(); } catch { /* */ }
  clearInterval(watch.timer); scanOnce(); killOwned();
  try { if (WN) { restoreAutoRun(); writeNogitWindow(); summary.winNogit = { nonce: NOGIT_NONCE, ancestry: "PENDING: Administrator reader (run-gate.sh win-nogit-admin.mjs ancestry)" }; } } catch (e) { summary.winNogitError = String(e).slice(0, 200); }
  try { closeTarget(); site?.server.close(); if (basename(targetRoot) === `capgate-target-${basename(runRoot)}` && dirname(targetRoot) === GATE) rmSync(targetRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  const cleanup = {};
  try {
    guards.G2.after = { profiles: profilesPresent(), port8799Ours: await own8799() };
    guards.G2.ok = guards.G2.before.profiles.length === 0 && guards.G2.after.profiles.length === 0 && !guards.G2.after.port8799Ours;
    guards.G3 = { processesSeen: watch.seen.size, ownProcesses: [...watch.seen.values()].filter((p) => p.mine).length, strays: watch.stray, ok: watch.stray.length === 0 };
    const fpAfter = fingerprint(); const lost = Object.keys(fpBefore).filter((k) => fpBefore[k] && (!fpAfter[k] || fpBefore[k].some((n) => !fpAfter[k].includes(n)))); // sign-ins must not lose an entry; new entries (token refresh, probe-created dirs) are fine
    guards.G4 = { fingerprintsUnchanged: lost.length === 0 }; if (lost.length) guards.G4.diff = lost.map((k) => k.replaceAll(GATE_HOME, "~"));
    if (WIN) { const a = protoQuery(); if (protoBefore.stdout === a.stdout && protoBefore.status === a.status) guards.G4.protocolKeyUnchanged = true; else { if (protoBefore.status === 0 && existsSync(protoBackup)) spawnSync("reg", ["import", protoBackup], { windowsHide: true }); else spawnSync("reg", ["delete", protoKey, "/f"], { windowsHide: true }); const b = protoQuery(); guards.G4.protocolKeyUnchanged = protoBefore.stdout === b.stdout && protoBefore.status === b.status; guards.G4.protocolKeyRestored = guards.G4.protocolKeyUnchanged; } }
    if (MAC && registeredApp) { const ls = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"; spawnSync(ls, ["-u", registeredApp]); guards.G4.lsUnregistered = true; }
    guards.G4.ok = guards.G4.fingerprintsUnchanged && guards.G4.protocolKeyUnchanged !== false;
  } catch (e) { cleanup.error = String(e).slice(0, 200); }
  if (mountedDmg) spawnSync("hdiutil", ["detach", P.dmg, "-force"]);
  const failedSteps = results.filter((r) => r.status !== "PASS");
  const guardsOk = g1.ok && guards.G2.ok && guards.G3.ok && guards.G4.ok;
  const engineFail = engineResults.filter((r) => ["FAIL", "NOT_SIGNED_IN"].includes(r.status));
  summary.unexercised = engineResults.filter((r) => r.status === "SKIP").map((r) => ({ engine: r.engine, reason: r.reason }));
  summary.totalSeconds = Math.round((Date.now() - T0) / 1000); summary.deviations = deviations; summary.steps = results; summary.cleanup = cleanup; summary.guards = guards;
  summary.gate = PREFLIGHT_ONLY ? (failedSteps.length === 0 ? "PREFLIGHT-OK" : "PREFLIGHT-FAIL") : failedSteps.length === 0 && guardsOk && engineFail.length === 0 && engineResults.some((r) => r.status === "PASS") ? "PASS" : "FAIL";
  try {
    writeFileSync(join(outDir, "result.json"), JSON.stringify(summary, null, 2));
    writeFileSync(join(outDir, "process-watch.json"), JSON.stringify([...watch.seen.values()].filter((p) => p.mine), null, 1));
    const logs = join(P.userData, "logs"); if (existsSync(logs)) for (const f of readdirSync(logs)) writeFileSync(join(outDir, `applog-${f}`), readFileSync(join(logs, f), "utf8").slice(-60000));
    if (existsSync(MCP_RECORD)) writeFileSync(join(outDir, "mcp-record.jsonl"), readFileSync(MCP_RECORD, "utf8").replace(/(key|token|secret|authorization)["']?\s*[:=]\s*["']?[A-Za-z0-9_\-.]{12,}/gi, "$1:<redacted>"));
  } catch { /* best effort */ }
  const guardPath = resolve(runRoot).startsWith(resolve(GATE) + sep) && basename(runRoot).startsWith("runs-");
  if (guardPath && !flag("--keep")) for (let i = 0; i < 6; i++) { try { rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 }); break; } catch { await sleep(1500); } }
  summary.rootRemoved = !existsSync(runRoot); writeFileSync(join(outDir, "result.json"), JSON.stringify(summary, null, 2));
  if (JOURNEYS.length) { const cols = [...new Set(engineResults.flatMap((r) => Object.keys(r.journeys ?? {})))]; console.log(`JOURNEYS engine ${cols.join(" ")}`); for (const r of engineResults) console.log(`JOURNEYS ${r.engine} ${r.journeys ? cols.map((c) => r.journeys[c] ?? "-").join(" ") : r.status}`); summary.journeyMatrix = Object.fromEntries(engineResults.map((r) => [r.engine, r.journeys ?? r.status])); writeFileSync(join(outDir, "result.json"), JSON.stringify(summary, null, 2)); }
  console.log("RESULT " + JSON.stringify({ gate: summary.gate, seconds: summary.totalSeconds, engines: engineResults.map((r) => `${r.engine}:${r.status ?? (r.preflight ? "preflight" : "?")}`), guards: { G1: g1.ok, G2: guards.G2.ok, G3: guards.G3.ok, G4: guards.G4.ok }, unexercised: summary.unexercised.map((u) => u.engine), rootRemoved: summary.rootRemoved }));
  exitCode = summary.gate === "PASS" || summary.gate === "PREFLIGHT-OK" ? 0 : 1;
}
process.exit(exitCode);
