/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Health checks on a self-hosted box (1.0.9 Sentinel, GAP-SENTINEL-109 section 10.1): `murage start` writes this
 * installation's descriptor through the payload's own boundary and runs the scanner's watch supervisor as an owned
 * child. Needs `pnpm build:server` (dist-server/health/host-boundary.js).
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";

import { prepareSentinel, sentinelPayload, sentinelWatchSpec } from "../lib/sentinel.mjs";
import { startSentinel } from "../bin/murage.mjs";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";

const POSIX_ONLY = process.platform === "win32" && "owner-only mode checks are POSIX-only";
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BOUNDARY = join(REPO, "dist-server", "health", "host-boundary.js");
const boundary = await import(pathToFileURL(BOUNDARY).href);
const loadBoundary = async () => boundary;

const scratchDirs = [];
after(() => { for (const dir of scratchDirs.splice(0)) safeWipeSync(dir); });
function rig() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "murage-selfhost-sentinel-")));
  scratchDirs.push(base);
  chmodSync(base, 0o700);
  const dataDir = join(base, "data");
  const payloadRoot = join(base, "payload", "server");
  for (const dir of [dataDir, join(payloadRoot, "sentinel"), join(payloadRoot, "health")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const serverEntry = join(payloadRoot, "index.js");
  writeFileSync(serverEntry, "// server\n");
  writeFileSync(join(payloadRoot, "sentinel", "cli.js"), "// scanner entry\n");
  writeFileSync(join(payloadRoot, "health", "host-boundary.js"), "// boundary\n");
  const env = { HOME: join(base, "home"), XDG_STATE_HOME: join(base, "state"), MURAGE_DATA_DIR: dataDir, MURAGE_COMPANION_TOKEN: "secret", PATH: "/usr/bin" };
  return { base, dataDir, serverEntry, env, payload: sentinelPayload(serverEntry) };
}

test("the scanner payload sits next to the server entry; a payload without it has no health checks", () => {
  const fx = rig();
  assert.deepEqual(fx.payload, { entry: join(dirname(fx.serverEntry), "sentinel", "cli.js"), boundary: join(dirname(fx.serverEntry), "health", "host-boundary.js") });
  assert.equal(sentinelPayload(join(fx.base, "elsewhere", "index.js")), null);
  assert.equal(sentinelPayload(join(REPO, "server", "index.ts")), null, "a TypeScript checkout entry has no bundled scanner");
});

test("writes this installation's descriptor at every start with the next revision, so an earlier watcher retires", { skip: POSIX_ONLY }, async () => {
  const fx = rig();
  const first = await prepareSentinel({ payload: fx.payload, dataDir: fx.dataDir, env: fx.env, platform: "linux", execPath: "/usr/local/bin/node", loadBoundary });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.written, true);
  assert.equal(first.revision, 1);
  assert.equal(first.installationId, boundary.sentinelInstallationId(fx.dataDir));
  assert.equal(first.outputRoot, join(fx.env.XDG_STATE_HOME, "MurageSentinel", first.installationId));
  const loaded = boundary.loadDescriptor(first.descriptorPath, { platform: "linux" });
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  assert.equal(loaded.value.inputRoot, join(fx.dataDir, "health"));
  assert.deepEqual(loaded.value.executable, { path: "/usr/local/bin/node", entry: fx.payload.entry, sha256: loaded.value.executable.sha256 });
  assert.match(loaded.value.executable.sha256, /^[0-9a-f]{64}$/);

  const again = await prepareSentinel({ payload: fx.payload, dataDir: fx.dataDir, env: fx.env, platform: "linux", execPath: "/usr/local/bin/node", loadBoundary });
  assert.deepEqual({ written: again.written, revision: again.revision }, { written: true, revision: 2 });

  writeFileSync(fx.payload.entry, "// scanner entry, next version\n");
  const updated = await prepareSentinel({ payload: fx.payload, dataDir: fx.dataDir, env: fx.env, platform: "linux", execPath: "/usr/local/bin/node", loadBoundary });
  assert.deepEqual({ ok: updated.ok, written: updated.written, revision: updated.revision }, { ok: true, written: true, revision: 3 });
  const descriptor = JSON.parse(readFileSync(updated.descriptorPath, "utf8"));
  assert.equal(descriptor.scheduleRevision, 3);
});

