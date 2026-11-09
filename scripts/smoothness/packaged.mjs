// SPDX-License-Identifier: AGPL-3.0-or-later
// Rig v5.8. Launch planning is pure; neither importing this file nor planning spawns anything.
import { posix, win32 } from "node:path";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync as spawnSyncDefault } from "node:child_process";
import { stats } from "../scale/stats.mjs";

const paths = platform => platform === "win32" ? win32 : posix;

export function initialResults({ mode, label, runId, ...fields }) {
  return { ...fields, mode, label, runId, phase: "running", status: "INVALID", preflight: { ok: false, refusal: "preflight not completed" } };
}

// These are fixture banners, not claims about installed vendor builds. Fuigo must outrank the
// bundle (env-path.ts:810-857); an unreadable bundle still refuses via the server proof below.
// Claude parses X.Y.Z and requires >=2.1.280 (claude-guards.ts:20-33); Grok requires >=1.0.62
// for Ask (acp/grok.ts:477-485). ACP preserves the banner (acp/core.ts:899-902,5804-5816).
export function fakeVersionBanner(engine, witness) {
  const versions = { fuigo: "fuigo 999.0.0", grok: "grok 1.0.62", claude: "2.1.295 (Claude Code)" };
  if (!Object.hasOwn(versions, engine)) throw Error(`no fake wrapper for ${engine}`);
  return `${versions[engine]} smooth-wrapper=${witness}`;
}
export function fakeVersionShell(engine, witness) {
  const quoted = `'${fakeVersionBanner(engine, witness).replaceAll("'", "'\\''")}'`;
  return `for arg in "$@"; do if [ "$arg" = "--version" ]; then printf '%s\\n' ${quoted}; exit 0; fi; done`;
}

/** /api/instances returns the actual driver's snapshot version (index.ts:30218-30230).
 * The unique banner is emitted only by this leg's wrapper; a candidate list alone is not proof.
 * engine-management/fuigo additionally exposes resolveFuigoCli's source (index.ts:20985-20992,
 * 30275-30277; engine-management.ts:96-104). Version-probed files are launch-bound by
 * drivers/isolation-cache.ts:104-125 and acp/fuigo.ts:317-329. No turns precede this check. */
export async function proveFakeResolvers({ call, wrappers, platform = process.platform }) {
  const response = await call("GET", "/api/instances", undefined, 60_000);
  if (response.status !== 200 || !Array.isArray(response.json?.instances)) throw Error("fake resolver evidence unavailable: /api/instances");
  const proof = [];
  for (const [engine, wrapper] of Object.entries(wrappers)) {
    const instance = response.json.instances.find(row => row.instanceId === engine);
    if (instance?.snapshot?.state !== "available" || instance.snapshot.version !== wrapper.banner)
      throw Error(`fake resolver selected another executable or is unproved: ${engine}; expected wrapper ${wrapper.path}`);
    // registry.ts:402-407 publishes the configured CLI and ordered candidates. Require both
    // the selected path AND the selected driver's unique probe banner, not PATH order alone.
    const selected = instance.cli && instance.cli !== instance.cliDefault ? instance.cli : instance.cliCandidates?.[0];
    const canonical = value => typeof value === "string" ? (platform === "win32" ? win32.normalize(value).toLowerCase() : posix.normalize(value)) : null;
    if (canonical(selected) !== canonical(wrapper.path)) throw Error(`fake resolver selected ${selected ?? "unknown path"}; expected wrapper ${wrapper.path}`);
    if (engine === "fuigo") {
      const status = await call("GET", "/api/engine-management/fuigo", undefined, 30_000);
      if (status.status !== 200 || !["path", "custom"].includes(status.json?.source))
        throw Error("fake Fuigo resolver selected bundled/managed executable or source is unproved");
    }
    proof.push({ engine, executable: selected, banner: wrapper.banner, cite: "GET /api/instances; GET /api/engine-management/fuigo" });
  }
  return proof;
}

