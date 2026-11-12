// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { withHideInherit } from "../../../shared/win-hide-child-process.mjs";
import { execFileSync } from "node:child_process";
import * as nodeFs from "node:fs";
import { dirname, join, resolve, win32 } from "node:path";
import { currentUserSid, ownerOnlyVerdict, ownerVerdict, parseDacl, windowsAclRestrict } from "../../win-acl.ts";
import type { StorageGuard, StorageVerdict } from "./types.ts";

export interface WindowsSecurityEntry { path: string; attributes: number; sddl: string | null }
export interface SecurityRunOptions { input?: string; env: NodeJS.ProcessEnv; timeout: number }
export type SecurityRunner = (file: string, args: readonly string[], options: SecurityRunOptions) => string;
export const defaultSecurityRunner: SecurityRunner = (file, args, options) => execFileSync(file, [...args], withHideInherit({
  ...options, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024,
  stdio: ["pipe", "pipe", "pipe"],
}));

/** Six roots only; the reader enumerates descendants without an environment size per file. */
export function signalStorageRoots(dataDir: string, connectionId: string): string[] {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(connectionId)) throw new Error("Invalid Signal connection id");
  const data = resolve(dataDir);
  return [data, join(data, "signal"), join(data, "signal", "auth"), join(data, "signal", "tmp"),
    join(data, "signal", "log"), join(data, "channels", "signal", connectionId)];
}

// No paths are interpolated. Cmdlets, properties, core casts and operators work
// under CLM. Walk one level at a time so no reparse directory is ever traversed.
// Escape non-ASCII JSON characters with operators: Windows PowerShell 5.1 may
// encode piped stdout with the system code page, even though env is UTF-16.
const SECURITY_SCRIPT = String.raw`& {
  $ErrorActionPreference = 'Stop'
  $roots = @($env:MURAGE_SIGNAL_ROOTS | ConvertFrom-Json)
  if ($roots.Count -ne 6) { throw 'Invalid roots' }
  $seen = @{}
  function Visit-SignalPath($p, $recurse) {
    if ($seen[$p]) { return }
    $seen[$p] = $true
    $item = Get-Item -LiteralPath $p -Force
    $attributes = [int]$item.Attributes
    $sddl = $null
    if (($attributes -band 1024) -eq 0) { $sddl = (Get-Acl -LiteralPath $p).Sddl }
    $json = @{ path = $p; attributes = $attributes; sddl = $sddl } | ConvertTo-Json -Compress
    (($json -split '' | ForEach-Object {
      if ($_ -cmatch '[^\x00-\x7f]') { '\u{0:x4}' -f [int][char]$_ } else { $_ }
    }) -join '')
    if (($attributes -band 1024) -ne 0) { return }
    if ($recurse -and $item.PSIsContainer) {
      Get-ChildItem -LiteralPath $p -Force | ForEach-Object { Visit-SignalPath $_.FullName $true }
    }
  }
  if ($env:MURAGE_SIGNAL_POINT -eq '1') { Visit-SignalPath $roots[0] $false; return }
  Visit-SignalPath $roots[0] $false
  if (((Get-Item -LiteralPath $roots[0] -Force).Attributes -band 1024) -ne 0) { return }
  $channelParent = Split-Path -LiteralPath $roots[5]
  $channels = Split-Path -LiteralPath $channelParent
  foreach ($p in @($channels, $channelParent)) {
    Visit-SignalPath $p $false
    if (((Get-Item -LiteralPath $p -Force).Attributes -band 1024) -ne 0) { return }
  }
  foreach ($p in $roots[1..5]) {
    Visit-SignalPath $p $true
    if (((Get-Item -LiteralPath $p -Force).Attributes -band 1024) -ne 0) { return }
  }
}

`;

/** Null means the whole read failed; partial output never authorizes a spawn. */
export function windowsSecurityReadSync(
  roots: readonly string[], run: SecurityRunner = defaultSecurityRunner, env: NodeJS.ProcessEnv = process.env, point = false, timeout = 15_000,
): WindowsSecurityEntry[] | null {
  if (roots.length !== 6) return null;
  try {
    const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
    if (!win32.isAbsolute(systemRoot)) return null;
    const projectionEnv:NodeJS.ProcessEnv={...env,MURAGE_SIGNAL_ROOTS:JSON.stringify(roots)};
    if(point)projectionEnv.MURAGE_SIGNAL_POINT="1";else delete projectionEnv.MURAGE_SIGNAL_POINT;
    const output = run(win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"], {
        input: SECURITY_SCRIPT, env: projectionEnv, timeout,
      });
    const rows: WindowsSecurityEntry[] = [];
    const seen = new Set<string>();
    for (const line of output.trim().split(/\r?\n/)) {
      const row: unknown = JSON.parse(line);
      if (!row || typeof row !== "object" || Array.isArray(row)) return null;
      const value = row as Record<string, unknown>;
      if (Object.keys(value).sort().join(",") !== "attributes,path,sddl"
          || typeof value.path !== "string" || !value.path || seen.has(value.path)
          || !Number.isInteger(value.attributes) || (value.attributes as number) < 0
          || (value.attributes as number) > 0xffffffff
          || (typeof value.sddl !== "string" && !(value.sddl === null && ((value.attributes as number) & 0x400)))) return null;
      seen.add(value.path);
      rows.push(value as unknown as WindowsSecurityEntry);
    }
    return rows.length ? rows : null;
  } catch { return null; }
}

