// Owner: sc-safety (import guards). The isolated test runner owns network and filesystem containment.
// Guards limit import-time effects. Native addons and effects delayed until after resolution
// require the runner's network isolation and per-worker home; these guards are not a sandbox.
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import dgram from "node:dgram";
import childProcess from "node:child_process";
import workerThreads from "node:worker_threads";
import { syncBuiltinESMExports } from "node:module";
import { relative, resolve, isAbsolute, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export function containImport<T>(root: string, load: () => Promise<T>): Promise<T> {
  const undo: Array<() => void> = [];
  function refuse(): never { throw new Error("FIXTURE_IMPORT_SIDE_EFFECT"); }
  const patch = (target: object, key: string, value: unknown) => {
    const prior = Object.getOwnPropertyDescriptor(target, key);
    if (!prior) return;
    Object.defineProperty(target, key, { ...prior, value });
    undo.push(() => Object.defineProperty(target, key, prior));
  };
  const allowed = (value: unknown): boolean => {
    if (!(typeof value === "string" || value instanceof URL || Buffer.isBuffer(value))) return false;
    const name = value instanceof URL ? fileURLToPath(value) : String(value);
    const path = resolve(name), rel = relative(root, path);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) return false;
    // A lexical child may traverse a symlink out of the disposable root.
    let ancestor = path;
    while (!fs.existsSync(ancestor)) { const parent = dirname(ancestor); if (parent === ancestor) return false; ancestor = parent; }
    const physical = relative(fs.realpathSync(root), fs.realpathSync(ancestor));
    return !isAbsolute(physical) && physical !== ".." && !physical.startsWith("../") && !physical.startsWith("..\\");
  };
  const writeFlags = (flag: unknown) => typeof flag === "number"
    ? !!(flag & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND))
    : typeof flag === "string" && /[wa+]/.test(flag);
  try {
    for (const target of [fs, fsPromises]) {
      for (const name of ["writeFile", "writeFileSync", "appendFile", "appendFileSync", "unlink", "unlinkSync", "mkdir", "mkdirSync", "rm", "rmSync", "rmdir", "rmdirSync", "truncate", "truncateSync", "createWriteStream", "chmod", "chmodSync", "chown", "chownSync", "utimes", "utimesSync"]) {
        const fn = Reflect.get(target, name);
        if (typeof fn === "function") patch(target, name, function (this: unknown, path: unknown, ...args: unknown[]) { if (!allowed(path)) refuse(); return Reflect.apply(fn, this, [path, ...args]); });
      }
      for (const name of ["rename", "renameSync", "copyFile", "copyFileSync", "cp", "cpSync", "link", "linkSync", "symlink", "symlinkSync"]) {
        const fn = Reflect.get(target, name);
        if (typeof fn === "function") patch(target, name, function (this: unknown, from: unknown, to: unknown, ...args: unknown[]) { if (!allowed(from) || !allowed(to)) refuse(); return Reflect.apply(fn, this, [from, to, ...args]); });
      }
      for (const name of ["open", "openSync"]) {
        const fn = Reflect.get(target, name);
        if (typeof fn === "function") patch(target, name, function (this: unknown, path: unknown, flags: unknown, ...args: unknown[]) { if (writeFlags(flags) && !allowed(path)) refuse(); return Reflect.apply(fn, this, [path, flags, ...args]); });
      }
      for (const name of ["write", "writeSync", "writev", "writevSync"]) patch(target, name, refuse);
    }
    for (const [target, keys] of [[net, ["connect", "createConnection"]], [net.Server.prototype, ["listen"]], [net.Socket.prototype, ["connect"]], [tls, ["connect"]], [http, ["request", "get"]], [https, ["request", "get"]], [dgram, ["createSocket"]], [childProcess, ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]], [workerThreads, ["Worker"]], [process, ["dlopen"]], [globalThis, ["fetch"]]] as const) {
      for (const key of keys) patch(target, key, refuse);
    }
    syncBuiltinESMExports();
  } catch (error) { for (const restore of undo.reverse()) restore(); syncBuiltinESMExports(); throw error; }
  return Promise.resolve().then(load).finally(() => { for (const restore of undo.reverse()) restore(); syncBuiltinESMExports(); });
}
