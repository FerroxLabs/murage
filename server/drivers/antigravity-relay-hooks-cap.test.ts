// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The workspace hooks.json that relayHookLoadState counts is read through a size bound (1 MiB): a bigger file is treated as one that
// could not be read, so the turn is refused, and the read never takes more than the bound from a file that grows.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { relayHookLoadState } from "./antigravity-relay.ts";

const CAP = 1024 * 1024;
const ours = "/d/native/antigravity-scope/t1/home/.gemini/config/hooks.json";
const loadedLine = (named: number, files: number) => `I1022 hooks_manager.go:53] loaded ${named} named hooks from ${files} hooks.json file(s)`;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
/** A workspace whose .agents/hooks.json is one JSON object with a single key, padded to exactly `bytes` bytes. */
function workspaceWithHooks(bytes: number): string {
  const root = mkdtempSync(join(tmpdir(), "murage-agy-hookcap-")); roots.push(root);
  mkdirSync(join(root, ".agents"), { recursive: true });
  const shell = JSON.stringify({ k: "" });
  writeFileSync(join(root, ".agents", "hooks.json"), JSON.stringify({ k: "x".repeat(bytes - shell.length) }));
  return root;
}
// agy counts our one hook plus the workspace file's one key, from two hooks.json files
const state = (workspaceDir: string) => relayHookLoadState(loadedLine(2, 2), { hooksPath: ours, workspaceDirs: [workspaceDir], allowWorkspaceHooks: true });

describe("Antigravity relay: the workspace hooks.json read is size-bounded", () => {
  it("a workspace hooks.json inside the bound is counted as before", () => {
    expect(state(workspaceWithHooks(64))).toEqual({ state: "loaded" });
  });
  it("a file of exactly the bound is read", () => {
    expect(state(workspaceWithHooks(CAP))).toEqual({ state: "loaded" });
  });
  it("a file one byte over the bound is refused, not parsed", () => {
    expect(state(workspaceWithHooks(CAP + 1))).toEqual({ state: "refused" });
  });
  it("a file far over the bound is refused", () => {
    expect(state(workspaceWithHooks(8 * CAP))).toEqual({ state: "refused" });
  });
});