/** Existing six-root guard keeps its async API and inspection policy. */
export async function windowsSecurityRead(roots:readonly string[],run:SecurityRunner=defaultSecurityRunner,env:NodeJS.ProcessEnv=process.env):Promise<WindowsSecurityEntry[]|null>{
 return windowsSecurityReadSync(roots,run,env);
}
/** Same native attribute/SDDL projection, one exact entry, with no traversal or repair. */
export function windowsSecurityEntrySync(path:string,timeout:number,run:SecurityRunner=defaultSecurityRunner,env:NodeJS.ProcessEnv=process.env):WindowsSecurityEntry|null{
 const rows=windowsSecurityReadSync(Array(6).fill(path),run,env,true,timeout);
 return rows?.length===1&&rows[0]?.path===path?rows[0]:null;
}

interface StorageFs {
  lstatSync(path: string): nodeFs.Stats;
  readdirSync(path: string): string[];
  openSync(path: string, flags: number): number;
  fstatSync(fd: number): nodeFs.Stats;
  fchmodSync(fd: number, mode: number): void;
  closeSync(fd: number): void;
}
export interface SignalStorageOptions {
  dataDir: string;
  connectionId: string;
  platform?: NodeJS.Platform;
  uid?: number;
  run?: SecurityRunner;
  env?: NodeJS.ProcessEnv;
  fs?: Partial<StorageFs>;
}
type Entry = { path: string; stat: nodeFs.Stats; boundary: boolean; removeGrants?: string[] };
type Blocked = Exclude<StorageVerdict, { state: "ok" }>;
class StorageFailure extends Error {
  readonly verdict: Blocked;
  constructor(verdict: Blocked) { super(verdict.reason); this.verdict = verdict; }
}
const OPEN_FLAGS = nodeFs.constants.O_RDONLY | (nodeFs.constants.O_NOFOLLOW ?? 0);
const BROAD_DATA_ACCOUNTS = new Set(["WD", "BU", "AU", "S-1-1-0", "S-1-5-32-545", "S-1-5-11"]);
// icacls /remove:g needs numeric SIDs, not localized account names or SDDL aliases.
const REPAIR_ALIASES: Readonly<Record<string, string>> = {
  WD: "S-1-1-0", AU: "S-1-5-11", AN: "S-1-5-7", IU: "S-1-5-4", NU: "S-1-5-2",
  SU: "S-1-5-6", LS: "S-1-5-19", NS: "S-1-5-20", BU: "S-1-5-32-545", BG: "S-1-5-32-546",
  PU: "S-1-5-32-547", BO: "S-1-5-32-551", PO: "S-1-5-32-550", SO: "S-1-5-32-549",
  AO: "S-1-5-32-548", RE: "S-1-5-32-552", RD: "S-1-5-32-555", CO: "S-1-3-0", CG: "S-1-3-1",
};

/** B7 creates the tree after its revocation barrier. This guard never reads key
 * contents, changes an owner, deletes a tree, or initiates a relink. Both entry
 * points try one permission repair and then verify the entire fixed set again.
 */