/** server/graceful-shutdown.ts APP_CLOSE_REQUEST_TYPE; dependencies are supplied, never spawned on import. */
export async function stopOwnedServer({ child, platform, send, kill, spawnSync, sleep }) {
  if (!child) return false;
  let graceful = true;
  if (platform === "win32") { try { send({ type: "murage:close" }); } catch { graceful = false; kill(); } }
  else kill("SIGTERM");
  for (let i = 0; i < 300 && child.exitCode === null && child.signalCode === null; i++) await sleep(100);
  if (child.exitCode === null && child.signalCode === null) {
    graceful = false;
    if (platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else kill("SIGKILL");
  }
  return graceful && child.exitCode === 0 && child.signalCode === null;
}

const omitted = (names, reason, cite) => names.split(" ").map(name => ({ name, reason, cite }));
export const FIXTURE_ENV_OMITTED = [
  ...omitted("MURAGE_DESKTOP_PARENT MURAGE_INTERNAL_DATA_DIR_LEASE MURAGE_COMPANION_TOKEN MURAGE_COMPANION_TOKEN_VIA", "Requires the desktop utility parent and its private lease/secret channel; fixture owns its own lease.", "electron/main.mjs:2164-2173,2217"),
  ...omitted("MURAGE_MODEL_PROVIDER_COMMIT_TOKEN MURAGE_MCP_COMMIT_TOKEN", "Requires desktop credential commit IPC and its per-launch token.", "electron/main.mjs:2196-2197"),
  ...omitted("MURAGE_COMPOSIO_BROKER_URL MURAGE_COMPOSIO_BROKER_TOKEN MURAGE_FLUX_COMPOSIO_BROKER_URL MURAGE_FLUX_COMPOSIO_BROKER_TOKEN MURAGE_FLUX_COMPOSIO_ACCOUNT_KIND MURAGE_COMPOSIO_LEGACY_BROKER_UNTIL MURAGE_COMPOSIO_LEGACY_CLAIM COMPOSIO_API_KEY MURAGE_CONNECTED_APPS_OWN_KEY_RETIRED", "No broker deployment, registration or stored connected-app credentials in the fixture.", "electron/managed-composio.mjs:125-164"),
  ...omitted("MURAGE_MODEL_PROVIDER_CONNECTIONS MURAGE_TELEGRAM_BOT_TOKEN MURAGE_SLACK_APP_TOKEN MURAGE_SLACK_BOT_TOKEN MURAGE_DISCORD_BOT_TOKEN XAI_API_KEY BOX_TOKEN MURAGE_TTS_KEY MURAGE_OPENAI_IMAGE_KEY OPENCODE_API_KEY MURAGE_TAVILY_SEARCH_KEY MURAGE_EXA_SEARCH_KEY MURAGE_FIRECRAWL_SEARCH_KEY FLUX_API_KEY MURAGE_FLUX_CONNECTION_ALIASES MURAGE_MCP_SERVER_SECRETS MURAGE_EMAIL_SECRETS", "Requires real secrets from the desktop encrypted credential store.", "electron/workspace-credentials.mjs:13-27,73-90"),
  ...omitted("MURAGE_BROWSER_CONNECTION", "Desktop deletes the inherited browser connection before fork.", "electron/main.mjs:2204"),
];
// Explicit platform makes Windows plans testable on POSIX, including spaces, #, % and UNC paths.
export function importUrl(file, platform = process.platform) {
  if (platform !== "win32") return `file://${posix.resolve(file).split("/").map(encodeURIComponent).join("/")}`;
  const normalized = win32.resolve(file).replaceAll("\\", "/");
  const encoded = normalized.split("/").map(encodeURIComponent).join("/").replace(/^([A-Za-z])%3A/, "$1:");
  return normalized.startsWith("//") ? `file:${encoded}` : `file:///${encoded}`;
}

export function packagedLayout(appDir, platform = process.platform) {
  const p = paths(platform), root = p.resolve(appDir);
  const resources = p.join(root, platform === "darwin" ? "Contents/Resources" : "resources");
  return { appDir: root, resources, serverEntry: p.join(resources, "server/index.js"),
    executable: p.join(root, platform === "win32" ? "Murage.exe" : platform === "darwin" ? "Contents/MacOS/Murage" : "murage") };
}

// Prefer the selected app's distribution version file, then ask its own Electron in Node mode.
export function readElectronVersion(layout, { platform = process.platform, exists = existsSync, readFile = readFileSync, spawnSync = spawnSyncDefault } = {}) {
  const p = paths(platform);
  const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
  const candidates = [...new Set([p.join(p.dirname(layout.executable), "version"), p.join(layout.resources, "version"), p.join(layout.appDir, "version")])];
  for (const file of candidates) {
    if (!exists(file)) continue;
    const version = readFile(file, "utf8").trim().replace(/^v/, "");
    if (!semver.test(version)) throw Error(`invalid Electron version file: ${file}`);
    return { version, source: "file", file };
  }
  const fail = reason => Error(`packaged Electron version probe failed (${layout.executable}): ${reason}`);
  let probe;
  try {
    probe = spawnSync(layout.executable, ["-p", "process.versions.electron"], {
      env: { ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 30_000,
    });
  } catch (error) { throw fail(String(error?.message ?? error)); }
  if (probe.error) throw fail(probe.error.code === "ETIMEDOUT" ? "timed out after 30000 ms (ETIMEDOUT)" : `${probe.error.code ?? "spawn error"}: ${probe.error.message}`);
  if (probe.signal) throw fail(`terminated by signal ${probe.signal}`);
  if (probe.status !== 0) throw fail(`exit status ${probe.status}`);
  const version = typeof probe.stdout === "string" ? probe.stdout.trim() : "";
  if (!semver.test(version)) throw fail(`non-semver stdout: ${JSON.stringify(version)}`);
  return { version, source: "exe", executable: layout.executable };
}

// Mirror electron/compile-cache.mjs:13-18, with explicit path semantics for cross-platform plans.
export function packagedCompileCacheDirectory({ userData, appVersion, electronVersion, platform = process.platform }) {
  const p = paths(platform);
  if (typeof userData !== "string" || !p.isAbsolute(userData)) return null;
  const version = String(appVersion ?? "").replace(/[^0-9A-Za-z._-]/g, "_");
  if (!version) return null;
  const electron = String(electronVersion ?? "").replace(/[^0-9A-Za-z._-]/g, "_");
  return p.join(userData, "node-compile-cache", electron ? `${version}-electron-${electron}` : version);
}

/** Called once per leg, before the first spawn. Never reuse or delete a populated cache. */
export function prepareCompileCache(dir) {
  mkdirSync(paths(process.platform).dirname(dir), { recursive: true, mode: 0o700 });
  try { mkdirSync(dir, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (!lstatSync(dir).isDirectory() || readdirSync(dir).length) throw Error(`compile cache must start empty: ${dir}`);
    // Even an existing empty leaf is recreated; rmdir refuses if another writer populated it.
    rmdirSync(dir); mkdirSync(dir, { mode: 0o700 });
  }
  return { dir, emptyAtStart: true };
}

export function compileCacheFileCount(dir) {
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) count += compileCacheFileCount(paths(process.platform).join(dir, entry.name));
    else if (entry.isFile()) count++;
  }
  return count;
}

/** S0 uses the existing stop/start paths. Cache files are counted after clean exit flushes V8's cache. */
export async function packagedBoots({ startServer, waitHealthy, stopServer, settle, results, save, note, countFiles = compileCacheFileCount,
  now = Date.now, logSize = () => 0, measure = () => ({}) }) {
  const timing = ms => ({ healthy: stats([ms]), samples: [ms] });
  results.scenarios.boot = timing(await waitHealthy(startServer()));
  save();
  await settle();
  const window = { from: now(), logFrom: logSize() };
  if (await stopServer() !== true) throw Error("cold server did not stop cleanly; cannot measure warm boot");
  results.compileCache.filesAfterCold = countFiles(results.compileCache.dir);
  if (results.compileCache.filesAfterCold === 0) note("cache did not fill; S0 WARM is not a warm boot");
  save();
  results.scenarios.bootWarm = timing(await waitHealthy(startServer()));
  await settle();
  Object.assign(window, { to: now(), logTo: logSize() });
  results.scenarios.bootWarm.window = window;
  results.scenarios.bootWarm.measurements = measure(window);
  results.excludedWindows = [...(results.excludedWindows ?? []), { ...window, reason: "S0 WARM info only" }];
  save();
}

// electron/harness-resources.mjs:17-42. Keep these paths rooted in the app, never WORK.
const RESOURCE_DIRS = { MURAGE_STATIC_DIR: "ui", MURAGE_SKILLS_DIR: "skills", MURAGE_SKILL_LIBRARY: "skills-library",
  MURAGE_LIBRARY_DIR: "library", MURAGE_BOT_LIBRARY_DIR: "bot-library", MURAGE_FUIGO_DIR: "fuigo",
  MURAGE_GEPA_DIR: "gepa-worker", MURAGE_MEMORY_MODEL_DIR: "memory-model" };

export function serverLaunch({ appDir, appVersion, electronVersion, gepaPin = "", work, env, execPath, platform = process.platform, cpuProf = [] }) {
  const p = paths(platform), eld = p.join(work, "scripts/scale/eld.mjs");
  if (!appDir) return { mode: "source", appDir: null, appVersion: null, serverEntry: p.join(work, "server/index.ts"),
    executable: execPath, args: [...cpuProf, "--experimental-strip-types", "--import", platform === "win32" ? importUrl(eld, platform) : eld, "server/index.ts"],
    cwd: work, env, stdio: ["ignore", "log", "log", ...(platform === "win32" ? ["ipc"] : [])] };
  const layout = packagedLayout(appDir, platform);
  if (typeof electronVersion !== "string" || !electronVersion.trim()) throw Error("packaged Electron version is required");
  // main.mjs:2210 has no cwd override (inherits the launcher's cwd). The fixture inherits WORK explicitly.
  // This is the requested Node-mode fixture, not a utility child: no fake parentPort, desktop-owner lease,
  // secret-store/broker credentials or MURAGE_DESKTOP_PARENT claim. sse-visibility.ts:56-79 permits this opt-in.
  const childEnv = { ...env, ELECTRON_RUN_AS_NODE: "1", MURAGE_RESOURCES_PATH: layout.resources,
    MURAGE_APP_VERSION: appVersion.slice(0, 64), MURAGE_USER_DATA: p.join(env.MURAGE_DATA_DIR, "smooth-user-data"),
    // main.mjs:2017,2187,2195; secret-storage-policy.mjs:47-49. Node mode has no desktop store.
    MURAGE_SYSTEM_LANGUAGE: "en-US", MURAGE_CREDENTIAL_STORE: "unavailable", MURAGE_SECRET_SAVE_REFUSED: "",
    MURAGE_FLUX_AMBIENT_KEY: "", // workspace-credentials.mjs:109-122, no ambient key offered
    // backup-closed-controller.mjs:10 + backup-closed-profile.mjs:10: sibling of canonical DATA, not userData.
    MURAGE_BACKUP_CONTROL_DIR: p.join(p.dirname(env.MURAGE_DATA_DIR), ".murage-backup-control", createHash("sha256").update(env.MURAGE_DATA_DIR).digest("hex")),
    MURAGE_GEPA_MANIFEST_SHA256: typeof gepaPin === "string" && /^[a-f0-9]{64}$/.test(gepaPin) ? gepaPin : "", MURAGE_TURN_TRACE: "1",
    ...Object.fromEntries(Object.entries(RESOURCE_DIRS).map(([key, dir]) => [key, p.join(layout.resources, dir)])) };
  for (const key of ["MURAGE_DESKTOP_PARENT", "MURAGE_INTERNAL_DATA_DIR_LEASE", "MURAGE_COMPANION_TOKEN", "MURAGE_COMPANION_TOKEN_VIA", "NODE_OPTIONS", "NODE_PATH", "NODE_COMPILE_CACHE", "NODE_DISABLE_COMPILE_CACHE", "MURAGE_ENGINE_EXCLUSION_PATH", "OMB_RESOURCES_PATH"]) delete childEnv[key];
  const absent = new Set(FIXTURE_ENV_OMITTED.map(row => row.name));
  for (const key of Object.keys(childEnv)) if (absent.has(platform === "win32" ? key.toUpperCase() : key)) delete childEnv[key];
  childEnv.NODE_COMPILE_CACHE = packagedCompileCacheDirectory({ userData: childEnv.MURAGE_USER_DATA, appVersion, electronVersion, platform });
  if (!childEnv.NODE_COMPILE_CACHE) throw Error("invalid packaged compile cache directory");
  return { mode: "packaged", ...layout, appVersion, executable: layout.executable, fixtureEnvOmitted: FIXTURE_ENV_OMITTED.map(row => ({ ...row })),
    args: [...cpuProf, "--import", importUrl(eld, platform), "--import", importUrl(p.join(work, "scripts/smoothness/packaged-preload.mjs"), platform), layout.serverEntry],
    cwd: work, env: childEnv, stdio: ["ignore", "log", "log", ...(platform === "win32" ? ["ipc"] : [])] };
}

// Read the app's own metadata, including electron-builder's normal app.asar layout, without executing it.
// ASAR: 8-byte size pickle, header pickle (payload size + JSON string length + JSON), then file bytes.
export function readAppMetadata(resources) {
  for (const file of [posix.join(resources, "app/package.json"), posix.join(resources, "app.asar.unpacked/package.json"), posix.join(resources, "package.json")]) {
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  }
  const fd = openSync(posix.join(resources, "app.asar"), "r");
  const read = (size, at) => {
    const b = Buffer.alloc(size); let offset = 0;
    while (offset < size) { const n = readSync(fd, b, offset, size - offset, at + offset); if (!n) throw Error("short app.asar metadata read"); offset += n; }
    return b;
  };
  try {
    const size = read(8, 0).readUInt32LE(4);
    if (size < 8 || size > 64 * 1024 * 1024) throw Error("invalid app.asar header size");
    const header = read(size, 8), length = header.readUInt32LE(4);
    if (length > size - 8) throw Error("invalid app.asar header string");
    const entry = JSON.parse(header.subarray(8, 8 + length).toString("utf8")).files?.["package.json"];
    if (!entry || entry.unpacked || entry.link || !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > 1024 * 1024 || !/^\d+$/.test(entry.offset)) throw Error("invalid app.asar package.json entry");
    const offset = 8 + size + Number(entry.offset);
    if (!Number.isSafeInteger(offset)) throw Error("invalid app.asar package.json offset");
    return JSON.parse(read(entry.size, offset).toString("utf8"));
  } finally { closeSync(fd); }
}

export function packagedPreflightRefusal({ expectedData, observedData, pid, expectedPid, authStatus, secretAccepted, log = "", traceLog = log, requireTrace = false, platform = process.platform }) {
  const fail = why => `smooth.mjs refuses packaged leg: ${why}`;
  if (pid !== expectedPid || !Number.isInteger(pid)) return fail("health belongs to another process (PID mismatch)");
  const p = paths(platform), canonical = s => { const n = p.normalize(s); return platform === "win32" ? n.toLowerCase() : n; };
  if (!observedData) return fail("data-dir override unproven: no data-dir owner lease matching the packaged server PID");
  if (canonical(observedData) !== canonical(expectedData)) return fail(`data-dir override ignored: opened ${observedData}; expected ${expectedData}`);
  if (authStatus !== 200 || !secretAccepted) return fail("desktop secret rejected: MURAGE_ALLOW_DEV_DESKTOP_SECRET / MURAGE_DEV_DESKTOP_SECRET did not authorize the compiled Node-mode fixture; no auth bypass attempted");
  if (!/^\[eld\] /m.test(log)) return fail("ELD --import preload produced no [eld] lines");
  if (requireTrace && !/^\[turn-trace\] id=\w+ phase=/m.test(traceLog)) return fail("MURAGE_TURN_TRACE=1 produced no [turn-trace] lines for the preflight turn");
  return null;
}

// server/index.ts:1183 acquires DATA_DIR's lease before constructing stores; server/data-dir-lease.ts:3
// re-exports the implementation. Mirror only electron/data-dir-lease.mjs:333-342's path derivation.
// No product import, module patch or lease acquisition: the server's PID in its own sibling anchor is proof.
export function observedDataDir(dataDir, pid, { platform = process.platform, realpath = realpathSync.native, readFile = readFileSync } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const p = paths(platform), resolved = realpath(dataDir);
    const ordinary = platform === "win32" ? resolved.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "") : resolved;
    const canonical = platform === "win32" ? ordinary.toLowerCase() : ordinary;
    const identity = platform === "darwin" ? canonical.normalize("NFC").toLowerCase() : canonical;
    const digest = createHash("sha256").update(identity).digest("hex");
    const owner = JSON.parse(readFile(p.join(p.dirname(canonical), `.murage-data-owner-${digest}.lease`), "utf8"));
    if (owner?.version !== 1 || owner.pid !== pid || typeof owner.token !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(owner.token)) return null;
    return resolved;
  } catch { return null; } // Missing, unreadable or malformed evidence refuses the leg.
}