test("a missing data directory or an unloadable boundary is a waiting reason, never a throw", async () => {
  const fx = rig();
  assert.deepEqual(await prepareSentinel({ payload: fx.payload, dataDir: join(fx.base, "missing"), env: fx.env, platform: "linux", loadBoundary }), { ok: false, reason: "data-dir" });
  assert.deepEqual(await prepareSentinel({ payload: fx.payload, dataDir: fx.dataDir, env: fx.env, platform: "linux", loadBoundary: async () => { throw new Error("missing"); } }), { ok: false, reason: "boundary" });
});

test("the watch supervisor runs the entry with the descriptor and an allowlisted environment only", () => {
  const spec = sentinelWatchSpec({ execPath: "/usr/local/bin/node", entry: "/opt/payload/server/sentinel/cli.js", descriptorPath: "/state/MurageSentinel/x/descriptor.json", env: { HOME: "/h", XDG_STATE_HOME: "/state", MURAGE_COMPANION_TOKEN: "secret", OPENAI_API_KEY: "k", PATH: "/usr/bin", TZ: "UTC" } });
  assert.deepEqual(spec, { command: "/usr/local/bin/node", args: ["/opt/payload/server/sentinel/cli.js", "/state/MurageSentinel/x/descriptor.json", "--watch"], env: { HOME: "/h", XDG_STATE_HOME: "/state", TZ: "UTC" } });
});

test("murage start owns the scanner child; a refused preparation is one warning and nothing is spawned", async () => {
  const fx = rig();
  const warnings = [];
  const spawned = [];
  const fakeSpawn = (command, args, options) => {
    spawned.push({ command, args, env: options.env, detached: options.detached });
    const child = new EventEmitter();
    child.pid = 4242; child.exitCode = null; child.signalCode = null;
    child.kill = () => { child.exitCode = 0; queueMicrotask(() => child.emit("exit", 0, null)); return true; };
    return child;
  };
  const prepare = async () => ({ ok: true, descriptorPath: "/state/MurageSentinel/x/descriptor.json" });
  const owned = await startSentinel(fx.env, fx.serverEntry, { prepare, spawn: fakeSpawn, execPath: "/usr/local/bin/node", warn: line => warnings.push(line) });
  assert.ok(owned, "an owned child");
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].args, [fx.payload.entry, "/state/MurageSentinel/x/descriptor.json", "--watch"]);
  assert.equal(spawned[0].env.MURAGE_COMPANION_TOKEN, undefined, "no launch secret reaches the scanner");
  assert.equal(spawned[0].detached, true, "detached: it outlives a crash of murage start");
  await owned.stop();
  assert.deepEqual(warnings, []);

  const refused = await startSentinel(fx.env, fx.serverEntry, { prepare: async () => ({ ok: false, reason: "output-root-owner" }), spawn: fakeSpawn, warn: line => warnings.push(line) });
  assert.equal(refused, null);
  assert.equal(spawned.length, 1, "nothing spawned");
  assert.deepEqual(warnings, ["health checks are waiting (output-root-owner); Murage runs as usual."]);

  assert.equal(await startSentinel(fx.env, join(fx.base, "no-payload", "index.js"), { spawn: fakeSpawn, warn: line => warnings.push(line) }), null);
  assert.equal(spawned.length, 1);
});

test("murage start stops the scanner only on an explicit stop, never when the harness or sidecar fails", () => {
  const source = readFileSync(join(REPO, "installer", "bin", "murage.mjs"), "utf8");
  assert.match(source, /Promise\.allSettled\(\[harness\?\.stop\(signal\), sidecar\?\.stop\(signal\), explicit \? sentinel\?\.stop\(signal\) : undefined, starting\]\)/);
  assert.match(source, /process\.on\("SIGINT", \(\) => \{ void shutdown\(130, "SIGINT", true\); \}\);/);
  assert.match(source, /process\.on\("SIGTERM", \(\) => \{ void shutdown\(143, "SIGTERM", true\); \}\);/);
  assert.match(source, /harness\.child\.once\("exit", \(code\) => \{ void shutdown\(code \?\? 1\); \}\);/);
  assert.match(source, /const started = await startSentinel\(env, found\.entry\);/);
});
