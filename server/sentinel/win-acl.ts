// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Owner-only access on Windows for the Sentinel output root (1.0.9, GAP-SENTINEL-109 section 7). chmod does not
// restrict access on Windows, so the check reads the real DACL by SID (locale independent): `icacls <path> /save`
// writes SDDL, which is parsed here. Owner-only means: a protected DACL (no inherited entries) whose allow entries name
// only the current user, LocalSystem and the built-in Administrators. Any other allow entry (Everyone, Users,
// Authenticated Users, another account) is broad access and fails closed.
//
// Tools run from %SystemRoot%\System32 by absolute path, never from PATH. The runner is injectable so tests (and lane
// C's OS integration) never need a real Windows host.
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { win32 } from "node:path";
import { randomBytes } from "node:crypto";

export type AclVerdict = "owner-only" | "broad" | "unknown";
export type AclCheck = (path: string) => AclVerdict;

/** Runs a System32 tool synchronously and answers its stdout (utf8), or throws. */
export type ToolRunner = (file: string, args: readonly string[]) => string;

const SID = /^S-1-(?:\d+-){1,14}\d+$/;
const WELL_KNOWN_OWNER_SIDS = new Set(["SY", "BA", "S-1-5-18", "S-1-5-32-544"]);

/** Allow-ACE SIDs of a DACL in SDDL, plus whether the DACL is protected (no inheritance). Null when unparseable. */
export function parseDacl(text: string): { protectedDacl: boolean; allow: string[]; inherited: boolean } | null {
  // `icacls /save` writes the file name on one line and the SDDL on the next; only the SDDL line is parsed (a drive
  // letter such as "D:\" in the name line must never be read as a DACL).
  const sddl = text.split(/\r?\n/).map(line => line.trim()).find(line => /^(?:O:|G:|D:)/.test(line) && line.includes("D:")) ?? "";
  const match = /D:([A-Z]*)((?:\([^()]*\))*)/.exec(sddl);
  if (!match) return null;
  const flags = match[1] ?? "";
  const aces = [...(match[2] ?? "").matchAll(/\(([^()]*)\)/g)].map(m => (m[1] ?? "").split(";"));
  const allow: string[] = [];
  let inherited = false;
  for (const ace of aces) {
    if (ace.length < 6) return null;
    const [type, aceFlags, , , , sid] = ace as [string, string, string, string, string, string];
    if ((aceFlags ?? "").includes("ID")) inherited = true;
    if (type === "A" || type === "OA") allow.push(sid);
  }
  return { protectedDacl: flags.includes("P"), allow, inherited };
}

/** The pure verdict over an SDDL string and the current user's SID. */
export function ownerOnlyVerdict(sddl: string, userSid: string): AclVerdict {
  if (!SID.test(userSid)) return "unknown";
  const dacl = parseDacl(sddl);
  if (!dacl) return "unknown";
  if (!dacl.protectedDacl || dacl.inherited) return "broad";
  if (!dacl.allow.includes(userSid)) return "unknown";
  return dacl.allow.every(sid => sid === userSid || WELL_KNOWN_OWNER_SIDS.has(sid)) ? "owner-only" : "broad";
}

const system32 = (env: NodeJS.ProcessEnv, tool: string) => win32.join(env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows", "System32", tool);

export const defaultRunner: ToolRunner = (file, args) => execFileSync(file, [...args], { encoding: "utf8", windowsHide: true, timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] });

/** The current user's SID from `whoami /user /fo csv /nh`. */
export function currentUserSid(run: ToolRunner = defaultRunner, env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const out = run(system32(env, "whoami.exe"), ["/user", "/fo", "csv", "/nh"]);
    const sid = /"(S-1-[0-9-]+)"/.exec(out)?.[1] ?? null;
    return sid && SID.test(sid) ? sid : null;
  } catch { return null; }
}

/** Reads `path`'s DACL via `icacls /save` (UTF-16LE file) and answers the owner-only verdict. */
export function windowsAclCheck(path: string, run: ToolRunner = defaultRunner, env: NodeJS.ProcessEnv = process.env): AclVerdict {
  const sid = currentUserSid(run, env);
  if (!sid) return "unknown";
  const out = win32.join(tmpdir(), `murage-sentinel-acl-${randomBytes(8).toString("hex")}.txt`);
  try {
    run(system32(env, "icacls.exe"), [path, "/save", out, "/q"]);
    const text = readFileSync(out).toString("utf16le").replace(/^\uFEFF/, "");
    return ownerOnlyVerdict(text, sid);
  } catch { return "unknown"; }
  finally { try { rmSync(out, { force: true }); } catch { /* best effort */ } }
}

/** Replaces `path`'s DACL with owner-only access (current user + SYSTEM, inheritance removed). True on success. */
export function windowsAclRestrict(path: string, run: ToolRunner = defaultRunner, env: NodeJS.ProcessEnv = process.env): boolean {
  const sid = currentUserSid(run, env);
  if (!sid) return false;
  try {
    run(system32(env, "icacls.exe"), [path, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "/grant:r", "*S-1-5-18:(OI)(CI)F", "/q"]);
    return true;
  } catch { return false; }
}