export function observedNativeFiles(log, pid) {
  for (const line of String(log).split("\n")) {
    if (!line.startsWith("[smooth-native] ")) continue;
    try {
      const row = JSON.parse(line.slice("[smooth-native] ".length));
      if (row.pid === pid && Array.isArray(row.files) && row.files.every(file => typeof file === "string")) return row.files;
    } catch {}
  }
  return [];
}

/** Read-only startup proof. No authenticated request may precede the owned-PID check. */
export async function packagedStartupPreflight({ health, expectedPid, expectedData, secret, readLog, call, waitFor, expectedNative = null, platform = process.platform,
  readDataDir = () => observedDataDir(expectedData, expectedPid, { platform }) }) {
  if (!Number.isInteger(expectedPid) || health?.pid !== expectedPid) throw Error("health belongs to another process (PID mismatch)");
  await waitFor(() => /^\[eld\] /m.test(readLog()), { cap: 5000, every: 100 });
  const handshake = await call("GET", "/api/desktop-secret", undefined, 5000);
  const auth = await call("GET", "/api/storage", undefined, 5000);
  // The preload reports native loads on its next timer tick, including a load caused by /api/storage.
  if (expectedNative) await waitFor(() => observedNativeFiles(readLog(), expectedPid).length > 0, { cap: 5000, every: 100 });
  const log = readLog();
  const evidence = { expectedData, observedData: readDataDir(), pid: health.pid, expectedPid,
    authStatus: auth.status, secretAccepted: handshake.status === 200 && handshake.json?.secret === secret };
  const refusal = packagedPreflightRefusal({ ...evidence, log, platform });
  if (refusal) throw Error(refusal);
  if (expectedNative) {
    const files = observedNativeFiles(log, expectedPid);
    if (files.length !== 1 || files[0].toLowerCase() !== expectedNative.toLowerCase()) throw Error("compiled loader did not open the hashed packaged engine-exclusion.node");
  }
  return { ...evidence, auth: "explicit Node-mode dev fixture", startupOk: true };
}

