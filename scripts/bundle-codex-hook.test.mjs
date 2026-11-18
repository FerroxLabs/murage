// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Rehearsal 2 Mac qualification failed before its guard control ran: the proof's bare ESM bundle of codex-hook.ts threw
// 'Dynamic require of "node:child_process" is not supported' on import. This bundles the hook exactly as the proof does, imports
// it, writes the hook and runs both proof shapes on this node: no stdin is blocked, and a launch without node mode is refused.
import { it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { blockedWithoutInput, bundleCodexHook } from "./bundle-codex-hook.mjs";
import { hookLaunchRefusal } from "../electron/proxy-launch-guard.mjs";
import { removeTempDir } from "../server/testing/cleanup.ts";

it("the proof's codex-hook bundle imports and its hook blocks, and the guard refuses it without node mode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-hook-bundle-"));
  try {
    const bundle = await bundleCodexHook(join(dir, "bundle", "codex-hook-bundle.mjs"));
    const { CODEX_HOOK_SCRIPT, HOOK_SCRIPT_FILE } = await import(pathToFileURL(bundle).href);
    expect(HOOK_SCRIPT_FILE).toBe("murage-hook.mjs");
    mkdirSync(join(dir, "scope"));
    const hook = join(dir, "scope", HOOK_SCRIPT_FILE);
    writeFileSync(hook, CODEX_HOOK_SCRIPT, { mode: 0o600 });
    const home = join(dir, "home");
    mkdirSync(home);
    const run = spawnSync(process.execPath, [hook], { env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 20_000 });
    expect(blockedWithoutInput({ code: run.status, stdout: run.stdout, stderr: run.stderr }), JSON.stringify(run)).toBe(true);
    expect(run.stdout).toContain('"permissionDecision":"deny"');
    // the proof's verdict is not always-true: an allow, a silent exit 0 and a stray exit 1 are not blocks
    expect(blockedWithoutInput({ code: 0, stdout: '{"hookSpecificOutput":{"permissionDecision":"allow"}}', stderr: "Murage blocked this call\n" })).toBe(false);
    expect(blockedWithoutInput({ code: 0, stdout: "", stderr: "" })).toBe(false);
    expect(blockedWithoutInput({ code: 0, stdout: run.stdout, stderr: "" })).toBe(false);
    expect(run.stderr).toContain("Murage blocked this call");
    expect(blockedWithoutInput({ code: 1, stdout: "", stderr: "Murage blocked this call\n" })).toBe(false);
    expect(hookLaunchRefusal(["/Applications/Murage.app/Contents/MacOS/Murage", hook, `--user-data-dir=${join(dir, "ud")}`], {})).toBe("Murage blocked this call: hook started without node mode");
  } finally { await removeTempDir(dir); }
}, 60_000);
