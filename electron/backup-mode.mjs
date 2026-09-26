import { randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AGE_ORIGINAL_SHA256,BACKUP_CODESIGN_RETRY_MS,trustedBackupAgeExecutable,trustedBackupAgeExecutableAsync,backupToolIdentity } from "./backup-age-attestation.mjs";
import { backupAgePinForTarget } from "../shared/backup-age-pins.mjs";
import { packagedResticPath, trustedBackupResticExecutableAsync } from "./backup-restic-attestation.mjs";
import { pathWithin } from "../shared/path-identity.mjs";
export const BACKUP_MODE_ARGUMENT = "--murage-backup-mode";
// Same verified binary as shared/backup-age-pin.ts; a test pins this boundary.
export const BACKUP_AGE_SHA256 = AGE_ORIGINAL_SHA256;
export function verifiedBackupTool(resources) {
  const pin = backupAgePinForTarget(process.platform, process.arch);
  if (!pin) return null;
  const file = path.join(resources, "backup-tools", pin.arch, "age");
  return trustedBackupAgeExecutable(file)?file:null;
}


// A backup tool is attested once (pinned bytes and, on macOS, the app's
// signature) and then re-checked on every use by a cheap file identity that
// includes each bundle folder's ctime. macOS itself changes that identity on
// the first launch of a freshly installed or updated app: it writes
// com.apple.macl onto Murage.app a second or two after launch, which moves
// the bundle's ctime while the attestation is running (Mac customer re-test
// 2, 2026-09-26). A cold first launch can also make one codesign run outlast
// its bound while macOS is still assessing the new app. Either used to leave
// backups and off-site copies "unavailable" until Murage was restarted.
// Now a failed or invalidated attestation is simply done again, in full,
// after a short and then growing delay, so nothing is trusted without a
// fresh signature check and nothing needs a restart.
export const BACKUP_TOOL_RETRY_DELAYS_MS = Object.freeze([1000, 5000, 15000, 30000, 60000, 120000, 300000]);
export function createToolRecheck({ run, isUsable, delays = BACKUP_TOOL_RETRY_DELAYS_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null, attempt = 0, stopped = false;
  return {
    schedule(soon = false) {
      if (stopped || timer || !isUsable()) return;
      const delay = soon ? delays[0] : delays[Math.min(attempt, delays.length - 1)];
      attempt++;
      timer = setTimer(() => { timer = null; void Promise.resolve().then(run).catch(() => {}); }, delay);
      timer?.unref?.();
    },
    succeeded() { attempt = 0; },
    stop() { stopped = true; if (timer) clearTimer(timer); timer = null; },
    scheduled: () => Boolean(timer),
  };
}
const pause = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); });
/** Wait, bounded, until a capability's tool is attested; a backup relaunch
 * must not fail its capture just because the first check at startup did. */
async function waitForTool(capability, isUsable, timeoutMs, unavailable) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const tool = capability.currentTool();
    if (tool) return tool;
    try { return await capability.requireTool({ background: true }); }
    catch (error) { if (!isUsable() || Date.now() + 1000 > deadline) throw error ?? unavailable(); await pause(1000); }
  }
}
/** Desktop-owned availability, not a renderer grant. Windows actions reverify
 * the fixed packaged resources before reading a recovery identity. */