/** One isolated turn proves tracing before scenarios; all operations are supplied by the rig. */
export async function packagedTracePreflight({ makeBot, call, logSize, logFrom, readStartupLog, waitFor, settleBot, evidence, platform = process.platform }) {
  const probe = await makeBot("Smooth preflight", "fast");
  const mark = logSize();
  const sent = await call("POST", `/api/bots/${probe.id}/messages`, { threadId: probe.threadId, text: "Reply with the single word ready." }, 30_000);
  if (sent.status < 200 || sent.status >= 300) throw Error(`preflight turn rejected (${sent.status})`);
  await waitFor(() => /^\[turn-trace\] id=\w+ phase=/m.test(logFrom(mark)), { cap: 30_000, every: 250 });
  const refusal = packagedPreflightRefusal({ ...evidence, log: readStartupLog(), traceLog: logFrom(mark), requireTrace: true, platform });
  if (refusal) throw Error(refusal);
  const settled = await settleBot(probe.id, probe.threadId, 30_000);
  if (!settled.settled) throw Error("preflight turn did not stop");
  const deleted = await call("DELETE", `/api/bots/${probe.id}`);
  if (deleted.status !== 200 && deleted.status !== 404) throw Error(`preflight bot cleanup rejected (${deleted.status})`);
  return { ...evidence, ok: true, turnTrace: true };
}

/** Persist refusal before cleanup; even a failed stop must leave a failing exit code. */
export async function refusePackagedLeg(reason, { results, save, report, stop, exit }) {
  const message = reason.startsWith("smooth.mjs refuses") ? reason : `smooth.mjs refuses packaged leg: ${reason}`;
  results.preflight = { ...results.preflight, ok: false, refusal: message };
  results.status = "INVALID";
  try { save(); report(message); } finally {
    try { await stop(); } finally { exit(2); }
  }
}
