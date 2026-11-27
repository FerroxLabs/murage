// Windows computer-use runtime: the supervised cua-driver daemon in Electron main (DESIGN 1022-cua-windows r6).
// Owner: the Windows builder lane (build-1022-cua-windows). Main (electron/main.mjs, electron/cua.mjs) calls it; the
// harness hears it only through shared/cua-host-messages.mjs over the private utility-process port.
//
// Everything platform- or process-bound is injected ({spawn, taskkill, port, clock, fs, native, ...}) and nothing here
// requires `electron`, so the server tests can load it in-process with its port wired to the harness's real handler.
//
// One state machine (section 4a): off -> checking -> starting(G) -> ready(G); every stop is the D15 order
// (live:null + withdrawn:G and the descriptor deleted, then taskkill on the exact pid, then retired:G only after the
// child's own exit); every stop bumps the start epoch first (D18), so nothing that began before it can spawn, from any
// await point; and the one process creation is spawnIfCurrent(e).
const { withHideInherit } = require("../shared/win-hide-child-process.mjs");
const { randomBytes } = require("node:crypto");
const nodeFs = require("node:fs");
const path = require("node:path");
const messages = require("../shared/cua-host-messages.mjs");
const { fileIdentity, verifyExeIdentity: defaultVerifyExeIdentity } = require("../shared/cua-driver-identity.mjs");

const WIN_CUA_STOP_MS = 5_000;
const HANDSHAKE_MS = 10_000;
const PROBE_MS = 5_000;
const GONE_POLL_MS = 100;
const DRIVER_VERSION = "0.55.0";
const CONTRACT_VERSION = "0.9.0";
const MEDIUM_LABELS = new Set(["S-1-16-8192", "S-1-16-8448"]);
const ELEVATED_LABELS = new Set(["S-1-16-12288", "S-1-16-16384"]);
const DRIVER_ENV = Object.freeze({
  CUA_DRIVER_EMBEDDED: "1",
  CUA_DRIVER_HOST_BUNDLE_ID: "com.murage.app",
  CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
  CUA_DRIVER_RS_UPDATE_CHECK: "false",
  DO_NOT_TRACK: "1",
});

const COPY = Object.freeze({
  "windows-elevated": "Murage is running as administrator, so Local control is off. Start Murage normally, not with Run as administrator. If this Windows account always runs apps as administrator (UAC turned off, or the built-in Administrator account), Local control can't be used on it.",
  "windows-integrity-unknown": "Murage couldn't confirm it is running without administrator rights, so Local control is off. Restart Murage to try again.",
  "windows-arm64-unsupported": "Local control isn't available on Windows on Arm yet.",
  "driver-integrity": "This computer's driver failed its integrity check, so nothing was performed. The owner can reinstall Murage.",
  "start-failed": "Computer control's driver didn't start. Use Retry to try again.",
  "driver-exited": "Computer control's driver stopped. Use Retry to start it again.",
  "driver-stuck": "Computer control's driver didn't stop when asked. Restart Murage to use Local control again.",
});
const SAVE_FAILED = "Local control was stopped, but Murage couldn't save the setting, so it may turn on again when Murage restarts. Switch it off again.";

/** The Windows Local control switch (default OFF). libuv reports every writable Windows file as mode 0o666, so the
 * Linux store's group/other-bits check would read every saved "on" as off; this one checks the exact JSON only. */
function createWindowsCuaPreferenceStore({ getUserData, fileSystem = nodeFs } = {}) {
  const preferencePath = () => path.join(getUserData(), "cua-local-control-win32.json");
  return Object.freeze({
    read() {
      try {
        const stat = fileSystem.lstatSync(preferencePath());
        if (!stat.isFile() || stat.isSymbolicLink()) return false;
        const value = JSON.parse(fileSystem.readFileSync(preferencePath(), "utf8"));
        return value?.schemaVersion === 1 && value?.windowsLocalControlEnabled === true
          && Object.keys(value).every((key) => ["schemaVersion", "windowsLocalControlEnabled"].includes(key));
      } catch { return false; }
    },
    write(enabled) {
      const file = preferencePath();
      const temporary = `${file}.${process.pid}.tmp`;
      fileSystem.mkdirSync(path.dirname(file), { recursive: true });
      fileSystem.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, windowsLocalControlEnabled: Boolean(enabled) }));
      fileSystem.renameSync(temporary, file);
    },
  });
}

