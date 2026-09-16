import { randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AGE_ORIGINAL_SHA256,trustedBackupAgeExecutable,trustedBackupAgeExecutableAsync,backupToolIdentity } from "./backup-age-attestation.mjs";
import { backupAgePinForTarget } from "../shared/backup-age-pins.mjs";
export const BACKUP_MODE_ARGUMENT = "--murage-backup-mode";
// Same verified binary as shared/backup-age-pin.ts; a test pins this boundary.
export const BACKUP_AGE_SHA256 = AGE_ORIGINAL_SHA256;
export function verifiedBackupTool(resources) {
  const pin = backupAgePinForTarget(process.platform, process.arch);
  if (!pin) return null;
  const file = path.join(resources, "backup-tools", pin.arch, "age");
  return trustedBackupAgeExecutable(file)?file:null;
}

/** Desktop-owned availability, not a renderer grant. Windows actions reverify
 * the fixed packaged resources before reading a recovery identity. */
export function createBackupToolCapability({ resourcesPath, currentExecutable, isUsable, macToolName = "age", verifyMacTool = trustedBackupAgeExecutableAsync }) {
  const windows = process.platform === "win32", mac = process.platform === "darwin";
  let identity = null, controller = null;
  let state = "pending", tool = null, pending = null, generation = 0;
  const unavailable = () => Object.assign(new Error("Encrypted backup unavailable"), { code: "BACKUP_UNAVAILABLE" });
  const currentTool = () => {
    if (!isUsable()) return null;
    if (mac) {
      if (state !== "ready") return null;
      if (!identity || backupToolIdentity(tool, currentExecutable) !== identity) { generation++; state = "failed"; tool = null; identity = null; return null; }
      return tool;
    }
    return windows ? state === "ready" ? tool : null : verifiedBackupTool(resourcesPath);
  };
  const requireTool = async () => {
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
        if (!before || !await verifyMacTool(file, { currentExecutable, signal: controller.signal }) || !isUsable() || epoch !== generation || backupToolIdentity(file, currentExecutable) !== before) throw unavailable();
        identity = before; tool = file; state = "ready"; return tool;
      }
      const { createWindowsBackupResourceResolver } = await import(pathToFileURL(path.join(resourcesPath, "server", "windows-backup-resources.js")).href);
      if (!isUsable() || epoch !== generation) throw unavailable();
      const verified = await createWindowsBackupResourceResolver({ resourcesPath, currentExecutable })();
      const helper = path.join(resourcesPath, "backup-tools", "x64", "murage-backup-age.exe");
      if (typeof verified?.executable !== "string" || verified.executable.toLowerCase() !== helper.toLowerCase() || !isUsable() || epoch !== generation) throw unavailable();
      tool = path.join(resourcesPath, "backup-tools", "x64", "age.exe"); state = "ready";
      return tool;
    })().catch(error => {
      if (epoch === generation) { state = "failed"; tool = null; }
      throw error;
    });
    pending = work;
    try { return await work; } finally { if (pending === work) pending = null; }
  };
  return {
    currentTool,
    status: () => { if (mac) currentTool(); return { state: windows || mac ? state : currentTool() ? "ready" : "failed" }; },
    requireTool,
    invalidate() { generation += 1; state = "failed"; tool = null; identity = null; controller?.abort(); },
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
  const resolved = realpathSync(file), root = realpathSync(installation);
  if (resolved === root || resolved.startsWith(root + path.sep)) throw new Error("BACKUP_IDENTITY_MUST_BE_INDEPENDENT");
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
