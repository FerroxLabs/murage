// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeCapability, closeCapabilitySeam, CLOSE_PROTOCOL, verifyAgentBrowserBinary } from "./browser-engine.ts";
import { closeOwnedBrowser, ownedCloseCli } from "./browser-owned-close.ts";
import { resolveAgentBrowserReleaseAsset } from "./browser-engine-release.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
const fixture = vi.hoisted(() => ({ output: "agent-browser 0.36.0", code: 0, spawns: vi.fn() }));
vi.mock("./cloud-home/browser-process.ts", async original => ({
  ...await original<typeof import("./cloud-home/browser-process.ts")>(),
  spawnCloudBrowser: (args: string[]) => {
    fixture.spawns(args);
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    queueMicrotask(() => { child.stdout.write(fixture.output); child.emit("close", fixture.code); });
    return child;
  },
}));
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "browser-panel-compat-"));
  fixture.output = "agent-browser 0.36.0"; fixture.code = 0; fixture.spawns.mockClear();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); removeTempDirSync(dir); });
const spec = () => {
  const command = join(dir, "engine"); writeFileSync(command, "fixture", { mode: 0o700 });
  return { command, args: [], env: { HOME: dir, AGENT_BROWSER_SESSION: "panel", AGENT_BROWSER_SOCKET_DIR: dir } };
};
function admission(command: string, target = "linux-x64") {
  const [platform, arch] = target.split("-");
  const asset = resolveAgentBrowserReleaseAsset(platform as NodeJS.Platform, arch)!;
  const s = statSync(command);
  return { path: resolve(command), stamp: `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`, asset };
}
it.each(["linux-x64", "darwin-arm64", "win32-x64"])("a completed version check and pinned %s admission select only the legacy panel protocol", async target => {
  const s = spec(); vi.spyOn(closeCapabilitySeam, "admission").mockReturnValue(admission(s.command, target));
  expect(closeCapability(s)).toEqual({ refuse: "engine_unverified" });
  await verifyAgentBrowserBinary(s.command, s.env); fixture.spawns.mockClear();
  expect(closeCapability(s)).toEqual({ cap: "legacy-v1" });
  expect(fixture.spawns).not.toHaveBeenCalled();
});
it("a version check without pinned admission grants no close capability", async () => {
  const s = spec(); await verifyAgentBrowserBinary(s.command, s.env);
  expect(closeCapability(s)).toEqual({ refuse: "engine_unverified" });
});
it("a replaced engine invalidates the version and pin observations", async () => {
  const s = spec(); vi.spyOn(closeCapabilitySeam, "admission").mockReturnValue(admission(s.command));
  await verifyAgentBrowserBinary(s.command, s.env); writeFileSync(s.command, "replaced fixture bytes");
  expect(closeCapability(s)).toEqual({ refuse: "engine_unverified" });
  await verifyAgentBrowserBinary(s.command, s.env);
  expect(closeCapability(s)).toEqual({ refuse: "engine_unverified" });
});
it("override provenance and an unsupported target never acquire the legacy protocol", async () => {
  const s = spec(); const observed = admission(s.command, "darwin-x64");
  vi.spyOn(closeCapabilitySeam, "admission").mockReturnValue(observed);
  await verifyAgentBrowserBinary(s.command, s.env);
  expect(closeCapability(s)).toEqual({ refuse: "engine_unverified" });
  observed.asset = admission(s.command).asset;
  expect(closeCapability({ ...s, env: { ...s.env, MURAGE_AGENT_BROWSER_PATH: s.command } })).toEqual({ refuse: "engine_unverified" });
});
it("the production process never consults synthetic admission", async () => {
  const s = spec(); const seam = vi.spyOn(closeCapabilitySeam, "admission").mockReturnValue(admission(s.command));
  await verifyAgentBrowserBinary(s.command, s.env); vi.stubEnv("NODE_ENV", "production");
  expect(closeCapability(s)).toEqual({ refuse: "engine_unverified" });
  expect(seam).not.toHaveBeenCalled();
});
it("an unused admitted legacy panel closes without a maintenance CLI or browser launch", async () => {
  const s = spec(); vi.spyOn(closeCapabilitySeam, "admission").mockReturnValue(admission(s.command));
  await verifyAgentBrowserBinary(s.command, s.env); fixture.spawns.mockClear();
  const cli = vi.spyOn(ownedCloseCli, "run");
  await expect(closeOwnedBrowser(s, null)).resolves.toBeUndefined();
  expect(cli).not.toHaveBeenCalled(); expect(fixture.spawns).not.toHaveBeenCalled();
});
it("a launch-bound owner window keeps its strict exhaustion protocol even on a legacy-admitted engine", async () => {
  const s = spec(); vi.spyOn(closeCapabilitySeam, "admission").mockReturnValue(admission(s.command));
  await verifyAgentBrowserBinary(s.command, s.env);
  const launchId = "0123456789abcdef";
  const cli = vi.spyOn(ownedCloseCli, "run").mockResolvedValue({ code: 0, stdout: JSON.stringify({ closed: true, launchId, groupExhausted: true, treeExhausted: true, outsideSeen: 0, unconfirmed: null }) });
  await expect(closeOwnedBrowser({ ...s, env: { ...s.env, AGENT_BROWSER_LAUNCH_ID: launchId } }, null)).rejects.toMatchObject({ code: "ownership_unproven" });
  expect(cli).not.toHaveBeenCalled();
});
it("the protocol table does not treat an unknown vendor revision as qualified", () => {
  expect(CLOSE_PROTOCOL["0.36.0-omb.4"]).toBeUndefined();
  expect(CLOSE_PROTOCOL["0.36.0-omb.2"].targets.has("win32-x64")).toBe(false);
  expect(CLOSE_PROTOCOL["0.36.0-omb.3"].targets.has("linux-x64")).toBe(false);
});
