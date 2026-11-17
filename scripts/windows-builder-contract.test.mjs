// Locked builder dispatch/tests owner: win-sac-sign; full Windows resource/NSIS/ZIP integration owner: MAIN.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../server/testing/cleanup.ts";
import { verifyWindowsBuilderDispatch } from "./windows-builder-contract.mjs";
const require = createRequire(import.meta.url), builder = createRequire(require.resolve("electron-builder/package.json")), library = createRequire(builder.resolve("app-builder-lib/package.json"));
const roots = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) removeTempDirSync(root); });
it("pins the reviewed real builder dispatch bytes and invalidates dependency upgrades", () => {
  expect(() => verifyWindowsBuilderDispatch(library)).not.toThrow();
  const changed = Object.assign(file => file === "./package.json" ? { version: "unreviewed" } : library(file), { resolve: library.resolve });
  expect(() => verifyWindowsBuilderDispatch(changed)).toThrow("WINDOWS_BUILDER_VERSION_UNREVIEWED");
});
it("real locked builder publisher/custom callback dispatch never initializes Azure or invokes the stock signer", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "real-builder-dispatch-")); roots.push(root);
  // Builder dynamically imports its callback through native Node, so the whole
  // fixture must share that module registry rather than Vitest's transformed one.
  const result = spawnSync(process.execPath, ["scripts/fixtures/windows-builder-dispatch.mjs", root], {
    encoding: "utf8", timeout: 30_000, env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false", CSC_LINK: "", WIN_CSC_LINK: "" } });
  expect(result.status, result.stderr).toBe(0);
});
