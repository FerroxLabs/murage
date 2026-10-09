// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BridgeHost } from "../server/channels/whatsapp/bridge-host.ts";
import { expect, it } from "vitest";
import { probeWhatsApp } from "./smoke-whatsapp-packaged.mjs";
it("requires the packaged handshake and an isolated dry-run supervisor", async () => {
  let options, stopped = false;
  class Host {
    constructor(value) { options = value; }
    async start() { options.onMessage({ kind: "ready", baileysVersion: "7.0.0-rc14", jimp: true, platform: "darwin", arch: "arm64", electronVersion: "43.4.0" }); }
    async stop() { stopped = true; options.onLifecycle({ kind: "exited", code: 0, signal: null }); }
  }
  const report = await probeWhatsApp({ platform: "darwin", arch: "arm64", electronVersion: "43.4.0", server: "/fixture/server", runtime: "/fixture/Electron", Host });
  expect(options.dryRun).toBe(true); expect(options.env.HOME).toContain("murage-whatsapp-probe-");
  expect(report).toMatchObject({ socketFree: true, jimp: true, arch: "arm64" }); expect(stopped).toBe(true);
});
it("refuses incomplete or timed-out packaged qualification", async () => {
  class WrongHost { constructor(o) { this.o = o; } async start() { this.o.onMessage({ kind: "ready", baileysVersion: "7.0.0-rc14", jimp: false }); } async stop() {} }
  await expect(probeWhatsApp({ platform: "darwin", arch: "arm64", electronVersion: "43.4.0", server: "/fixture", runtime: "/runtime", Host: WrongHost })).rejects.toThrow("runtime mismatch");
  class SilentHost { async start() {} async stop() {} }
  await expect(probeWhatsApp({ platform: "darwin", arch: "arm64", electronVersion: "43.4.0", server: "/fixture", runtime: "/runtime", Host: SilentHost, timeoutMs: 5 })).rejects.toThrow("timed out");
});

it.each([
  { electronVersion: undefined }, { electronVersion: "42.0.0" }, { platform: "linux" }, { arch: "x64" },
])("rejects a runtime outside the expected Electron target: %j", async mismatch => {
  class Host {
    constructor(o) { this.o = o; }
    async start() { this.o.onMessage({ kind: "ready", baileysVersion: "7.0.0-rc14", jimp: true, platform: "darwin", arch: "arm64", electronVersion: "43.4.0", ...mismatch }); }
    async stop() { this.o.onLifecycle({ kind: "exited", code: 0, signal: null }); }
  }
  await expect(probeWhatsApp({ server: "/fixture", runtime: "/runtime", platform: "darwin", arch: "arm64", electronVersion: "43.4.0", Host })).rejects.toThrow("runtime mismatch");
});
it("bounds cleanup independently of child exit", async () => {
  class Host { async start() {} async stop() { await new Promise(() => {}); } }
  await expect(probeWhatsApp({ server: "/fixture", runtime: "/runtime", platform: "darwin", arch: "arm64", electronVersion: "43.4.0", Host, timeoutMs: 5, cleanupMs: 5 })).rejects.toThrow("timed out");
}, 1000);

it("rejects a spawn error immediately and bounds its cleanup", async () => {
  class Host {
    constructor(o) { this.o = o; }
    async start() { this.o.onLifecycle({ kind: "spawn-error" }); }
    async stop() { await new Promise(() => {}); }
  }
  await expect(probeWhatsApp({ server: "/fixture", runtime: "/missing-runtime", platform: "darwin", arch: "arm64", electronVersion: "43.4.0", Host, timeoutMs: 5000, cleanupMs: 5 })).rejects.toThrow("exited before qualification");
}, 1000);

it("rejects an ordinary Node executable through the real supervisor", async () => {
  const server = mkdtempSync(join(tmpdir(), "wa-node-probe-"));
  try {
    mkdirSync(join(server, "channels/whatsapp"), { recursive: true });
    writeFileSync(join(server, "channels/whatsapp/bridge.js"), `
      process.send({ kind: "ready", v: 1 });
      process.on("message", m => {
        if (m.kind === "init") {
          process.send({ kind: "ready", v: 1, baileysVersion: "7.0.0-rc14", jimp: true, platform: process.platform, arch: process.arch, electronVersion: process.versions.electron });
          process.send({ kind: "initialized" });
        }
        if (m.kind === "stop") process.exit(0);
      });
    `);
    await expect(probeWhatsApp({ server, runtime: process.execPath, platform: process.platform, arch: process.arch, electronVersion: "43.4.0", Host: BridgeHost })).rejects.toThrow("runtime mismatch");
  } finally { rmSync(server, { recursive: true, force: true }); }
});
it("rejects a nonexistent executable through the real supervisor", async () => {
  await expect(probeWhatsApp({ server: tmpdir(), runtime: join(tmpdir(), "missing-electron"), platform: process.platform, arch: process.arch, electronVersion: "43.4.0", Host: BridgeHost, timeoutMs: 100, cleanupMs: 20 })).rejects.toThrow("could not spawn");
}, 1000);