/** D4: the parent env with every CUA_* key and DO_NOT_TRACK removed, then exactly the driver's keys. */
function driverSpawnEnv(parentEnv, extra = {}) {
  const base = {};
  for (const [key, value] of Object.entries(parentEnv ?? {})) {
    if (/^CUA_/i.test(key) || key.toUpperCase() === "DO_NOT_TRACK") continue;
    base[key] = value;
  }
  return { ...base, ...extra, ...DRIVER_ENV };
}

/** D8: allowed only for a parsable CSV with exactly one mandatory-label row that is Medium or Medium Plus. */
function classifyWhoamiGroups(result) {
  if (!result || result.code !== 0 || typeof result.stdout !== "string") return "windows-integrity-unknown";
  const labels = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = line.match(/^"([^"]*)","([^"]*)","([^"]*)","([^"]*)"$/);
    if (!cells) return "windows-integrity-unknown";
    if (/^S-1-16-\d+$/.test(cells[3])) labels.push(cells[3]);
  }
  if (labels.length !== 1) return "windows-integrity-unknown";
  if (ELEVATED_LABELS.has(labels[0])) return "windows-elevated";
  return MEDIUM_LABELS.has(labels[0]) ? "allowed" : "windows-integrity-unknown";
}

/** D19: `tasklist /FI "PID eq n" /FO CSV /NH` positively parsed as zero process rows. Anything else is not proof. */
function tasklistShowsNoProcess(result, pid) {
  if (!result || result.code !== 0 || typeof result.stdout !== "string") return false;
  const lines = result.stdout.split(/\r?\n/).filter((line) => line.trim());
  if (lines.some((line) => new RegExp(`^"[^"]*","${pid}",`).test(line))) return false;
  // With no match tasklist prints exactly this one line and no CSV row. Empty output, any CSV row (even another pid), a
  // localized or any other line is not proof (it stays UNKNOWN).
  return lines.length === 1 && lines[0].trim() === "INFO: No tasks are running which match the specified criteria.";
}

/** A verifier answer that is a real integrity verdict (bytes or file object wrong) vs one that only could not read. */
const integrityVerdict = (answer) => (answer?.reason === "busy" || answer?.reason === "unreadable" ? "start-failed" : "driver-integrity");

const validStart = (value) => typeof value === "string" && /^[1-9]\d{0,19}$/.test(value);

function cuaStopStageMs(platform) {
  return platform === "win32" ? WIN_CUA_STOP_MS + 1_000 : 2_500;
}

/** D14: the one computer-use stage of quit/update on win32. It never awaits a pending start first: the runtime's own
 * stop() handles `starting`. Rejects (cleanup incomplete) when the stop does not settle inside `ms`. */
function cuaCleanupStage({ stop, ms, clock = globalThis }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = clock.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(Object.assign(new Error("Computer-use cleanup has not completed"), { code: "cua-stop-timeout" }));
    }, ms);
    Promise.resolve().then(stop).then(
      (value) => { if (!settled) { settled = true; clock.clearTimeout(timer); resolve(value); } },
      (error) => { if (!settled) { settled = true; clock.clearTimeout(timer); reject(error); } },
    );
  });
}

/** D10 a, D16, D20: the harness messages main routes to the runtime (the one function electron/main.mjs's server-process
 * `message` handler calls). `-ready` re-sends the desktop state, only for the server process main currently serves
 * (`isCurrent`); each of the three types is delivered to the runtime's harness handler exactly once. true = handled. */
function routeHarnessMessage(message, { isCurrent, wire, deliver }) {
  const type = message && message.type;
  if (type !== messages.HOST_DESKTOP_READY && type !== messages.CUA_STUCK && type !== messages.CUA_INTEGRITY) return false;
  if (type === messages.HOST_DESKTOP_READY && isCurrent) wire?.onReady();
  deliver(message);
  return true;
}

/** D10 a: main's side of the host-desktop channel. Called for every server process main starts. */
function wireHostDesktop({ lock, port }) {
  const send = () => {
    try { port.postMessage(messages.hostDesktopMessage(messages.desktopStateFromLock(lock.state()))); } catch { /* the harness may be gone */ }
  };
  const unsubscribe = lock.onChange?.(() => send());
  const refreshAndSend = () => {
    try { lock.refresh?.(); } catch { /* the reading stays what it was */ }
    send();
  };
  refreshAndSend();
  return Object.freeze({ onReady: refreshAndSend, dispose: () => { try { unsubscribe?.(); } catch {} } });
}

