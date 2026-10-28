// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// TEMPORARY diagnostic (never merged): prints the runner's real DACLs around the Sentinel restrict step.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { currentUserSid, windowsAclCheck, windowsAclRestrict } from "./win-acl.ts";

const sys = (tool: string) => join(process.env.SystemRoot ?? "C:\\Windows", "System32", tool);
function save(path: string): string {
  const out = join(tmpdir(), `diag-${Math.random().toString(16).slice(2)}.txt`);
  try {
    execFileSync(sys("icacls.exe"), [path, "/save", out, "/q"], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    return readFileSync(out).toString("utf16le").replace(/^\uFEFF/, "").replace(/\r?\n/g, " | ");
  } catch (error) { return `ERR ${String(error).slice(0, 300)}`; } finally { rmSync(out, { force: true }); }
}
function restrictRaw(path: string, sid: string): string {
  try {
    return execFileSync(sys("icacls.exe"), [path, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "/grant:r", "*S-1-5-18:(OI)(CI)F"], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) { return `ERR ${String(error).slice(0, 400)}`; }
}

describe.runIf(process.platform === "win32")("win acl diagnostic", () => {
  it("prints", () => {
    const lines: string[] = [];
    const sid = currentUserSid();
    lines.push(`whoami: ${execFileSync(sys("whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" }).trim()}`);
    lines.push(`groups: ${execFileSync(sys("whoami.exe"), ["/groups", "/fo", "csv", "/nh"], { encoding: "utf8" }).split(/\r?\n/).filter(l => /Mandatory Label|S-1-5-5-|Administrators/.test(l)).join(" ; ")}`);
    lines.push(`sid=${sid} tmpdir=${tmpdir()}`);
    let p = tmpdir();
    for (let i = 0; i < 6; i++) { lines.push(`anc ${p}: ${save(p)}`); const up = dirname(p); if (up === p) break; p = up; }
    const base = mkdtempSync(join(tmpdir(), "diag-acl-"));
    try {
      const parent = join(base, "MurageSentinel");
      mkdirSync(parent, { mode: 0o700 });
      lines.push(`new parent: ${save(parent)} verdict=${windowsAclCheck(parent)}`);
      lines.push(`raw restrict: ${restrictRaw(parent, sid ?? "S-1-0-0").trim()}`);
      lines.push(`after raw: ${save(parent)} verdict=${windowsAclCheck(parent)}`);
      const child = join(parent, "inst");
      mkdirSync(child, { mode: 0o700 });
      lines.push(`new child: ${save(child)} verdict=${windowsAclCheck(child)}`);
      lines.push(`restrict fn: ${windowsAclRestrict(child)}`);
      lines.push(`after fn: ${save(child)} verdict=${windowsAclCheck(child)}`);
    } finally { rmSync(base, { recursive: true, force: true }); }
    console.log(`DIAG>>\n${lines.join("\n")}\n<<DIAG`);
    expect(lines.join("\n")).toBe("DIAG-SHOW");
  });
});
