// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Owner-only access on Windows for the Sentinel output root (1.0.9, GAP-SENTINEL-109 section 7). chmod does not
// restrict access on Windows, so the check reads the real DACL by SID (locale independent): `icacls <path> /save`
// writes SDDL, which is parsed here. Owner-only means: a protected DACL (no inherited entries) whose allow entries name
// only the current user, LocalSystem and the built-in Administrators. Any other allow entry (Everyone, Users,
// Authenticated Users, another account) is broad access and fails closed.
//
// SDDL spells some accounts as two-letter aliases, and an account is compared as the SID it names: SY and BA read the
// same as S-1-5-18 and S-1-5-32-544 (the values shared/windows-sddl.mjs holds; this file cannot import it, since the
// scanner bundle may inline only server/sentinel and the health contract, scripts/sentinel-bundle-check.mjs). Every
// other alias stays as text and is never root-like, so it reads as broad. The built-in local Administrator account (RID 500) is
// written as "LA", never as its numeric SID: when Murage runs as that account (Windows Server, cloud and CI machines),
// the user's own entry reads "LA". LA counts as root-like for anyone, since Windows never removes that account from
// Administrators, and it is the user's own entry when the user is a RID-500 account.
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
const DACL_ACE_TYPES = new Set(["A", "D", "OA", "OD"]);
/** The built-in local Administrator account's SDDL alias (this computer's account domain, RID 500). */
const LOCAL_ADMINISTRATOR = "LA";
/** SYSTEM, built-in Administrators, and the built-in Administrator account (always a member of Administrators). */
const ROOT_LIKE = new Set(["S-1-5-18", "S-1-5-32-544", LOCAL_ADMINISTRATOR]);
/** A local or domain account SID with RID 500: the account SDDL may write as "LA". */
const RID_500 = /^S-1-5-21-\d+-\d+-\d+-500$/;
/** The two root-like accounts' SDDL aliases and their SIDs. */
const ROOT_ALIASES: Readonly<Record<string, string>> = Object.freeze({ SY: "S-1-5-18", BA: "S-1-5-32-544" });
/** An SDDL account as compared: numeric SIDs as written, SY and BA as their SIDs, any other alias kept as text (so it
 * matches nothing root-like and fails closed). */
const accountSid = (text: string): string => Object.hasOwn(ROOT_ALIASES, text) ? ROOT_ALIASES[text]! : text;

/** Allow-ACE accounts of a DACL in SDDL (as SIDs, see accountSid), plus whether the DACL is protected (no inheritance). Null when unparseable. */
export function parseDacl(text: string): { protectedDacl: boolean; allow: string[]; inherited: boolean } | null {
  // `icacls /save` writes the file name on one line and the SDDL on the next; only the SDDL line is parsed (a drive
  // letter such as "D:\" in the name line must never be read as a DACL).
  const sddl = text.split(/\r?\n/).map(line => line.trim()).find(line => /^(?:O:|G:|D:)/.test(line) && line.includes("D:")) ?? "";
  // The DACL must run to the end of the line (or to a SACL): an entry this parser cannot read (a conditional ACE with
  // nested parentheses, NO_ACCESS_CONTROL) makes the whole DACL unparseable, never a shorter list that skips it.
  const start = sddl.indexOf("D:");
  const match = start < 0 ? null : /^D:([A-Z]*)((?:\([^()]*\))*)(?:S:.*)?$/.exec(sddl.slice(start));
  if (!match) return null;
  const flags = match[1] ?? "";
  const aces = [...(match[2] ?? "").matchAll(/\(([^()]*)\)/g)].map(m => (m[1] ?? "").split(";"));
  const allow: string[] = [];
  let inherited = false;
  for (const ace of aces) {
    if (ace.length !== 6) return null;
    const [type, aceFlags, , , , sid] = ace as [string, string, string, string, string, string];
    // Only plain and object allow/deny entries are understood; any other type (callback, conditional, ...) fails closed.
    if (!DACL_ACE_TYPES.has(type)) return null;
    if ((aceFlags ?? "").includes("ID")) inherited = true;
    if (type === "A" || type === "OA") allow.push(accountSid(sid));
  }
  return { protectedDacl: flags.includes("P"), allow, inherited };
}

/** The pure verdict over an SDDL string and the current user's SID. */
export function ownerOnlyVerdict(sddl: string, userSid: string): AclVerdict {
  if (!SID.test(userSid)) return "unknown";
  const dacl = parseDacl(sddl);
  if (!dacl) return "unknown";
  if (!dacl.protectedDacl || dacl.inherited) return "broad";
  const userGranted = dacl.allow.includes(userSid) || (RID_500.test(userSid) && dacl.allow.includes(LOCAL_ADMINISTRATOR));
  if (!userGranted) return "unknown";
  return dacl.allow.every(sid => sid === userSid || ROOT_LIKE.has(sid)) ? "owner-only" : "broad";
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
