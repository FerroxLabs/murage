// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { mkdtempSync, mkdirSync, renameSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { canonicalProjectRoots, projectFileApproval, effectiveProjectProfile } from "./project-work-profile.ts";
const dirs: string[] = [];
const fresh = () => { const dir = mkdtempSync(join(tmpdir(), "project-roots-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
it("allows only structured files in current roots for owner audience", () => {
  const dir = fresh(); const root = join(dir,"work"); mkdirSync(root);
  const roots = canonicalProjectRoots([{ path: root, label: "Work" }], { dataDir: join(dir,"data") });
  const ask = { tool: "write", paths: [join(root,"new.txt")], roots, ownerAudience: true, effectiveProfile: "auto-in-roots" as const };
  expect(projectFileApproval(ask)).toBe(true);
  for (const tool of ["Bash", "mcp__app__write", "browser", "computer"]) expect(projectFileApproval({ ...ask, tool })).toBe(false);
  expect(projectFileApproval({ ...ask, roots: [] })).toBe(false);
  expect(projectFileApproval({ ...ask, ownerAudience: false })).toBe(false);
  for (const path of [join(dir,"outside"), root + "/../outside", "relative.txt"]) expect(projectFileApproval({ ...ask, paths: [path] })).toBe(false);
  symlinkSync(dir,join(root,"escape")); expect(projectFileApproval({ ...ask, paths: [join(root,"escape","out")] })).toBe(false);
  renameSync(root,join(dir,"old")); mkdirSync(root); expect(projectFileApproval(ask)).toBe(false);
});
it("rejects home, data, volume and non-directory roots", () => {
  const dataDir = fresh();
  for (const path of [homedir(), "/", dataDir, join(dataDir,"missing")]) expect(() => canonicalProjectRoots([{ path }], { dataDir })).toThrow();
});
it("derives engine limitations without widening engine permissions", () => {
  for (const engine of ["codex","antigravityAgent"]) expect(effectiveProjectProfile("auto-in-roots",true,engine,{})).toBe("engine");
  expect(effectiveProjectProfile("auto-in-roots",true,"claude",{ permissionMode:"default" })).toBe("auto-in-roots");
  expect(effectiveProjectProfile("auto-in-roots",true,"claude",{ permissionMode:"acceptEdits" })).toBe("engine");
  for (const engine of ["fuigoAgent","piAgent"]) expect(effectiveProjectProfile("auto-in-roots",true,engine,{})).toBe("auto-in-roots");
  expect(effectiveProjectProfile("auto-in-roots",false,"fuigoAgent",{})).toBe("ask");
  expect(effectiveProjectProfile("auto-in-roots",true,"fuigoAgent",{fullAuto:true})).toBe("engine");
});

it("describes the turn override while preserving ordinary engine modes", () => {
  const enforced = { routeAsks: true as const };
  // Claude's bypass becomes acceptEdits with the broker: the engine still allows edits itself.
  for (const mode of ["bypassPermissions", "acceptEdits", "auto"]) {
    expect(effectiveProjectProfile("ask",true,"claude",{permissionMode:mode},enforced)).toBe("engine");
  }
  expect(effectiveProjectProfile("auto-in-roots",true,"claude",{permissionMode:"bypassPermissions"},{stopLine:true})).toBe("engine");
  for (const engine of ["piAgent", "fuigoAgent", "geminiAgent", "kimiAgent", "qwenAgent", "hermesAgent", "grokAgent", "opencodeGo"]) {
    expect(effectiveProjectProfile("auto-in-roots",true,engine,{fullAuto:true},enforced)).toBe("auto-in-roots");
    expect(effectiveProjectProfile("ask",true,engine,{fullAuto:true},enforced)).toBe("ask");
    expect(effectiveProjectProfile("auto-in-roots",true,engine,{fullAuto:true})).toBe("engine");
  }
});

it("F11 desk bookkeeping still asks and ancestor roots cannot contain Murage data", () => {
  const dir = fresh(); const desk = join(dir, "desk"); mkdirSync(desk);
  const dataDir = join(dir, "data"); mkdirSync(dataDir);
  expect(() => canonicalProjectRoots([{ path: dir }], { dataDir })).toThrow();
  for (const name of ["CLAUDE.md", "AGENTS.md", "SOUL.md", "skills/tool.md", "credentials/token"]) {
    expect(projectFileApproval({ tool: "write", paths: [join(desk, name)], roots: [], deskRoots: [desk], ownerAudience: true, effectiveProfile: "auto-in-roots" })).toBe(false);
  }
  expect(projectFileApproval({ tool: "write", paths: [join(desk, "work.txt")], roots: [], deskRoots: [desk], ownerAudience: true, effectiveProfile: "auto-in-roots" })).toBe(true);
});
