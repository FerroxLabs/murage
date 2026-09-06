// The companion sidecar's lifecycle, as seen by the desktop app.
//
// The sidecar is a separate process on purpose — it is the only thing here
// that listens off-machine, and keeping it out of the harness is what lets
// the harness stay loopback-only and unpatched. But "separate process" does
// not have to mean "open a terminal": the app already forks the harness the
// same way, and a toggle in Settings is what anyone actually wants.
//
// The renderer never talks to the sidecar's control port directly. It calls
// through here, which keeps the UI on one origin, avoids CORS, and means the
// narrow list of things the renderer may ask for is written down in one
// place rather than implied by whatever the control server happens to serve.
import { app, utilityProcess } from "electron";
import fs from "node:fs";
import path from "node:path";
import { resolveCompanionEntry } from "./companion-entry.mjs";
import { createServerChildLifecycle } from "./server-child-lifecycle.mjs";
import {
  cleanupCompanionOriginEndpoint,
  companionOriginHealth,
  createCompanionOriginEndpoint,
} from "./companion-origin-gateway.mjs";

// Passed to the fork rather than left to the sidecar's own defaults, so the
// port this file fetches the control API on cannot drift from the port the
// sidecar opened. They must stay clear of the harness, which takes 8799 for
// itself and 8800 for its webhook receiver — the sidecar refuses to start on
// either and says which, rather than racing it for the socket.
// Overridable only so the two suites that stand up a fake control server can
// run while a real Murage desktop is on 8811 — which is always, on the machine
// this is developed on. They used to hard-code it and skip instead, so the
// door's own tests went quiet on exactly the machine that could break it.
// Unset in every real launch, which is what keeps the default authoritative.
const CONTROL_PORT = Number(process.env.MURAGE_CONTROL_PORT_OVERRIDE) || 8811;
const COMPANION_PORT = 8810;
/** The browser door. 8813 and not 8812: companion-origin-gateway.mjs already
 * owns 8812 for the managed loopback gateway, so the two would have collided.
 *
 * Passed to the fork for the same reason the two above are — the panel reports
 * this port to a phone, and a default that lived only in the sidecar could
 * drift from the number the desktop tells people to type. */
const BROWSER_PORT = 8813;
/** Left unset in the child would give the sidecar its own default. Stated
 * here, and stated as the *preference* rather than a demand: `auto` binds the
 * tailnet address when there is one and loopback when there is not, which is
 * the only setting that is right on a laptop where Tailscale comes up minutes
 * after the app does. An operator who wants one or the other exactly still
 * sets MURAGE_BROWSER_BIND in the environment and it survives — this is a
 * default the fork supplies, not an override it imposes. */
const BROWSER_BIND = "auto";
/** Plain HTTP. The door is reached over WireGuard, which is the encryption;
 * `https` is for after `tailscale serve` is in front with a real certificate,
 * and it is not a thing to claim before it is true — the value decides the
 * cookie name and whether `Secure` is set, so claiming it early breaks the
 * session rather than merely mislabelling it. */
const BROWSER_SCHEME = "http";
/** Where `tailscale serve` forwards, when the desktop turns it on.
 *
 * Loopback and not the tailnet address, and this is the whole of defect 2:
 * `serve` proxies to `http://127.0.0.1:8813`, so a door that took the
 * `auto` preference and bound the tailnet address instead has nothing
 * listening where serve connects. Serve then answers 443 with a 502 while
 * every local probe says the door is healthy. */
export const BROWSER_LOOPBACK_TARGET = `http://127.0.0.1:${BROWSER_PORT}`;

/** The door, as the panel sees it when there is no sidecar to ask.
 *
 * `null`, not an object with the port in it: "off" has to be a complete
 * answer, and a shape that carried a port while nothing listened on it is the
 * kind of half-truth the renderer would have to learn to disbelieve. */
const BROWSER_DOOR_OFF = null;

let proc = null;
let procLifecycle = null;
let lastError = null;
let advertisedHostedUrl = null;
/** The proxy origin the running sidecar was forked with, or null. This is
 * what the door is CURRENTLY advertising, as opposed to what the remembered
 * setting asks for — the two differ exactly while a toggle is failing, which
 * is when the panel most needs to say which one is true. */