function createWindowsCuaRuntime({
  resourcesPath,
  runtimeDir,
  preferenceStore,
  port = { postMessage() {} },
  spawn,
  taskkill,
  runProbe,
  runTasklist,
  native = {},
  arm64 = async () => false,
  verifyExeIdentity = defaultVerifyExeIdentity,
  statIdentity = (file) => fileIdentity(nodeFs.statSync(file, { bigint: true })),
  pins,
  handshake,
  writeDescriptor = () => {},
  deleteDescriptor = () => {},
  fs = nodeFs,
  clock = globalThis,
  env = process.env,
  processId = process.pid,
  generationId = () => randomBytes(6).toString("hex"),
  onChange = () => {},
} = {}) {
  const exeDir = path.join(resourcesPath ?? "", "cua-win32-x64");
  const driverPath = path.join(exeDir, "cua-driver.exe");
  const cursorPath = path.join(exeDir, "cua-cursor-theme.exe");
  const ownerRecordPath = path.join(runtimeDir ?? "", "driver.owner.json");

  let epoch = 0;
  let state = { status: "off" };
  let enabled = false;
  let quitting = false;
  let owned = null; // { generation, child, pid, exited, exitPromise }
  let retained = null; // a pid whose exit was never confirmed (driver-stuck): no spawn while it lives
  let liveHarness = null;
  let probeChild = null;
  let openHashes = new Set();

  const post = (message) => {
    try { port.postMessage(message); } catch { /* fire-and-forget: a gone harness never delays a stop */ }
  };
  /** An answer to one harness process goes to that process (main may not have named it as the port yet). */
  const reply = (proc, message) => {
    if (proc && typeof proc.postMessage === "function" && proc !== port) {
      try { proc.postMessage(message); } catch {}
      return;
    }
    post(message);
  };
  const setState = (next) => {
    state = next;
    try { onChange(status()); } catch {}
  };
  const unavailable = (code) => setState({ status: "unavailable", reasonCode: code, message: COPY[code] });
  const status = () => ({
    enabled,
    status: state.status,
    available: state.status === "ready",
    reasonCode: state.reasonCode,
    message: state.message,
    generation: state.generation,
  });
  const liveGeneration = () => (state.status === "ready" ? state.generation : null);

  // ---------- D19: the owner record, pid AND process start time ----------
  /** null: no record (nothing of ours can be left; a driver without one exits by parent liveness). Otherwise the
   * record, with `start` null when it could not be read at spawn, or `unreadable` when the file is there but broken. */
  const readOwnerRecord = () => {
    let text;
    try { text = fs.readFileSync(ownerRecordPath, "utf8"); }
    catch (error) { return error?.code === "ENOENT" ? null : { unreadable: true }; }
    try {
      const value = JSON.parse(text);
      if (!Number.isInteger(value?.pid) || value.pid <= 0) return { unreadable: true };
      return { pid: value.pid, start: validStart(value.start) ? value.start : null, generation: value.generation };
    } catch { return { unreadable: true }; }
  };
  const removeOwnerRecord = () => { try { fs.rmSync(ownerRecordPath, { force: true }); } catch {} };
  const processStart = (pid) => {
    try {
      const start = native.processStart?.(pid);
      return validStart(start) ? start : null;
    } catch { return null; }
  };
  /** A positive "no process holds this pid" when processStart has no start to give: the native answer (OpenProcess
   * reports no such process, or the process object has exited; locale-independent), else the tasklist parse. */
  const provenAbsent = async (pid) => {
    try { if (native.processPresence?.(pid) === "absent") return true; } catch {}
    try { return tasklistShowsNoProcess(await runTasklist(pid), pid); } catch { return false; }
  };
  /** Death proven only positively: a valid, different start for that pid, or no process for it (provenAbsent). */
  const gone = async (pid, recordedStart) => {
    const now = processStart(pid);
    if (now !== null && now !== recordedStart) return true;
    if (now === recordedStart) return false;
    return provenAbsent(pid);
  };
  const confirmGone = async (pid, start) => {
    const deadline = clock.now() + WIN_CUA_STOP_MS;
    for (;;) {
      if (await gone(pid, start)) return true;
      if (clock.now() >= deadline) return false;
      await new Promise((resolve) => clock.setTimeout(resolve, GONE_POLL_MS));
    }
  };
  /** "ok" (nothing of ours is left) or "stuck" (UNKNOWN or not confirmed: fail closed, record kept). */
  const stopLeftover = async () => {
    const record = readOwnerRecord();
    if (!record) return "ok"; // a bare driver.pid is never proof; the orphan exits by parent liveness
    if (record.unreadable) return "stuck"; // a record we cannot read is UNKNOWN, never "nothing left"
    const now = processStart(record.pid);
    if (now === null || record.start === null) {
      // no start to compare (unreadable now, or never recorded): only a positive "no such process" lets us go on
      if (!(await provenAbsent(record.pid))) return "stuck";
      removeOwnerRecord();
      return "ok";
    }
    if (now !== record.start) { removeOwnerRecord(); return "ok"; } // a valid, different start: a reused pid, never killed
    let answer = "unknown";
    try { answer = native.terminateIfStart?.(record.pid, record.start) ?? "unknown"; } catch {}
    if (answer === "mismatch") { removeOwnerRecord(); return "ok"; }
    if (answer !== "terminated") return "stuck";
    if (!(await confirmGone(record.pid, record.start))) return "stuck";
    removeOwnerRecord();
    return "ok";
  };

  // ---------- D18: the check, under the start epoch ----------
  const runElevationProbe = () => new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (!done) { done = true; clock.clearTimeout(timer); probeChild = null; resolve(value); } };
    const timer = clock.setTimeout(() => {
      try { if (probeChild?.pid) taskkill(probeChild.pid); } catch {}
      finish({ code: null, stdout: "", timedOut: true });
    }, PROBE_MS);
    try {
      const run = runProbe({ onChild: (child) => { probeChild = child; } });
      Promise.resolve(run).then(finish, () => finish({ code: null, stdout: "" }));
    } catch { finish({ code: null, stdout: "" }); }
  });
  const verify = (file, pin) => verifyExeIdentity(file, pin);

  const spawnIfCurrent = (e, generation, driverIdentity) => {
    // The compare and the spawn are one synchronous block: the only place a driver process is created.
    // never a second driver beside a live or unconfirmed one
    if (epoch !== e || retained || owned) return null;
    // D6 a: the path still names the file object hashed through the fd (the cursor hash ran after the driver's)
    let identityNow = null;
    try { identityNow = statIdentity(driverPath); } catch {}
    if (!identityNow || !driverIdentity || Object.keys(driverIdentity).some((key) => driverIdentity[key] !== identityNow[key])) return { failed: "integrity" };
    const pipe = `\\\\.\\pipe\\murage-cua-${processId}-${generation}`;
    let child;
    try {
      child = spawn(driverPath, [
      "serve", "--embedded", "--socket", pipe,
      "--pid-file", path.join(runtimeDir ?? "", "driver.pid"),
      "--permission-mode", "standard",
      ], withHideInherit({
        env: driverSpawnEnv(env, { CUA_DRIVER_PARENT_LIVENESS_STDIN: "1" }),
        windowsHide: true,
        shell: false,
        stdio: ["pipe", "ignore", "ignore"],
      }));
    } catch {
      return { failed: true };
    }
    let resolveExit;
    const record = { generation, child, pid: child.pid, pipe, exited: false, ready: false, exitPromise: new Promise((resolve) => { resolveExit = resolve; }) };
    const ended = () => { if (record.exited) return; record.exited = true; resolveExit(); onOwnedExit(record); };
    child.once?.("exit", ended);
    // a blocked exe (antivirus, a removed file) emits error with no pid and no exit: it never ran
    child.once?.("error", ended);
    owned = record;
    if (Number.isInteger(child.pid) && child.pid > 0) {
      const start = processStart(child.pid);
      try {
        fs.mkdirSync(runtimeDir, { recursive: true });
        fs.writeFileSync(ownerRecordPath, JSON.stringify({ pid: child.pid, start, generation }));
      } catch { /* an unrecorded driver still exits with its parent (stdin liveness) */ }
    }
    return record;
  };

  // The join a stop waits for: the pre-spawn part of the current check (D18). Once a child exists the stop handles it
  // itself (taskkill + exit), so a handshake that never answers can never hold a stop.
  let preSpawnSettled = Promise.resolve();
  const check = async (e, preSpawnDone) => {
    setState({ status: "checking" });
    try { return await checkUntilSpawn(e, preSpawnDone); } finally { preSpawnDone(); }
  };
  const checkUntilSpawn = async (e, preSpawnDone) => {
    if ((await stopLeftover()) !== "ok") {
      // recorded whatever the epoch: a stop that came in during the query must still see it (cleanup is not done)
      retained = retained ?? { leftover: true };
      if (epoch === e) unavailable("driver-stuck");
      return;
    }
    if (epoch !== e) return;
    const onArm = await arm64();
    if (epoch !== e) return;
    if (onArm) { unavailable("windows-arm64-unsupported"); return; }
    const verdict = classifyWhoamiGroups(await runElevationProbe());
    if (epoch !== e) return;
    if (verdict !== "allowed") { unavailable(verdict); return; }
    const driverOk = await verify(driverPath, pins?.driver);
    if (epoch !== e) return;
    if (!driverOk?.ok) { unavailable(integrityVerdict(driverOk)); return; }
    const cursorOk = await verify(cursorPath, pins?.cursor);
    if (epoch !== e) return;
    if (!cursorOk?.ok) { unavailable(integrityVerdict(cursorOk)); return; }
    const generation = generationId();
    const record = spawnIfCurrent(e, generation, driverOk.identity);
    if (!record) { if (epoch === e) unavailable("driver-stuck"); return; }
    if (record.failed) { if (epoch === e) unavailable(record.failed === "integrity" ? "driver-integrity" : "start-failed"); return; }
    setState({ status: "starting", generation });
    preSpawnDone();
    let ready = false;
    try {
      ready = await Promise.race([
        handshake({ pipe: record.pipe, child: record.child, timeoutMs: HANDSHAKE_MS }),
        record.exitPromise.then(() => false),
      ]);
    } catch { ready = false; }
    if (epoch !== e || owned !== record || record.exited) return; // withdrawn while starting: never enters ready(G)
    if (!ready) { await stopGeneration("restart", { nextState: () => unavailable("start-failed") }).catch(() => {}); return; }
    try {
      writeDescriptor({
        mode: "windows-supervised", platform: "win32", schemaVersion: 1, status: "ready", generation,
        driver: { path: driverPath, version: DRIVER_VERSION, source: "bundled", sha256: pins?.driver, fileIdentity: driverOk.identity },
        daemon: { pipe: record.pipe, pid: record.pid, contractVersion: CONTRACT_VERSION, toolsListSchemaVersion: "1", capabilityVersion: "1", mcpProtocolVersion: "2025-06-18" },
        mcp: { command: driverPath, args: ["mcp", "--embedded", "--socket", record.pipe], env: { ...DRIVER_ENV } },
      });
    } catch { /* the harness then sees no descriptor and mounts nothing */ }
    record.ready = true;
    setState({ status: "ready", generation });
    // to the harness that asked with -ready (main may not have named it as the port yet), else the port
    reply(liveHarness, messages.liveMessage(generation));
  };

  const startCheck = () => {
    if (quitting || !enabled) return Promise.resolve();
    epoch += 1;
    const e = epoch;
    let preSpawnDone;
    preSpawnSettled = new Promise((resolve) => { preSpawnDone = resolve; });
    const run = check(e, preSpawnDone).catch(() => { if (epoch === e) unavailable("start-failed"); });

    return run;
  };

  // ---------- D14 / D15: one stop, one order ----------
  const onOwnedExit = (record) => {
    if (owned !== record) return;
    if (record.stopping) return; // the stop path posts retired after it sees this exit
    owned = null;
    post(messages.liveMessage(null));
    post(messages.withdrawnMessage(record.generation, "restart"));
    try { deleteDescriptor(); } catch {}
    post(messages.retiredMessage(record.generation));
    removeOwnerRecord();
    unavailable(record.ready ? "driver-exited" : "start-failed");
  };

  const stopGeneration = async (cause, { nextState } = {}) => {
    epoch += 1; // D18: before anything else
    const record = owned;
    if (probeChild?.pid) { try { taskkill(probeChild.pid); } catch {} }
    if (!record) {
      await preSpawnSettled;
      if (retained && await retainedStillAlive()) {
        unavailable("driver-stuck");
        throw Object.assign(new Error("A computer-use driver Murage could not confirm stopped is still there"), { code: "cua-stop-timeout" });
      }
      nextState?.();
      return;
    }
    record.stopping = true;
    // (1) fence admission: fire-and-forget, never awaited
    post(messages.liveMessage(null));
    post(messages.withdrawnMessage(record.generation, cause));
    try { deleteDescriptor(); } catch {}
    setState({ status: "stopping", generation: record.generation });
    // (2) taskkill on the exact pid, then the child's own exit, bounded
    if (!record.exited) { try { Promise.resolve(taskkill(record.pid)).catch(() => {}); } catch {} }
    let timer;
    const exited = record.exited || await Promise.race([
      record.exitPromise.then(() => true),
      new Promise((resolve) => { timer = clock.setTimeout(() => resolve(false), WIN_CUA_STOP_MS); }),
    ]);
    clock.clearTimeout(timer);
    await preSpawnSettled;
    if (!exited) {
      retained = record;
      unavailable("driver-stuck");
      throw Object.assign(new Error("Computer-use driver did not stop"), { code: "cua-stop-timeout" });
    }
    // (3) only after the exit: retire G, drop the owner record
    if (owned === record) owned = null;
    if (retained === record) retained = null;
    post(messages.retiredMessage(record.generation));
    removeOwnerRecord();
    nextState?.();
  };

  /** A stop of whatever is current. Rejects with cua-stop-timeout when a child never exits. */
  let stopInFlight = Promise.resolve();
  const stop = (cause, nextState) => {
    const run = stopGeneration(cause, { nextState });
    stopInFlight = run.catch(() => {});
    return run;
  };

  const retainedStillAlive = async () => {
    if (!retained) return false;
    if (retained.leftover) {
      // a later positive answer (gone, or stopped by pid + start) clears the marker; UNKNOWN keeps it
      const alive = (await stopLeftover()) !== "ok";
      if (!alive) retained = null;
      return alive;
    }
    if (retained.exited) { retained = null; return false; }
    const start = processStart(retained.pid);
    if (start === null && await provenAbsent(retained.pid)) { retained = null; return false; }
    return true;
  };

  const restart = async (cause) => {
    // stuck only when THIS stop left something unconfirmed (it rejects and keeps `retained`), never because an earlier
    // driver-stuck is still on the card: a leftover proven gone since then must get a fresh driver
    let failed = false;
    await stop(cause).catch(() => { failed = true; });
    if (failed) return status();
    if (!enabled) return status();
    await startCheck();
    return status();
  };

  const api = {
    async initialize() {
      if (quitting) return status();
      enabled = preferenceStore.read() === true;
      if (!enabled) {
        // D19 at app start, switch on or off: a leftover is stopped (or kept as UNKNOWN) before anything else, inside
        // the join a quit/update stop waits for, so cleanup can never report done over it.
        let done;
        preSpawnSettled = new Promise((resolve) => { done = resolve; });
        try {
          if ((await stopLeftover()) !== "ok") retained = retained ?? { leftover: true };
        } finally { done(); }
        setState({ status: "off" });
        return status();
      }
      await startCheck();
      return status();
    },
    async enable() {
      if (quitting) return status();
      enabled = true;
      preferenceStore.write(true);
      await stopInFlight;
      if (await retainedStillAlive()) { unavailable("driver-stuck"); return status(); }
      if (quitting || !enabled) return status(); // a Disable or Quit came in while this Enable waited
      if (owned || state.status === "checking") return status();
      await startCheck();
      return status();
    },
    /** D17 d: the stop starts first and does not depend on the harness or on the preference being saved. */
    async disable() {
      enabled = false;
      const stopping = stop("disable", () => { if (!enabled) setState({ status: "off" }); }).catch(() => {});
      let saveError = null;
      try { preferenceStore.write(false); } catch (error) { saveError = error; }
      await stopping;
      if (saveError) throw Object.assign(new Error(SAVE_FAILED), { code: "preference-save-failed" });
      return status();
    },
    async retry() {
      if (!enabled || quitting) return status();
      if (await retainedStillAlive()) { unavailable("driver-stuck"); return status(); }
      return restart("restart");
    },
    /** quit / update: the D14 stage calls this through cuaCleanupStage. */
    async shutdown(cause = "quit") {
      quitting = true;
      await stop(cause === "update" ? "update" : "quit");
      return status();
    },
    /** D16/D20/D6b: harness -> main, routed by main's proc.on("message"). `proc` is the sending utility process. */
    onHarnessMessage(message, proc) {
      const parsed = messages.parseHostMessage(message);
      if (!parsed) return false;
      if (parsed.type === messages.HOST_DESKTOP_READY) {
        const live = liveGeneration();
        const busy = state.status === "ready" || state.status === "starting";
        if (busy && liveHarness && proc !== liveHarness) {
          // D20: another harness while G is live or starting -> stop G (restart) and start over; never live:G to it.
          liveHarness = proc;
          reply(proc, messages.liveMessage(null));
          void restart("restart");
          return true;
        }
        if (!liveHarness || state.status !== "ready") liveHarness = proc;
        reply(proc, messages.liveMessage(live));
        return true;
      }
      const generation = parsed.generation;
      if (generation !== liveGeneration()) return true; // stale: never stops G+1
      if (parsed.type === messages.CUA_STUCK) { void restart("restart"); return true; }
      if (parsed.type === messages.CUA_INTEGRITY) {
        void stop("integrity", () => unavailable("driver-integrity")).catch(() => {});
        return true;
      }
      return false;
    },
    /** The harness process ended (D20): a stop of a live or starting G with cause restart. */
    onHarnessExit(proc) {
      if (proc !== liveHarness) return;
      liveHarness = null;
      if (state.status === "ready" || state.status === "starting") void restart("restart");
    },
    getStatus: status,
    // test seams (read-only views)
    get epoch() { return epoch; },
    get ownedPid() { return owned?.pid ?? null; },
    get retainedPid() { return retained?.pid ?? null; },
  };
  return Object.freeze(api);
}