export function createBackupToolCapability({ resourcesPath, currentExecutable, isUsable, macToolName = "age", verifyMacTool = trustedBackupAgeExecutableAsync, recheckOptions }) {
  const windows = process.platform === "win32", mac = process.platform === "darwin";
  let identity = null, controller = null;
  let state = "pending", tool = null, pending = null, generation = 0;
  // The message is the code: only the message crosses ipcRenderer.invoke
  // (audit IPC-L2), and the page maps codes to sentences.
  const unavailable = () => Object.assign(new Error("BACKUP_UNAVAILABLE"), { code: "BACKUP_UNAVAILABLE" });
  const currentTool = () => {
    if (!isUsable()) return null;
    if (mac) {
      if (state !== "ready") return null;
      // Changed since it was attested: attest again rather than give up.
      if (!identity || backupToolIdentity(tool, currentExecutable) !== identity) { generation++; state = "pending"; tool = null; identity = null; recheck.schedule(true); return null; }
      return tool;
    }
    return windows ? state === "ready" ? tool : null : verifiedBackupTool(resourcesPath);
  };
  const requireTool = async ({ background = false } = {}) => {
    if (!isUsable()) throw unavailable();
    if (!windows && !mac) {
      const file = verifiedBackupTool(resourcesPath);
      if (!file || !isUsable()) throw unavailable();
      return file;
    }
    if (pending) return pending;
    const epoch = ++generation;
    state = "pending"; tool = null; identity = null;
    controller = new AbortController();
    const work = (async () => {
      if (mac) {
        if (!["age", "restic"].includes(macToolName)) throw unavailable();
        const file = path.join(resourcesPath, "backup-tools", process.arch, macToolName);
        const before = backupToolIdentity(file, currentExecutable);
        if (!before || !await verifyMacTool(file, { currentExecutable, signal: controller.signal, ...(background ? { timeoutMs: BACKUP_CODESIGN_RETRY_MS } : {}) }) || !isUsable() || epoch !== generation || backupToolIdentity(file, currentExecutable) !== before) throw unavailable();
        identity = before; tool = file; state = "ready"; recheck.succeeded(); return tool;
      }
      const { createWindowsBackupResourceResolver } = await import(pathToFileURL(path.join(resourcesPath, "server", "windows-backup-resources.js")).href);
      if (!isUsable() || epoch !== generation) throw unavailable();
      const verified = await createWindowsBackupResourceResolver({ resourcesPath, currentExecutable })();
      const helper = path.join(resourcesPath, "backup-tools", "x64", "murage-backup-age.exe");
      if (typeof verified?.executable !== "string" || verified.executable.toLowerCase() !== helper.toLowerCase() || !isUsable() || epoch !== generation) throw unavailable();
      tool = path.join(resourcesPath, "backup-tools", "x64", "age.exe"); state = "ready";
      return tool;
    })().catch(error => {
      if (epoch === generation) { state = "failed"; tool = null; if (mac) recheck.schedule(); }
      throw error;
    });
    pending = work;
    try { return await work; } finally { if (pending === work) pending = null; }
  };
  const recheck = createToolRecheck({ run: () => currentTool() ? undefined : requireTool({ background: true }), isUsable, ...(recheckOptions ?? {}) });
  return {
    currentTool,
    /** `checking` is true while an attestation runs or is due again soon. */
    status: () => { if (mac) currentTool(); const current = windows || mac ? state : currentTool() ? "ready" : "failed"; return { state: current, checking: mac && (current === "pending" || recheck.scheduled()) }; },
    requireTool,
    waitReady: (timeoutMs = 180000) => waitForTool({ currentTool, requireTool }, isUsable, timeoutMs, unavailable),
    invalidate() { generation += 1; state = "failed"; tool = null; identity = null; recheck.stop(); controller?.abort(); },
    async settled() { await pending?.catch(() => {}); },
  };
}
export function backupActivityBusy(value) {
  if (!Array.isArray(value?.bots) || !Array.isArray(value?.groups)) throw new Error("BACKUP_ACTIVITY_UNAVAILABLE");
  if(value.bots.some(bot=>!bot||typeof bot.busy!=="boolean")||value.groups.some(group=>!group||typeof group.working!=="boolean"))throw new Error("BACKUP_ACTIVITY_UNAVAILABLE");
  return value.bots.some(bot => bot.busy || bot.tasks?.some(task => task.busy)) || value.groups.some(group => group.working || group.busyBotId || group.tasks?.some(task => task.busy));
}
export async function prepareBackupRestart(send, stopped=()=>false) {
  const token=randomUUID();
  const release=async()=>{if(stopped())return;const value=await send("cancel",token);if(typeof value?.released!=="boolean")throw new Error("BACKUP_RELEASE_UNCONFIRMED");};
  try{const value=await send("prepare",token);if(value?.prepared!==true||value.token!==token)throw new Error("BACKUP_PREPARE_UNCONFIRMED");return release;}
  catch(error){await release();throw error;}
}
export function createBackupModeController(host) {
  let pending = false;
  return {
    status: () => ({ supported: host.supported(), pending }),
    isPreparing: () => pending,
    async restart() {
      if (pending) throw new Error("BACKUP_BUSY");
      if (!host.supported()) throw new Error("BACKUP_UNAVAILABLE");
      pending = true;
      try {
        if (backupActivityBusy(await host.readActivity())) throw new Error("BACKUP_WORK_ACTIVE");
        if (!(await host.confirm())) return { restarting: false };
        if (!host.supported() || backupActivityBusy(await host.readActivity())) throw new Error("BACKUP_WORK_ACTIVE");
        const release=await host.prepare();
        try{await host.restart();}
        catch(error){await release();throw error;}
        return { restarting: true };
      } finally { pending = false; }
    },
  };
}
/** Only a host-chosen independent file, never a renderer path or OS keychain. */
export function readBackupIdentity(file, installation) {
  if(lstatSync(file).isSymbolicLink())throw new Error("BACKUP_IDENTITY_INVALID");
  // The identity is the only key that can decrypt these backups, so it must
  // not live inside the installation the backups exist to replace. Resolve
  // natively: the JavaScript realpath follows links but keeps the spelling it
  // was given, so a differently cased or 8.3-aliased pick
  // (C:\Users\SEAN~1\.murage\key.txt against C:\Users\Sean\.murage) read as
  // independent and the key was filed inside the thing it unlocks.
  const resolved = realpathSync.native(file), root = realpathSync.native(installation);
  if (pathWithin(root, resolved)) throw new Error("BACKUP_IDENTITY_MUST_BE_INDEPENDENT");
  const before = lstatSync(resolved);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 4096) throw new Error("BACKUP_IDENTITY_INVALID");
  const fd = openSync(resolved, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("BACKUP_IDENTITY_INVALID");
    const buffer=Buffer.alloc(4097),length=readSync(fd,buffer,0,buffer.length,0);
    if(length>4096)throw new Error("BACKUP_IDENTITY_INVALID");
    const identity = buffer.subarray(0,length).toString("utf8");
    const lines = identity.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
    if (lines.length !== 1 || !/^AGE-SECRET-KEY-1[A-Z0-9]{40,120}$/.test(lines[0])) throw new Error("BACKUP_IDENTITY_INVALID");
    const recipient = /^#\s*public key:\s*(age1[a-z0-9]{40,100})\s*$/m.exec(identity)?.[1];
    return { identity, recipient };
  } finally { closeSync(fd); }
}
/** Off-site copies' restic, on every packaged platform: one fixed path per
 * platform and arch, attested once (pinned bytes; on macOS also the signed
 * payload), then re-checked by identity on every use. Actions re-attest in
 * the restic runner anyway. */