let remoteAccessOrigin = null;
let originTarget = null;
let lifecycleListener = () => {};
const expectedStops = new WeakSet();

/** Where the sidecar's entry lives, and the Node flags it needs.
 *
 * Packaged, it is staged into resources alongside the harness. In dev the
 * compiled dist-companion output is preferred when it exists, and the
 * TypeScript source is the fallback — run with type stripping, exactly as
 * the `companion` script runs it — so the toggle works without a build step
 * nobody remembers. Returning null rather than a path that does not exist is
 * what lets the toggle say so instead of failing with a spawn error nobody
 * can read. */
const entryPoint = (resourcesPath) =>
  resolveCompanionEntry({
    isPackaged: app.isPackaged,
    resourcesPath,
    appPath: app.getAppPath(),
    exists: fs.existsSync,
  });

// ── the remembered toggle ────────────────────────────────────────────────
// The Settings toggle used to be the only thing that ever started the
// sidecar, so a paired phone died with every relaunch of the app: port 8810
// stayed closed until the user rediscovered the switch. The position of the
// toggle is state worth keeping, and it lives in the app's own userData —
// like cua-connection.json — because the app owns the toggle. Not in the
// sidecar's ~/.murage-companion, which is the child process's directory,
// and not in the harness's config.json, which is somebody else's data layout.

let connectionStorage = null;
let connectionTransitions = 0;
export function configureCompanionStorage(storage) {
  if (proc || connectionTransitions) throw new Error("Stop the companion before changing its connection storage");
  if (storage && (!path.isAbsolute(storage.settingsDirectory) || !path.isAbsolute(storage.stateDirectory))) throw new Error("Companion connection storage requires absolute paths");
  connectionStorage = storage ? { ...storage } : null;
}
const settingsFile = () => path.join(connectionStorage?.settingsDirectory ?? app.getPath("userData"), "companion-settings.json");

function companionSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    return {
      enabled: parsed?.enabled === true,
      keepAwake: parsed?.keepAwake === true,
      remoteAccess: parsed?.remoteAccess === true,
    };
  } catch {
    return { enabled: false, keepAwake: false, remoteAccess: false };
  }
}

/** Whether the user left the companion on. Anything unreadable is "off" —
 * the flag opens a network listener, so it fails closed. */
export function companionEnabledAtRest() {
  return companionSettings().enabled;
}

export function companionKeepAwakeAtRest() {
  return companionSettings().keepAwake;
}

/** Whether the user left remote browser access on.
 *
 * Remembered for the same reason the sidecar toggle is: `tailscale serve`
 * survives a reboot on its own, so an app that forgot would come back with a
 * proxy pointed at a door bound the other way — serve up, door on the tailnet
 * address, 502 for everyone. The two have to be restored together. */
export function companionRemoteAccessAtRest() {
  return companionSettings().remoteAccess;
}

/** Remember the toggle's position. Written via temp-and-rename so a crash
 * mid-write cannot leave a truncated file; a failed write costs auto-start
 * on the next launch, never the toggle itself. */
function rememberCompanionSettings(patch) {
  const file = settingsFile();
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    const next = { ...companionSettings(), ...patch };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(next, null, 2));
    fs.renameSync(temporary, file);
  } catch {
    try {
      fs.unlinkSync(temporary);
    } catch {
      /* never created, or already renamed */
    }
  }
}


export function rememberCompanionEnabled(enabled) {
  rememberCompanionSettings({ enabled });
}

export function rememberCompanionKeepAwake(keepAwake) {
  rememberCompanionSettings({ keepAwake });
}

export function rememberCompanionRemoteAccess(remoteAccess) {
  rememberCompanionSettings({ remoteAccess });
}

/** Adopt only an already-verified, exclusively owned Serve arrangement. This
 * never creates, replaces, or removes a Tailscale route. */