export function createSignalStorageGuard(options: SignalStorageOptions): StorageGuard {
  const roots = signalStorageRoots(options.dataDir, options.connectionId);
  const data = roots[0]!;
  const windows = (options.platform ?? process.platform) === "win32";
  const uid = options.uid ?? process.getuid?.();
  const fs: StorageFs = { ...nodeFs, ...options.fs };
  const run = options.run ?? defaultSecurityRunner;
  const env = options.env ?? process.env;
  const fail = (path: string, reason: Blocked["reason"] = "storage-permissions"): never => {
    throw new StorageFailure({ state: "blocked", reason, scope: path === data ? "data-dir" : "signal", path });
  };
  const toolRun = (file: string, args: readonly string[]) => run(file, args, { env, timeout: 15_000 });

  async function inspect(): Promise<{ entries: Entry[]; broad: Entry[] }> {
    const sid = windows ? currentUserSid(toolRun, env) : null;
    if (windows && !sid) fail(data);
    const rows = windows ? await windowsSecurityRead(roots, run, env) : null;
    if (windows && !rows) fail(data);
    const security = new Map(rows?.map(row => [row.path, row]));
    // Check every reported owner and reparse bit before any possible repair.
    for (const row of rows ?? []) {
      if (row.attributes & 0x400) fail(row.path);
      const owner = ownerVerdict(row.sddl ?? "", sid!);
      if (owner !== "ok") fail(row.path, owner === "foreign" ? "storage-owner" : "storage-permissions");
    }
    const entries: Entry[] = [];
    const seen = new Set<string>();
    function visit(path: string, recurse: boolean, boundary = false): void {
      if (seen.has(path)) return;
      seen.add(path);
      let stat: nodeFs.Stats;
      try { stat = fs.lstatSync(path); } catch { return fail(path); }
      if (stat.isSymbolicLink() || !(stat.isDirectory() || stat.isFile())) fail(path);
      if ((boundary || roots.includes(path)) && !stat.isDirectory()) fail(path);
      if (windows) {
        const row = security.get(path);
        if (!row || Boolean(row.attributes & 16) !== stat.isDirectory()) fail(path);
      } else if (uid === undefined || (stat.uid !== uid && !(path === data && stat.uid === 0))) {
        fail(path, "storage-owner");
      }
      entries.push({ path, stat, boundary });
      if (recurse && stat.isDirectory()) {
        let children: string[];
        try { children = fs.readdirSync(path); } catch { return fail(path); }
        for (const name of children) visit(join(path, name), true);
      }
    }
    visit(data, false, true);
    visit(dirname(dirname(roots[5]!)), false, true);
    visit(dirname(roots[5]!), false, true);
    for (const path of roots.slice(1)) visit(path, true);

    const broad: Entry[] = [];
    for (const entry of entries) {
      const { path, stat, boundary } = entry;
      if (windows) {
        const sddl = security.get(path)!.sddl!;
        if (boundary) {
          const dacl = parseDacl(sddl);
          if (!dacl || dacl.allow.some(account => BROAD_DATA_ACCOUNTS.has(account))) fail(path);
        } else {
          const verdict = ownerOnlyVerdict(sddl, sid!);
          if (verdict === "unknown") fail(path);
          if (verdict === "broad") {
            entry.removeGrants = [];
            for (const account of parseDacl(sddl)!.allow) {
              if ([sid, "S-1-5-18", "S-1-5-32-544", "LA"].includes(account)) continue;
              const numeric = /^S-1-(?:\d+-){1,14}\d+$/.test(account) ? account : REPAIR_ALIASES[account];
              if (!numeric) fail(path);
              entry.removeGrants.push(numeric);
            }
            broad.push(entry);
          }
        }
      } else {
        // Shared channels ancestors are path/owner checks, not Signal's mode boundary.
        if (boundary && path !== data) continue;
        const wanted = stat.isDirectory() ? 0o700 : 0o600;
        if ((stat.mode & 0o7777) !== wanted) {
          if (boundary) fail(path);
          broad.push(entry);
        }
      }
    }
    return { entries, broad };
  }

  function repairPosix(entry: Entry): void {
    const { path, stat } = entry;
    let fd: number | undefined;
    try {
      // Pin the inode before chmod, and reject a replacement since inspection.
      fd = fs.openSync(path, OPEN_FLAGS);
      const opened = fs.fstatSync(fd);
      if (opened.uid !== uid) fail(path, "storage-owner");
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.isDirectory() !== stat.isDirectory()) fail(path);
      fs.fchmodSync(fd, stat.isDirectory() ? 0o700 : 0o600);
    } catch (error) {
      if (error instanceof StorageFailure) throw error;
      fail(path);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  async function check(): Promise<StorageVerdict> {
    try {
      const { broad } = await inspect();
      if (!broad.length) return { state: "ok" };
      for (const entry of broad) {
        if (windows) {
          // /grant:r alone leaves other principals' explicit grants untouched.
          // Remove those grants as part of the one repair, then cut inheritance.
          for (const account of new Set(entry.removeGrants)) {
            try {
              toolRun(win32.join(env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows", "System32", "icacls.exe"),
                [entry.path, "/remove:g", `*${account}`, "/q"]);
            } catch { fail(entry.path); }
          }
          if (!windowsAclRestrict(entry.path, toolRun, env, fs.lstatSync)) fail(entry.path);
        } else repairPosix(entry);
      }
      const after = await inspect();
      if (after.broad.length) fail(after.broad[0]!.path);
      return { state: "ok" };
    } catch (error) {
      if (error instanceof StorageFailure) return error.verdict;
      return { state: "blocked", reason: "storage-permissions", scope: "data-dir", path: data };
    }
  }
  return { check, repair: check };
}