export function createResticToolCapability({ resourcesPath, currentExecutable, isUsable, locate = packagedResticPath, verify = trustedBackupResticExecutableAsync, recheckOptions }) {
  let state = "pending", tool = null, identity = null, pending = null, generation = 0, controller = null;
  const unavailable = () => Object.assign(new Error("Off-site backup tool unavailable"), { code: "BACKUP_UNAVAILABLE" });
  const currentTool = () => {
    if (!isUsable() || state !== "ready") return null;
    // Changed since it was attested (on macOS the first launch does this to
    // the bundle itself): attest again rather than give up until a restart.
    if (!identity || backupToolIdentity(tool, currentExecutable) !== identity) { generation++; state = "pending"; tool = null; identity = null; recheck.schedule(true); return null; }
    return tool;
  };
  const requireTool = async ({ background = false } = {}) => {
    if (!isUsable()) throw unavailable();
    if (pending) return pending;
    const epoch = ++generation; state = "pending"; tool = null; identity = null; controller = new AbortController();
    const work = (async () => {
      const file = locate(resourcesPath);
      const before = file ? backupToolIdentity(file, currentExecutable) : null;
      // No file at all is a build without off-site copies: nothing to retry.
      if (!file) throw Object.assign(unavailable(), { permanent: true });
      if (!before || !await verify(file, { currentExecutable, signal: controller.signal, ...(background ? { timeoutMs: BACKUP_CODESIGN_RETRY_MS } : {}) }) || !isUsable() || epoch !== generation || backupToolIdentity(file, currentExecutable) !== before) throw unavailable();
      identity = before; tool = file; state = "ready"; recheck.succeeded(); return tool;
    })().catch(error => { if (epoch === generation) { state = "failed"; tool = null; if (!error?.permanent) recheck.schedule(); } throw error; });
    pending = work;
    try { return await work; } finally { if (pending === work) pending = null; }
  };
  const recheck = createToolRecheck({ run: () => currentTool() ? undefined : requireTool({ background: true }), isUsable, ...(recheckOptions ?? {}) });
  return { currentTool, requireTool,
    status: () => { currentTool(); return { state, checking: state === "pending" || recheck.scheduled() }; },
    waitReady: (timeoutMs = 180000) => waitForTool({ currentTool, requireTool }, isUsable, timeoutMs, unavailable),
    invalidate() { generation++; state = "failed"; tool = null; identity = null; recheck.stop(); controller?.abort(); }, async settled() { await pending?.catch(() => {}); } };
}