export function reconcileCompanionHttps(observed, log = () => {}) {
  if (!observed?.on || observed.reason || !observed.host) return;
  if (!companionRemoteAccessAtRest()) {
    rememberCompanionRemoteAccess(true);
    log(companionRemoteAccessAtRest()
      ? "adopted the existing owned HTTPS proxy; its remembered off state was stale"
      : "owned HTTPS proxy will be used, but its setting could not be remembered");
  }
}

/** Ask the sidecar's own control server, which is the same API the standalone
 * page uses. Short timeout: this is loopback, and a spinner in Settings that
 * never resolves is worse than an error. The budget is a parameter because
 * one call is not like the others — a Tailscale re-probe is bounded by a CLI
 * hunt on the far side, not by loopback latency. */
async function control(method, urlPath, body, { timeoutMs = 4000 } = {}) {
  const options = {
    method,
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (body !== undefined) {
    options.body = JSON.stringify(body);
    options.headers = { "content-type": "application/json" };
  }
  const res = await fetch(`http://127.0.0.1:${CONTROL_PORT}${urlPath}`, options);
  if (!res.ok && res.status !== 404) throw new Error(`companion control ${res.status}`);
  return res.json();
}

/** Whether this process owns a running sidecar. */
export function companionRunning() {
  return proc !== null;
}

/** The hosted route the owned sidecar is currently advertising. This is
 * process-local public state only; the connector credential never enters
 * this module. */
export function companionAdvertisedHostedUrl() {
  return proc ? advertisedHostedUrl : null;
}

/** The `https://<name>` origin the owned sidecar is advertising as its front,
 * or null when nothing is in front of the door. */
export function companionRemoteAccessOrigin() {
  return proc ? remoteAccessOrigin : null;
}

/** Exact private origin belonging to the currently owned sidecar. This value
 * is main-process-only and must never cross IPC into the renderer. */
export function companionOriginTarget() {
  return proc && originTarget ? { ...originTarget } : null;
}

/** Main installs one synchronous exit observer. It invalidates the guardian
 * before this module cleans up the generation's socket path. */
export function setCompanionLifecycleListener(listener = () => {}) {
  lifecycleListener = listener;
}

// Every lifecycle transition runs to completion before the next one begins.
//
// Without this the guards below look sufficient and are not, because each one
// is a check followed by an await. Three things go wrong, and all of them end
// with the toggle and reality disagreeing: two concurrent starts both pass
// `if (proc)` and fork two sidecars; a failed start overwrites the `proc` a
// successful one just published; and a stop issued mid-startup finds `proc`
// still null, so it kills nothing and the start it raced then publishes a
// sidecar the user has already asked to shut down.
let transition = Promise.resolve();

/** Queue a lifecycle transition behind whatever is already in flight. */
const serialize = (work) => {
  connectionTransitions++;
  const next = transition.then(work, work);
  void next.then(() => { connectionTransitions--; }, () => { connectionTransitions--; });
  // The chain itself must never carry a rejection forward, or one failed
  // transition would poison every transition after it.
  transition = next.then(
    () => {},
    () => {},
  );
  return next;
};

/** Fork the sidecar and wait for it to answer. Resolves with the panel's
 * state either way — a failed start is a message, never a thrown error. */
export function startCompanion(options) {
  return serialize(() => start(options));
}

/** Stop the sidecar and wait for it to actually be gone. */
export function stopCompanion() {
  return serialize(() => stop());
}

/** startCompanion's body, run inside the transition queue. */
async function start({ resourcesPath, harnessPort, companionToken, hostedUrl = null, remoteAccess = null, log }) {
  if (proc) return companionState();
  lastError = null;
  const resolved = entryPoint(resourcesPath);
  if (!resolved) {
    // In dev this now means even companion/src is gone — a broken checkout,
    // not a missing build step, so the old "run pnpm build:companion" advice
    // would send someone to a command that cannot help.
    lastError = app.isPackaged
      ? "the companion is missing from this build"
      : "the companion sources are missing from this checkout";
    return companionState();
  }
  log?.(`companion fork ${resolved.entry}`);

  let allocatedOrigin;
  try {
    allocatedOrigin = createCompanionOriginEndpoint();
  } catch {
    lastError = "the private companion origin could not be created";
    return companionState();
  }
  let cleanedOrigin = false;
  const cleanupOrigin = () => {
    if (cleanedOrigin) return;
    cleanedOrigin = true;
    cleanupCompanionOriginEndpoint(allocatedOrigin);
  };

  // Never inherit an endpoint from the launch environment. The main process
  // passes this value only after it has verified the managed connector, and
  // an inherited value would bypass that gate and make Settings claim a dead
  // or attacker-selected route is ready.
  const childEnvironment = { ...process.env };
  if (connectionStorage) childEnvironment.MURAGE_COMPANION_DIR = connectionStorage.stateDirectory;
  delete childEnvironment.MURAGE_COMPANION_HOSTED_URL;
  delete childEnvironment.MURAGE_COMPANION_INTERNAL_ORIGIN;
  delete childEnvironment.MURAGE_COMPANION_TOKEN;
  // Only the owned harness receives the parent's persistent-state lease.
  delete childEnvironment.MURAGE_INTERNAL_DATA_DIR_LEASE;
  if (companionToken) childEnvironment.MURAGE_COMPANION_TOKEN = companionToken;
  // Same reasoning: the door's public origin is decided here, per start, from
  // what `tailscale serve` was actually observed to be doing. An inherited
  // one would survive turning remote access off.
  delete childEnvironment.MURAGE_BROWSER_PUBLIC_ORIGIN;
  if (hostedUrl) childEnvironment.MURAGE_COMPANION_HOSTED_URL = hostedUrl;
  childEnvironment.MURAGE_COMPANION_INTERNAL_ORIGIN = allocatedOrigin.socketPath;

  let child;
  try {
    child = utilityProcess.fork(resolved.entry, [], {
      env: {
        ...childEnvironment,
        MURAGE_PORT: String(harnessPort),
        MURAGE_COMPANION_PORT: String(COMPANION_PORT),
        MURAGE_CONTROL_PORT: String(CONTROL_PORT),
        // The browser door. Named here so this file and the sidecar cannot
        // disagree about where it is, the same reason the two ports above are
        // passed rather than left to defaults.
        MURAGE_BROWSER_PORT: String(BROWSER_PORT),
        // Remote access OVERRIDES the operator's own environment here, where
        // everything else defers to it. That is not an oversight: `serve`
        // connects to 127.0.0.1:8813, so `MURAGE_BROWSER_BIND=tailnet` with
        // remote access on is not a preference to honour, it is a
        // configuration that cannot work — serve reaching nothing, reported
        // as a 502 from a door that all local checks call healthy. The
        // operator's value is honoured in full whenever remote access is off,
        // which is the shipped default.
        ...browserDoorEnvironment(childEnvironment, remoteAccess),
      },
      // how the TS-source fallback gets --experimental-strip-types; empty for
      // compiled entries
      execArgv: resolved.execArgv,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    cleanupOrigin();
    lastError = "the companion process could not be started";
    return companionState();
  }
  // Own the process before probing: failed and not-yet-ready children write
  // state too, and must not disappear from the shutdown/restart barrier.
  proc = child;
  const lifecycle = createServerChildLifecycle(child, { timeoutMs: 5_000 });
  procLifecycle = lifecycle;
  lastError = "the companion is starting";
  child.stdout?.on("data", (d) => log?.(`[companion] ${String(d).trimEnd()}`));
  child.stderr?.on("data", (d) => log?.(`[companion err] ${String(d).trimEnd()}`));

  let exited = false;
  child.once("exit", (code) => {
    exited = true;
    // A non-zero exit before we saw it answer is the interesting case: the
    // usual cause is the port already being taken, and the sidecar's own
    // message says which one and why.
    if (proc === child) {
      proc = null;
      procLifecycle = null;
      advertisedHostedUrl = null;
      remoteAccessOrigin = null;
      originTarget = null;
      lifecycleListener({
        type: "exit",
        expected: expectedStops.has(child),
        pid: child.pid,
      });
    }
    cleanupOrigin();
    log?.(`companion exited code=${code}`);
  });

  // Wait for the control port rather than assuming the fork worked. Without
  // this the toggle would flip to "on" and the panel would then fail every
  // request, which reads as a broken app rather than a failed start.
  for (let i = 0; i < 40; i++) {
    if (exited || lifecycle.failed) {
      await stop().catch(() => {});
      lastError = "the companion could not start — check the log";
      return companionState();
    }
    try {
      const state = await control("GET", "/state");
      // An answer on the control port proves something is listening there,
      // not that it is the child we just forked. A sidecar started by hand,
      // or one left behind by a previous run, answers exactly the same and
      // would be adopted as ours — after which the toggle drives a process
      // it does not own and stopping it does nothing visible. Match the pid.
      if (state?.pid !== undefined && child.pid !== undefined && state.pid !== child.pid) {
        await stop().catch(() => {});
        lastError = `port ${CONTROL_PORT} is already serving another companion — stop it and try again`;
        return companionState();
      }
      if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
        throw new Error("child pid unavailable");
      }
      const target = { pid: child.pid, socketPath: allocatedOrigin.socketPath };
      if (!(await companionOriginHealth(target))) throw new Error("private origin not ready");
      if (lifecycle.exited || lifecycle.failed) throw new Error("owned companion exited");
      proc = child;
      lastError = null;
      advertisedHostedUrl = hostedUrl;
      remoteAccessOrigin = remoteAccess?.origin ?? null;
      originTarget = Object.freeze(target);
      return companionState();
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  await stop().catch(() => {});
  lastError = "the companion did not come up in time";
  return companionState();
}

/** The three door variables the fork sets, given the remote-access decision.
 *
 * Exported and pure so the two arrangements can be asserted directly. The
 * whole feature is these three values agreeing with what is in front of the
 * door, and every way it has failed so far was one of them disagreeing.
 *
 * `remoteAccess` is `{ origin }` when `tailscale serve` is fronting the door,
 * and null otherwise. */
export function browserDoorEnvironment(inherited = {}, remoteAccess = null) {
  if (remoteAccess?.origin) {
    return {
      // Serve forwards to loopback. Anything else and it reaches nothing.
      MURAGE_BROWSER_BIND: "loopback",
      // True the moment serve is in front: the browser's connection really is
      // TLS, so the session cookie may — and must — carry `Secure` and the
      // `__Host-` prefix. Claiming it before serve was up is what made this
      // value dangerous to set early; claiming it now is just accurate.
      MURAGE_BROWSER_SCHEME: "https",
      // What a browser types. The door's own socket is 8813 and no browser
      // will ever dial it again while this is set.
      MURAGE_BROWSER_PUBLIC_ORIGIN: remoteAccess.origin,
    };
  }
  return {
    MURAGE_BROWSER_BIND: inherited.MURAGE_BROWSER_BIND || BROWSER_BIND,
    MURAGE_BROWSER_SCHEME: inherited.MURAGE_BROWSER_SCHEME || BROWSER_SCHEME,
    // Explicitly cleared rather than omitted. An inherited value from a
    // previous remote-access run would tell the sidecar a proxy is in front
    // of it when nothing is, and the QR would advertise an address that
    // stopped answering the moment serve was turned off.
    MURAGE_BROWSER_PUBLIC_ORIGIN: "",
  };
}

/** stopCompanion's body, run inside the transition queue. */
async function stop() {
  const child = proc;
  if (!child) return companionState();
  expectedStops.add(child);
  try {
    await procLifecycle.stop();
  } catch {
    lastError = "the owned companion has not exited; wait and retry Stop before starting another";
    throw new Error(lastError);
  }
  // The exit observer owns clearing proc and removing its private origin.
  // No timeout, kill return value or control-port response can stand in for it.
  lastError = null;
  return companionState();
}

/** Publish or withdraw the hosted route without replacing the sidecar (and
 * therefore without changing the exact private origin the guardian owns).
 * Callers publish only after public health verification succeeds. */
export function setCompanionHostedUrl(endpoint) {
  return serialize(async () => {
    if (!proc) return companionState();
    const state = await control("PUT", "/hosted-endpoint", { url: endpoint || null });
    advertisedHostedUrl = endpoint || null;
    return state;
  });
}

/** Everything the panel renders. Shaped so "off" is a complete answer rather
 * than an absence — the panel should never have to guess. */
export async function companionState() {
  const keepAwake = companionKeepAwakeAtRest();
  if (!proc) {
    const state = {
      enabled: false,
      keepAwake,
      port: COMPANION_PORT,
      devices: [],
      connectedDeviceIds: [],
      pairing: null,
      browser: BROWSER_DOOR_OFF,
    };
    if (lastError) state.error = lastError;
    return state;
  }
  if (lastError) {
    return { enabled: true, keepAwake, port: COMPANION_PORT, devices: [],
      connectedDeviceIds: [], pairing: null, browser: BROWSER_DOOR_OFF, error: lastError };
  }
  try {
    const state = await control("GET", "/state");
    // Refreshes can move the listener without a process restart. Report what
    // that owned process now serves, rather than its original launch options.
    remoteAccessOrigin = state.browser?.scheme === "https" && state.browser?.port === 443
      ? `https://${state.browser.host}` : null;
    return { enabled: true, keepAwake, ...state };
  } catch {
    remoteAccessOrigin = null;
    // running but unreachable: report it rather than claiming health
    return {
      enabled: true,
      keepAwake,
      port: COMPANION_PORT,
      devices: [],
      connectedDeviceIds: [],
      pairing: null,
      // Running but unreachable says nothing about the door, and the honest
      // answer to "where is it" is the same one "off" gives: we do not know.
      browser: BROWSER_DOOR_OFF,
      error: "the companion is not responding",
    };
  }
}

/** Re-read Tailscale without restarting the sidecar or dropping connected
 * phones.
 *
 * Tailscale may be installed, signed into, or enabled after Murage starts, so
 * startup-only detection makes an otherwise healthy route look permanently
 * unavailable — and the tailnet is the route this product leads with, which
 * makes that the worst failure mode available. */
export async function companionRefreshTailscale() {
  if (!proc) return companionState();
  try {
    // The sidecar's CLI hunt is itself bounded to five seconds. Give the
    // loopback call enough room to receive that bounded answer instead of
    // aborting first and reporting a failure that never happened.
    const state = await control("POST", "/tailscale/refresh", undefined, { timeoutMs: 6000 });
    return {
      enabled: true,
      keepAwake: companionKeepAwakeAtRest(),
      ...state,
    };
  } catch {
    const state = await companionState();
    return {
      ...state,
      error: state.error ?? "Tailscale could not be checked.",
    };
  }
}

/** Open or close a pairing window on the running sidecar. A conditional close
 * cannot erase a newer code created after the renderer began cancelling. */
export async function companionPairing(open, expectedToken) {
  if (!proc) return companionState();
  const conditionalClose = !open && expectedToken !== undefined;
  const candidate = String(expectedToken ?? "");
  const token = /^murage_pair_[A-Za-z0-9_-]{43}$/.test(candidate)
    ? candidate
    : "invalid-pairing-token";
  const path = conditionalClose
    ? `/pairing?expectedToken=${encodeURIComponent(token)}`
    : "/pairing";
  try {
    const state = await control(open ? "POST" : "DELETE", path);
    return {
      enabled: true,
      keepAwake: companionKeepAwakeAtRest(),
      ...state,
    };
  } catch {
    const state = await companionState();
    return {
      ...state,
      error: state.error ?? "Phone pairing could not be updated.",
    };
  }
}

/** Unpair one device. Ignores an id the renderer should not have sent. */
export async function companionRevoke(deviceId) {
  if (!proc) return companionState();
  // the id came from the renderer, so it does not get to shape a path
  if (!/^[\w-]{1,64}$/.test(String(deviceId ?? ""))) return companionState();
  await control("DELETE", `/devices/${deviceId}`).catch(() => {});
  return companionState();
}

/** Enable or remove interactive cloud-desktop access for one paired phone. */
export async function companionCloudDesktopAccess(deviceId, allowed) {
  if (!proc) return companionState();
  if (!/^[\w-]{1,64}$/.test(String(deviceId ?? ""))) return companionState();
  await control(allowed ? "POST" : "DELETE", `/devices/${deviceId}/cloud-desktop`).catch(() => {});
  return companionState();
}