/** The real Windows dependencies (production only; every test injects its own). System32 programs run by absolute
 * path with windowsHide and no shell; the handshake asks the daemon's private pipe for its metadata. */
function windowsProductionDeps({ userData, env = process.env, requestPipe }) {
  const { spawn, execFile } = require("node:child_process");
  const system32 = path.join(env.SystemRoot || "C:\\Windows", "System32");
  const run = (exe, args, { timeoutMs = PROBE_MS, onChild } = {}) => new Promise((resolve, reject) => {
    const child = execFile(path.join(system32, exe), args, withHideInherit({ windowsHide: true, shell: false, timeout: timeoutMs, maxBuffer: 1024 * 1024 }), (error, stdout) => {
      if (error && error.code === "ENOENT") { reject(error); return; }
      resolve({ code: error ? (typeof error.code === "number" ? error.code : null) : 0, stdout: String(stdout ?? "") });
    });
    onChild?.(child);
  });
  const descriptorPath = path.join(userData, "cua-connection.json");
  return {
    spawn,
    taskkill: (pid) => run("taskkill.exe", ["/PID", String(pid), "/T", "/F"]).catch(() => {}),
    runProbe: ({ onChild } = {}) => run("whoami.exe", ["/groups", "/fo", "csv", "/nh"], { onChild }),
    runTasklist: (pid) => run("tasklist.exe", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]),
    handshake: async ({ pipe, child, timeoutMs }) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline && child.exitCode === null) {
        try {
          const metadata = (await requestPipe(pipe, { method: "metadata" }))?.result;
          return metadata?.driver_version === DRIVER_VERSION && metadata?.contract_version === CONTRACT_VERSION && metadata?.pid === child.pid;
        } catch { await new Promise((resolve) => setTimeout(resolve, 75)); }
      }
      return false;
    },
    writeDescriptor: (descriptor) => {
      const temporary = `${descriptorPath}.${process.pid}.tmp`;
      nodeFs.writeFileSync(temporary, JSON.stringify(descriptor), { mode: 0o600 });
      nodeFs.renameSync(temporary, descriptorPath);
    },
    deleteDescriptor: () => nodeFs.rmSync(descriptorPath, { force: true }),
  };
}

module.exports = {
  CONTRACT_VERSION,
  COPY,
  DRIVER_ENV,
  DRIVER_VERSION,
  SAVE_FAILED,
  WIN_CUA_STOP_MS,
  classifyWhoamiGroups,
  createWindowsCuaPreferenceStore,
  createWindowsCuaRuntime,
  cuaCleanupStage,
  cuaStopStageMs,
  driverSpawnEnv,
  routeHarnessMessage,
  tasklistShowsNoProcess,
  windowsProductionDeps,
  wireHostDesktop,
};
