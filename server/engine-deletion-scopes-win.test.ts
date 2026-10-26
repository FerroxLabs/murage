// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Windows-only paths of F16 (pre-existing X2 and phase 2), with the REAL addon and real processes. Skipped elsewhere and where the
// addon is not built. On the Windows gate box:
//   pnpm install --frozen-lockfile && pnpm build:engine-exclusion && pnpm exec vitest run server/engine-deletion-scopes-win.test.ts
//   W1  a paste another process has open (with delete sharing, as libuv opens files) is refused by the share-none deletion handle and
//       is back under its name
//   W2  a process named codex.exe whose command line names the scope (mixed case, backslashes) opens it; one on the owner's folder
//       (CODEX_HOME) opens that folder and not the scope
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { configureScopes, engineState } from "./engine-closed.ts";
import { executeEnginePlans } from "./engine-exec.ts";
import { exclOps } from "./engine-fs.ts";
import { planEngineHistory } from "./engine-history-run.ts";
import { ASIDE_SUFFIX, homeKey } from "./engine-plan-core.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { builtAddonPath, useRealExclusion } from "./testing/engine-exclusion-fake.ts";
import { buildFixture } from "./testing/engine-history-fixtures.ts";
import { buildScope } from "./testing/engine-scope-fixture.ts";

const addon = builtAddonPath();
const runs = process.platform === "win32" && addon !== null;
const BOT = "f25024c1-a18e-4251-acf1-0c1713d9b6d9";

describe.skipIf(!runs)("F16 on Windows with the real addon", () => {
  let scratch = "", restore: (() => void) | null = null;
  const children: ChildProcess[] = [];
  beforeAll(() => { scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-f16-win-"))); restore = useRealExclusion(addon!); });
  afterEach(() => { for (const child of children.splice(0)) { try { child.kill(); } catch { /* gone */ } } configureScopes(null); });
  afterAll(() => { restore?.(); removeTempDirSync(scratch); });

  /** A child that keeps `file` open (node opens with read, write and delete sharing) until it is killed; resolves once it has it open. */
  function holdOpen(program: string, file: string, extra: string[] = [], env: NodeJS.ProcessEnv = process.env): Promise<ChildProcess> {
    const child = spawn(program, ["-e", `require("fs").openSync(${JSON.stringify(file)}, "r"); process.stdout.write("open\\n"); setInterval(() => {}, 1e6);`, ...extra], { stdio: ["ignore", "pipe", "ignore"], env });
    children.push(child);
    return new Promise((resolve, reject) => {
      child.stdout!.on("data", (chunk: Buffer) => { if (chunk.toString().includes("open")) resolve(child); });
      child.on("exit", () => reject(new Error("the holder ended")));
    });
  }

  it("W1: a paste another process has open is kept (held) and back under its name", async () => {
    const fx = buildFixture("claude", scratch);
    const home = fx.homes[0]!.home;
    const key = homeKey("claude", home);
    const planned = planEngineHistory({ kind: "plan", homes: fx.homes, folders: fx.folders, memoryFolders: fx.memoryFolders, sessions: fx.sessions });
    const plan = planned.plans![key]!;
    expect(executeEnginePlans({ [key]: { ...plan, steps: plan.steps.filter((step) => step.k === "rewrite") } }).failed).toEqual([]);
    const paste = plan.steps.find((step) => step.k === "removeUnlessReferenced") as { target: string } | undefined;
    expect(paste).toBeTruthy();
    const text = readFileSync(paste!.target, "utf8");
    await holdOpen(process.execPath, paste!.target);
    const ran = executeEnginePlans({ [key]: { ...plan, steps: plan.steps.filter((step) => step.k === "removeUnlessReferenced") } });
    expect(ran.reasons[paste!.target]).toBe("held");
    expect(readFileSync(paste!.target, "utf8")).toBe(text);
    expect(existsSync(`${paste!.target}${ASIDE_SUFFIX}`)).toBe(false);
  });

  it("W2: codex.exe naming the scope in mixed case with backslashes opens it; one in the owner's folder does not", async () => {
    const root = join(scratch, "w2");
    const native = join(root, "data", "native"), owner = join(root, "home", ".codex");
    mkdirSync(owner, { recursive: true });
    writeFileSync(join(owner, "history.jsonl"), "");
    const folder = join(root, "data", "workspaces", BOT, "threads", "t1");
    mkdirSync(folder, { recursive: true });
    const scope = buildScope(native, "codex", BOT, owner, folder, join(root, "data", "workspaces", BOT, "threads", "t2"));
    configureScopes(native);
    const codex = join(root, "codex.exe");
    copyFileSync(process.execPath, codex);
    const seen = async (child: ChildProcess) => { for (let tries = 0; tries < 100 && !exclOps.processes().some((item) => item.pid === child.pid); tries++) await new Promise((resolve) => setTimeout(resolve, 20)); };
    // the owner's codex runs on that folder: its CODEX_HOME names it (the real addon reads it from the process's own environment). A
    // codex on another home does not hold this one (ENGINE-CLOSED-SCOPE.md).
    const inOwner = await holdOpen(codex, join(owner, "history.jsonl"), [owner], { ...process.env, CODEX_HOME: owner });
    await seen(inOwner);
    expect(engineState("codex", owner).state).toBe("open");
    expect(engineState("codex", scope.home).state).toBe("closed");
    const naming = await holdOpen(codex, join(scope.home, "config.toml"), [scope.home.toUpperCase().replace(/\//g, "\\")]);
    await seen(naming);
    expect(engineState("codex", scope.home)).toMatchObject({ state: "open", via: "process" });
  });
});
