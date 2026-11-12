import './signal-runtime-contract.checks.mjs';
import './signal-runtime-pin.checks.mjs';
import './signal-runtime-integrity.checks.mjs';
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
import { chmodSync, renameSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync, existsSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import { build } from "esbuild";
import { removeTempDirSync } from "../server/testing/cleanup.ts";
import { assertReleasePin, generateInventory, verifyInventory, treeDigest, TARGETS, runInventoryCommand } from "./signal-inventory.mjs";
import { stageRuntime, runStageCommand } from "./stage-signal-runtime.mjs";
import { verifyRuntimePin } from "../server/channels/signal/process-host.ts";
import { writeTestEvidence, syntheticSyncProof, FIXTURE_IDS, INVARIANTS } from "./fixtures/signal-evidence.mjs";
import { pinSyntheticTree } from "./fixtures/signal-runtime-tree.mjs";
import { normalizeRuntime } from "./normalize-signal-runtime.mjs";
import * as staging from "./stage-signal-runtime.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const put = (root, path, bytes) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes); };
// A stored ZIP with one entry; the bytes are synthetic, never release evidence.
function jar(entry, bytes) {
  const name = Buffer.from(entry), data = Buffer.from(bytes);
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + data.length, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}
function fixture(target = "linux-x64", sourceBuild = false) {
  const root = mkdtempSync(join(tmpdir(), "signal-runtime-")); roots.push(root);
  const runtime = join(root, "runtime"), input = join(root, "input"), licenseRoot = join(root, "licenses");
  const sourceRoot = join(root, "sources");
  const native = TARGETS[target].native;
  put(runtime, "signal-cli.jar", "fake CLI jar");
  put(runtime, "lib/signal-network-2.15.3_unofficial_157.jar", "fake network jar");
  put(runtime, "lib/libsignal-client.jar", jar("Synthetic.class", "fake class"));
  put(runtime, `native/${native}`, "fake JNI");
  put(runtime, "jre/release", 'JAVA_VERSION="25.0.1"\nJAVA_RUNTIME_VERSION="25.0.1+1"\nIMPLEMENTOR="Eclipse Adoptium"\n');
  put(runtime, `jre/bin/${target === "win32-x64" ? "java.exe" : "java"}`, "fake Java");
  put(runtime, "jre/lib/modules", "fake modules");
  const sqlite = target === "win32-x64" ? "sqlitejdbc.dll" : target === "darwin-arm64" ? "libsqlitejdbc.dylib" : "libsqlitejdbc.so";
  put(runtime, `native/${sqlite}`, "fake sqlite");
  const jars = ["signal-cli.jar", "lib/signal-network-2.15.3_unofficial_157.jar", "lib/libsignal-client.jar"].map(path => ({ path, sha256: digest(readFileSync(join(runtime, path))) }));
  const version = "0.14.11-SNAPSHOT";
  const artifact = { jars, jre: { build: "25.0.1+1", sha256: treeDigest(join(runtime, "jre")) },
    libsignal: { version: "fixture-tag", sha256: digest("fake JNI"), provenance: sourceBuild
      ? { kind: "source-build", tag: "fixture-tag", buildLog: "fixture release runner log" }
      : { kind: "upstream-jar", jar: "lib/libsignal-client.jar", entry: native } } };
  const pin = { contract: "murage-signal-runtime-pin/1.0", signalCliVersion: version, rateLimitNotSentProof: null,
    g0: { signalCliVersion: version, citation: "fixture S1 evidence" },
    signalNetwork: { coordinate: "com.github.turasa:signal-network", version: "2.15.3_unofficial_157", sha256: jars[1].sha256,
      syncProof: structuredClone(syntheticSyncProof) },
    targets: Object.fromEntries(Object.keys(TARGETS).map(t => {
      const value = structuredClone(artifact);
      if (t !== "darwin-arm64") value.libsignal.provenance = { kind: "upstream-jar", jar: "lib/libsignal-client.jar", entry: native };
      return [t, value];
    })) };
  pin.releaseInputs = Object.fromEntries(Object.keys(TARGETS).map(t => [t, {
    url: `https://example.test/reviewed/${t}.tar.gz`, sha256: digest("synthetic reviewed inputs archive"), layout: "prelinked-jre",
  }]));
  const fixtureRoot = join(sourceRoot, "server/channels/signal/fixtures/g0");
  writeTestEvidence(pin, fixtureRoot);
  const documents = ["signal-cli", "libsignal", "temurin", "classpath-exception"].map(component => {
    const path = `${component}/LICENSE.txt`, bytes = `synthetic ${component} licence text`;
    put(licenseRoot, path, bytes); return { component, path, sha256: digest(bytes) };
  });
  put(licenseRoot, "manifest.json", JSON.stringify({ documents }));
  put(sourceRoot, "src/components/SignalSettings.tsx", 'Signal link disconnect notes-stuck offline resend leave-it');
  put(sourceRoot, "server/channels/signal/types.ts", 'export type SignalProblem = "notes-stuck" | "offline";\nexport type SignalAction = { action: "link" | "disconnect" } | { action: "resend" | "leave-it"; deliveryId: string };\nexport type RpcId = string | number;');
  put(sourceRoot, "server/index.ts", '"/api/signal/status"');
  put(sourceRoot, "src/lib/settings-card-registry.ts", '// channels.signal channels.signal-help\ncard("signal", "channels", "signal-heading", {}); card("signal-help", "channels", "signal-help-heading", {});');
  put(sourceRoot, "src/lib/settings-index.ts", 'export const APP_SETTINGS_ENTRIES = SETTINGS_CARDS.map(card => ({ id: card.id }));');
  const surfaces = [
    ...["card", "search"].flatMap(kind => ["channels.signal", "channels.signal-help"].map(id => ({ kind, id, path: "src/lib/settings-card-registry.ts", why: "Find Signal settings." }))),
    { kind: "route", id: "/api/signal/status", path: "server/index.ts", why: "Show connection status." },
    { kind: "problem", id: "notes-stuck", path: "src/components/SignalSettings.tsx", why: "Show held notes." },
    { kind: "problem", id: "offline", path: "src/components/SignalSettings.tsx", why: "Show connection status." },
    { kind: "recovery", id: "link", path: "src/components/SignalSettings.tsx", why: "Start a link." },
    { kind: "recovery", id: "disconnect", path: "src/components/SignalSettings.tsx", why: "Disconnect Signal." },
    { kind: "review", id: "resend", path: "src/components/SignalSettings.tsx", why: "Review an uncertain reply." },
    { kind: "review", id: "leave-it", path: "src/components/SignalSettings.tsx", why: "Keep an uncertain reply." },
  ];
  put(sourceRoot, "server/channels/signal/signal.inventory.json", JSON.stringify({ surfaces }));
  cpSync(runtime, input, { recursive: true });
  renameSync(join(input, "jre"), join(input, "jdk"));
  const actual = pinSyntheticTree(runtime, target, licenseRoot);
  for (const t of Object.keys(TARGETS)) {
    const copy = structuredClone(actual);
    const sqliteOther = t === "win32-x64" ? "sqlitejdbc.dll" : t === "darwin-arm64" ? "libsqlitejdbc.dylib" : "libsqlitejdbc.so";
    const rename = path => path === `native/${native}` ? `native/${TARGETS[t].native}` : path === `native/${sqlite}` ? `native/${sqliteOther}` : path;
    copy.natives = copy.natives.map(n => ({ ...n, path: rename(n.path) }));
    copy.integrity.rows = copy.integrity.rows.map(r => ({ ...r, path: rename(r.path) })).sort((a,b)=> a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    pin.targets[t] = copy;
  }
  writeTestEvidence(pin, fixtureRoot);
  cpSync(fixtureRoot, join(runtime, "g0"), { recursive: true });
  cpSync(licenseRoot, join(runtime, "licenses"), { recursive: true });
  return { root, runtime, input, pin, target, licenseRoot, sourceRoot, fixtureRoot, destination: join(root, "staged"), surfaces };
}
async function record(f) {
  cpSync(f.fixtureRoot, join(f.runtime, "g0"), { recursive: true });
  const inventory = await generateInventory(f);
  put(f.runtime, "signal.inventory.json", JSON.stringify(inventory));
  put(f.runtime, "runtime-pin.json", JSON.stringify(f.pin));
  return inventory;
}
function runner(f, calls) {
  return (file, args, options) => {
    calls.push({ file, args, options });
    throw new Error(`Prelinked staging must not execute ${file}`);
  };
}

it.each([
  ["G0 marker", p => { p.g0 = null; }],
  ["G0 version", p => { p.g0.signalCliVersion = "0.0.0"; }],
  ["jar placeholder", p => { p.signalNetwork.sha256 = "G0_REQUIRED"; }],
  ["SYNC evidence", p => { p.signalNetwork.syncProof = null; }],
  ["PNI discard", p => { p.signalNetwork.syncProof.pniEndpointDiscard = "G0_REQUIRED"; }],
  ["identity source trace", p => { p.signalNetwork.syncProof.sourceIdentityTrace = ["JsonMessageEnvelope.java:50-55"]; }],
  ["network version", p => { p.signalNetwork.version = "2.15.3"; }],
  ["JNI placeholder", p => { p.targets["linux-x64"].libsignal.version = "G0_REQUIRED"; }],
  ["unshipped target", p => { p.targets["linux-arm64"] = p.targets["linux-x64"]; }],
  ["jar traversal", p => { p.targets["linux-x64"].jars[0].path = "../signal-cli.jar"; }],
  ["jar omission", p => { p.targets["linux-x64"].jars.splice(1, 1); }],
  ["rate-limit retry proof", p => { p.rateLimitNotSentProof = { signalCliVersion: p.signalCliVersion, citation: "fixture", reviewedBy: "fixture" }; }],
])("T-PIN: rejects %s (kill omitted release guard)", async (_, mutate) => {
  const f = fixture();
  expect(() => assertReleasePin(f.pin, f)).not.toThrow();
  await record(f); await expect(verifyInventory(f)).resolves.toBeDefined();
  mutate(f.pin);
  expect(() => assertReleasePin(f.pin, f)).toThrow();
  await expect(generateInventory(f)).rejects.toThrow();
  const calls = [];
  await expect(stageRuntime({ ...f, host: { platform: "linux", arch: "x64" }, run: runner(f, calls) })).rejects.toThrow();
  expect(calls).toHaveLength(0); expect(existsSync(f.destination)).toBe(false);
});
it("T-PIN: pending fixture reports G0 and blocks release before any command", async () => {
  const f = fixture(); expect(() => assertReleasePin(f.pin, f)).not.toThrow();
  const filled = structuredClone(f.pin);
  f.pin.g0 = null;
  const calls = [];
  await expect(stageRuntime({ ...f, run: runner(f, calls) })).rejects.toThrow(/G0/);
  await expect(verifyInventory(f)).rejects.toThrow(/G0/);
  expect(calls).toHaveLength(0);
  await expect(runInventoryCommand(["--pin-status"], f)).resolves.toMatch(/G0_REQUIRED.*blocked/);
  await expect(runInventoryCommand(["--check-pin"], f)).rejects.toThrow(/G0_REQUIRED/);
  await expect(runInventoryCommand(["--check-pin"], { ...f, pin: filled })).resolves.toMatch(/verified/);
  await expect(runInventoryCommand(["--pin-status"], { ...f, pin: filled })).resolves.toMatch(/verified/);
  await expect(runInventoryCommand([f.runtime, "--target", "linux-x64", "--check"], f)).rejects.toThrow(/G0_REQUIRED/);
  await expect(runStageCommand(["--target", "linux-x64", "--input", f.input], f)).rejects.toThrow(/G0_REQUIRED/);
});
it.each(["signal-cli.jar", "lib/signal-network-2.15.3_unofficial_157.jar", "jre/lib/modules", "native/libsignal_jni.so", "licenses/temurin/LICENSE.txt"])(
  "T-PIN: rejects changed %s (kill byte verification)", async path => {
    const f = fixture(); await expect(generateInventory(f)).resolves.toBeDefined();
    put(f.runtime, path, "tampered");
    await expect(generateInventory(f)).rejects.toThrow(path.startsWith("jre/") ? /unlisted changed/ : path.startsWith("native/") ? /unlisted changed/ : path.startsWith("licenses/") ? /license tree/ : /unlisted changed/);
  });
it.each(["surface", "runtime", "extra-jar", "missing-license"])("T-INVENTORY: rejects %s omission (kill complete inventory check)", async change => {
  const f = fixture(), inventory = await record(f); await expect(verifyInventory(f)).resolves.toBeDefined();
  if (change === "surface") inventory.surfaces.pop();
  if (change === "runtime") inventory.runtime.jars.pop();
  if (change === "extra-jar") put(f.runtime, "lib/extra.jar", "extra");
  if (change === "missing-license") rmSync(join(f.runtime, "licenses/libsignal/LICENSE.txt"));
  put(f.runtime, "signal.inventory.json", JSON.stringify(inventory));
  await expect(verifyInventory(f)).rejects.toThrow();
});
it("T-INVENTORY: discovers an added Signal route (kill fixed surface list)", async () => {
  const f = fixture(); await record(f); await expect(verifyInventory(f)).resolves.toBeDefined();
  put(f.sourceRoot, "server/index.ts", '"/api/signal/status"; "/api/signal/new-route"');
  await expect(generateInventory(f)).rejects.toThrow(/surface route is not declared/);
});
it.each(["problem", "recovery"])("T-INVENTORY: discovers an undeclared %s (kill partial surface declarations)", async kind => {
  const f = fixture(); await record(f); await expect(verifyInventory(f)).resolves.toBeDefined();
  const path = "server/channels/signal/types.ts", source = readFileSync(join(f.sourceRoot, path), "utf8");
  put(f.sourceRoot, path, source.replace(kind === "problem" ? '"notes-stuck"' : '"link"', kind === "problem" ? '"notes-stuck" | "new-problem"' : '"link" | "new-action"'));
  await expect(generateInventory(f)).rejects.toThrow(/surface (problem|action) is not declared/);
});
it.each(["card", "search", "problem", "recovery", "review"])("T-INVENTORY: generation reconciles every %s registration (kill category-only completeness)", async kind => {
  const f = fixture(); await expect(generateInventory(f)).resolves.toBeDefined();
  const index = f.surfaces.findIndex(s => s.kind === kind);
  f.surfaces.splice(index, 1);
  put(f.sourceRoot, "server/channels/signal/signal.inventory.json", JSON.stringify({ surfaces: f.surfaces }));
  await expect(generateInventory(f)).rejects.toThrow(/surface .* is not declared/);
});
it.each([
  ['{ id: "signal.notes", words: ["signal"] }', "signal.notes"],
  ['bot("channels", "signal-notes", () => "Notes", {})', "bot.channels.signal-notes"],
])("T-INVENTORY: discovers search index registration %s independently of declarations", async (registration, id) => {
  const f = fixture(), path = "src/lib/settings-index.ts";
  put(f.sourceRoot, path, `${readFileSync(join(f.sourceRoot, path), "utf8")}\nconst additional = [${registration}];`);
  f.surfaces.push({ kind: "search", id, path, why: "Find Signal notes." });
  put(f.sourceRoot, "server/channels/signal/signal.inventory.json", JSON.stringify({ surfaces: f.surfaces }));
  await expect(generateInventory(f)).resolves.toBeDefined();
  f.surfaces.pop();
  put(f.sourceRoot, "server/channels/signal/signal.inventory.json", JSON.stringify({ surfaces: f.surfaces }));
  await expect(generateInventory(f)).rejects.toThrow(`surface search is not declared: ${id}`);
});
it("T-INVENTORY: card and search snapshots hash their authoritative registry", async () => {
  const f = fixture(); await expect(generateInventory(f)).resolves.toBeDefined();
  f.surfaces.find(s => s.kind === "card").path = "src/components/SignalSettings.tsx";
  put(f.sourceRoot, "server/channels/signal/signal.inventory.json", JSON.stringify({ surfaces: f.surfaces }));
  await expect(generateInventory(f)).rejects.toThrow(/surface registration source differs/);
});
it.each(Object.keys({ "darwin-arm64": 1, "win32-x64": 1, "linux-x64": 1 }))("T-PIN: T-STAGE-NO-JLINK: stages %s without executing Java", async target => {
  const f = fixture(target), calls = [], [platform, arch] = target.split("-");
  await stageRuntime({ ...f, host: { platform, arch }, run: runner(f, calls) });
  expect(calls).toHaveLength(0);
  expect(treeDigest(join(f.destination, "jre"))).toBe(f.pin.targets[target].jre.sha256);
  await expect(verifyInventory({ ...f, runtime: f.destination })).resolves.toBeDefined();
  await expect(verifyRuntimePin({ runtimeDir: f.destination, pin: f.pin, target })).resolves.toMatchObject({ version: f.pin.signalCliVersion });
  put(f.destination, "jre/lib/modules", "changed staged image");
  await expect(verifyRuntimePin({ runtimeDir: f.destination, pin: f.pin, target })).rejects.toThrow("needs-update");
});
it("T-PIN: bundled startup shares the staging digest without checkout files or CLI side effects", async () => {
  const f = fixture();
  await stageRuntime({ ...f, host: { platform: "linux", arch: "x64" }, run: runner(f, []) });
  const outfile = join(f.root, "packaged-server.mjs");
  await build({ stdin: { contents: 'export { verifyRuntimePin } from "./server/channels/signal/process-host.ts";', resolveDir: process.cwd() },
    bundle: true, platform: "node", format: "esm", outfile,
    banner: { js: 'import { createRequire as requireForBundle } from "node:module"; const require = requireForBundle(import.meta.url);' } });
  const argv = process.argv, exitCode = process.exitCode;
  try {
    process.argv = [process.execPath, outfile];
    const bundled = await import(/* @vite-ignore */ pathToFileURL(outfile).href);
    expect(process.exitCode).toBe(exitCode);
    await expect(bundled.verifyRuntimePin({ runtimeDir: f.destination, pin: f.pin, target: f.target })).resolves.toBeDefined();
    put(f.destination, "jre/lib/modules", "changed packaged image");
    await expect(bundled.verifyRuntimePin({ runtimeDir: f.destination, pin: f.pin, target: f.target })).rejects.toThrow("needs-update");
  } finally { process.argv = argv; process.exitCode = exitCode; }
});
it("T-PIN: rejects mismatched staging host", async () => {
  const f = fixture(), calls = [];
  await stageRuntime({ ...f, host: { platform: "linux", arch: "x64" }, run: runner(f, calls) });
  const other = { ...f, destination: join(f.root, "wrong-host") };
  await expect(stageRuntime({ ...other, host: { platform: "darwin", arch: "arm64" }, run: runner(f, calls) })).rejects.toThrow(/host/i);
  expect(calls).toHaveLength(0);
});
it("T-STAGE-NO-JLINK: missing prelinked layout rejects before executing anything", async () => {
  const f = fixture(), calls = [];
  delete f.pin.releaseInputs[f.target].layout;
  writeTestEvidence(f.pin, f.fixtureRoot);
  await expect(stageRuntime({ ...f, host: { platform: "linux", arch: "x64" }, run: runner(f, calls) })).rejects.toThrow(/invalid reviewed release inputs/);
  expect(calls).toHaveLength(0);
  expect(existsSync(f.destination)).toBe(false);
});
it("T-PIN: stripped jars remain bound to original inventory rows", async () => {
  const f = fixture(); await record(f); await expect(verifyInventory(f)).resolves.toBeDefined();
  put(f.runtime, "lib/libsignal-client.jar", jar("libsignal_jni.so", "different embedded JNI"));
  f.pin.targets[f.target].jars[2].sha256 = digest(readFileSync(join(f.runtime, "lib/libsignal-client.jar")));
  writeTestEvidence(f.pin, f.fixtureRoot);
  await expect(generateInventory(f)).rejects.toThrow(/artifact row/);
});
it("T-PIN: failed archive extraction never publishes a runtime", async () => {
  const f = releaseFixture();
  await staging.stageReleaseRuntime(f);
  const destination = join(f.root, "failed"), run = f.run;
  await expect(staging.stageReleaseRuntime({ ...f, destination, run: (file, args, options) =>
    args[0] === "-xzf" ? { status: 1 } : run(file, args, options) })).rejects.toThrow(/extraction failed/);
  expect(existsSync(destination)).toBe(false);
});
it("T-PIN: failed integrity verification never publishes a partial runtime", async () => {
  const f = fixture();
  put(f.input, "native/libsqlitejdbc.so", "changed sqlite");
  await expect(stageRuntime({ ...f, host: { platform: "linux", arch: "x64" } })).rejects.toThrow(/unlisted changed/);
  expect(existsSync(f.destination)).toBe(false);
});
it.each(["jar", "JRE build", "licence placeholder"])("T-PIN: checks %s before copying the prelinked image (kill input preflight)", async change => {
  const f = fixture(), calls = [], host = { platform: "linux", arch: "x64" };
  await stageRuntime({ ...f, host, run: runner(f, calls) });
  if (change === "jar") put(f.input, "signal-cli.jar", "changed CLI");
  if (change === "JRE build") put(f.input, "jdk/release", 'JAVA_RUNTIME_VERSION="26+1"');
  if (change === "licence placeholder") {
    const manifest = JSON.parse(readFileSync(join(f.licenseRoot, "manifest.json"), "utf8"));
    manifest.documents[0].sha256 = "G0_REQUIRED";
    put(f.licenseRoot, "manifest.json", JSON.stringify(manifest));
  }
  await expect(stageRuntime({ ...f, destination: join(f.root, "bad-input"), host, run: runner(f, calls) })).rejects.toThrow();
  expect(calls).toHaveLength(0);
});
it("T-PIN: rejects altered prelinked JRE bytes without publishing a runtime", async () => {
  const f = fixture(), calls = [], host = { platform: "linux", arch: "x64" };
  await stageRuntime({ ...f, host, run: runner(f, calls) });
  const destination = join(f.root, "bad-image");
  put(f.input, "jdk/lib/modules", "changed image");
  await expect(stageRuntime({ ...f, destination, host, run: runner(f, calls) })).rejects.toThrow(/unlisted changed/);
  expect(calls).toHaveLength(0);
  expect(existsSync(destination)).toBe(false);
});
it("T-PIN: rejects an extra extracted file before publishing", async () => {
  const f = fixture();
  put(f.input, "native/unpinned.so", "extra");
  await expect(stageRuntime({ ...f, host: { platform: "linux", arch: "x64" } })).rejects.toThrow(/file set/);
  expect(existsSync(f.destination)).toBe(false);
});
it.skipIf(process.platform === "win32")("T-PIN: executable mode is part of the image hash (kill mode omission)", async () => {
  const f = fixture(); await record(f); await expect(verifyInventory(f)).resolves.toBeDefined();
  chmodSync(join(f.runtime, "jre/bin/java"), 0o755);
  await expect(verifyInventory(f)).rejects.toThrow(/unlisted changed/);
});
it("T-INVENTORY: supported package resources and blocking CI checks are wired", () => {
  const root = new URL("../", import.meta.url);
  const config = parse(readFileSync(new URL("electron-builder.yml", root), "utf8"));
  for (const [platform, from] of [["mac", "darwin-${arch}"], ["win", "win32-x64"], ["linux", "linux-x64"]]) {
    expect(config[platform].extraResources).toContainEqual(expect.objectContaining({ from: `dist-native/signal-runtime/${from}`, to: "signal-runtime" }));
  }
  const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  expect(pkg.scripts["check:signal-inventory"]).toContain("signal-inventory.mjs");
  const ci = readFileSync(new URL(".github/workflows/ci.yml", root), "utf8");
  expect(ci).not.toContain("node scripts/signal-inventory.mjs --check-pin");
  expect(ci).toContain("node scripts/signal-inventory.mjs --pin-status");
  const release = readFileSync(new URL(".github/workflows/release.yml", root), "utf8");
  for (const target of Object.keys(TARGETS)) expect(release).toContain(`--target ${target} --check`);
  const jobs = parse(release).jobs;
  for (const [job, target] of [["mac", "darwin-arm64"], ["windows", "win32-x64"], ["linux", "linux-x64"]]) {
    const steps = jobs[job].steps;
    const stage = steps.findIndex(s => s.run?.includes(`stage-signal-runtime.mjs --target ${target} --release`));
    const pack = steps.findIndex(s => s.run?.includes(`pnpm package:${job === "windows" ? "win" : job}`));
    expect(stage).toBeGreaterThanOrEqual(0);
    expect(stage).toBeLessThan(pack);
    expect(steps[stage].continueOnError ?? steps[stage]["continue-on-error"]).toBeUndefined();
  }
  expect(readFileSync(new URL("ci/gate-tests.txt", root), "utf8")).toContain("scripts/signal-runtime.test.mjs\tall\t");
});

function releaseFixture(target = "linux-x64") {
  const f = fixture(target, target === "darwin-arm64"), calls = [], downloads = [];
  const archive = Buffer.from("synthetic reviewed inputs archive");
  f.pin.releaseInputs = Object.fromEntries(Object.keys(TARGETS).map(t => [t, {
    url: `https://example.test/reviewed/${t}.tar.gz`, sha256: digest(archive), layout: "prelinked-jre",
  }]));
  writeTestEvidence(f.pin, f.fixtureRoot);
  const [platform, arch] = target.split("-");
  const host = { platform, arch, releaseRunner: true };
  const fetchInput = async url => { downloads.push(url); return { ok: true, arrayBuffer: async () => archive }; };
  const unexpectedCommand = runner(f, calls);
  const run = (file, args, options) => {
    if (file !== "tar") return unexpectedCommand(file, args, options);
    calls.push({ file, args, options });
    if (args[0] === "-tzf") return { status: 0, stdout: "signal-cli.jar\nlib/\nnative/\njdk/\n" };
    cpSync(f.input, args[args.indexOf("-C") + 1], { recursive: true });
    return { status: 0 };
  };
  return { ...f, host, fetchInput, run, calls, downloads, temporaryRoot: f.root };
}
it.each(Object.keys(TARGETS))("T-PIN: release fetches reviewed %s inputs and stages before packaging", async target => {
  const f = releaseFixture(target);
  await expect(staging.stageReleaseRuntime(f)).resolves.toBe(f.destination);
  expect(f.downloads).toEqual([f.pin.releaseInputs[target].url]);
  await expect(verifyRuntimePin({ runtimeDir: f.destination, pin: f.pin, target })).resolves.toBeDefined();
});
it.each(["runner", "target", "digest", "pending", "url", "missing input pin"])("T-PIN: release rejects %s before extraction (kill unreviewed download)", async change => {
  const f = releaseFixture();
  await staging.stageReleaseRuntime(f);
  const calls = f.calls.length, downloads = f.downloads.length;
  f.destination = join(f.root, "bad-release");
  if (change === "runner") f.host.releaseRunner = false;
  if (change === "target") f.host.arch = "arm64";
  if (change === "digest") f.pin.releaseInputs[f.target].sha256 = "0".repeat(64);
  if (change === "pending") f.pin.g0 = null;
  if (change === "url") f.pin.releaseInputs[f.target].url = "http://example.test/inputs.tar.gz";
  if (change === "missing input pin") delete f.pin.releaseInputs;
  await expect(staging.stageReleaseRuntime(f)).rejects.toThrow();
  expect(f.calls).toHaveLength(calls);
  expect(f.downloads).toHaveLength(downloads); // Changed archive pin fails its evidence binding before fetch.
  expect(existsSync(f.destination)).toBe(false);
});

it("T-INVENTORY: pending G0 still validates every B8 surface without runtime artifacts", async () => {
  const f = fixture();
  const options = { pin: { g0: null }, sourceRoot: f.sourceRoot };
  await expect(runInventoryCommand(["--check-surfaces"], options)).resolves.toContain("Signal surfaces verified");
  const declarations = JSON.parse(readFileSync(join(f.sourceRoot, "server/channels/signal/signal.inventory.json")));
  declarations.surfaces = declarations.surfaces.filter(row => row.kind !== "route");
  put(f.sourceRoot, "server/channels/signal/signal.inventory.json", JSON.stringify(declarations));
  await expect(runInventoryCommand(["--check-surfaces"], options)).rejects.toThrow("surface declarations are incomplete");
});

it("T-WIN-QUALIFICATION: every Windows quality job must run the provisioned B3 proof", () => {
  const ci = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
  const step = ci.jobs.quality.steps.find(step => step.run?.includes("ci-signal-windows.ps1"));
  expect(step, "Windows quality gate provisions and runs the foreign-owner qualification").toBeDefined();
  expect(step.if).toContain("windows");
  expect(step['continue-on-error']).toBeUndefined();
  expect(step.shell).toBe("pwsh");
});

it.each(Object.keys(TARGETS))("T-ARCHIVE-HASH: prelinked %s image stages, rejects changed bytes and HTTP", async target => {
  const f = releaseFixture(target);
  for (const input of Object.values(f.pin.releaseInputs)) input.layout = "prelinked-jre";
  writeTestEvidence(f.pin, f.fixtureRoot);
  await expect(staging.stageReleaseRuntime(f)).resolves.toBe(f.destination);
  expect(f.calls.every(c => c.file === "tar")).toBe(true);
  f.destination = join(f.root, "changed");
  const goodFetch = f.fetchInput;
  f.fetchInput = async () => ({ ok: true, arrayBuffer: async () => Buffer.from("synthetic reviewed inputs archivf") });
  await expect(staging.stageReleaseRuntime(f)).rejects.toThrow(/archive hash mismatch/);
  f.fetchInput = goodFetch;
  f.pin.releaseInputs[target].url = "http://example.test/inputs.tar.gz";
  await expect(staging.stageReleaseRuntime(f)).rejects.toThrow(/release inputs/);
});
it.each(Object.keys(TARGETS))("T-NATIVE-INVENTORY: %s requires sqlite as well as libsignal", async target => {
  const f = fixture(target);
  await expect(generateInventory(f)).resolves.toBeDefined();
  const sqlite = f.pin.targets[target].natives.find(n => n.path.includes('sqlite'));
  rmSync(join(f.runtime, sqlite.path));
  await expect(generateInventory(f)).rejects.toThrow(/file set/);
});
it("T-RUNTIME-INPUTS-GUARD: only G0 may be absent from runtime evidence", async () => {
  const f = releaseFixture(); f.pin.g0 = null;
  await expect(runInventoryCommand(["--assert-runtime-inputs"], f)).resolves.toMatch(/verified/);
  f.pin.signalNetwork.syncProof = null;
  await expect(runInventoryCommand(["--assert-runtime-inputs"], f)).rejects.toThrow(/S1-SYNC/);
});

it("T-ARCHIVE-HASH: reads an actual tar archive and rejects a one-byte mutation", async () => {
  const { spawnSync } = await import("node:child_process");
  const f = releaseFixture(), archive = join(f.root, "actual.tar.gz");
  const packed = spawnSync("tar", ["-czf", archive, "-C", f.input, "."], { encoding: "utf8" });
  expect(packed.status).toBe(0);
  const bytes = readFileSync(archive);
  f.pin.releaseInputs[f.target].sha256 = digest(bytes);
  writeTestEvidence(f.pin, f.fixtureRoot);
  f.fetchInput = async () => ({ ok: true, arrayBuffer: async () => bytes });
  f.run = (file, args, options) => file === "tar" ? spawnSync(file, args, options) : runner(f, f.calls)(file, args, options);
  await expect(staging.stageReleaseRuntime(f)).resolves.toBe(f.destination);
  const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1;
  f.fetchInput = async () => ({ ok: true, arrayBuffer: async () => changed });
  await expect(staging.stageReleaseRuntime({ ...f, destination: join(f.root, "bad") })).rejects.toThrow(/archive hash mismatch/);
  await expect(runStageCommand(["--target", f.target, "--release", "--archive", archive], f)).rejects.toThrow(/usage/);
});

it("T-JRE-TOOL-JAR: JRE tooling jars stay under the JRE tree pin, not the 51 application jars", async () => {
  const f = fixture();
  put(f.runtime, "jre/lib/jrt-fs.jar", "synthetic JRE filesystem provider");
  f.pin.targets[f.target] = pinSyntheticTree(f.runtime, f.target, f.licenseRoot);
  writeTestEvidence(f.pin, f.fixtureRoot);
  await record(f);
  await expect(verifyRuntimePin({ runtimeDir: f.runtime, pin: f.pin, target: f.target })).resolves.toBeDefined();
  put(f.runtime, "jre/lib/jrt-fs.jar", "tampered JRE filesystem provider");
  await expect(generateInventory(f)).rejects.toThrow(/unlisted changed/);
  await expect(verifyRuntimePin({ runtimeDir: f.runtime, pin: f.pin, target: f.target })).rejects.toThrow("needs-update");
});

// These exercise an otherwise valid pin. Failures on f40f8dc26 are missing
// integrity gates, not missing modules or unavailable live accounts.
it.each(["all", ...Object.keys(TARGETS)])("T-RELEASE-INPUTS-REQUIRED: rejects missing %s", target => {
  const f = fixture();
  expect(() => assertReleasePin(f.pin, f)).not.toThrow();
  if (target === "all") delete f.pin.releaseInputs;
  else delete f.pin.releaseInputs[target];
  expect(() => assertReleasePin(f.pin, f)).toThrow(/release inputs/);
});
it.each(["manifest digest", "full commit", "artifact binding", "missing fixture", "fixture bytes", "missing review", "neither echo proof", "security contradiction"])(
  "T-G0-BINDING: rejects %s despite matching SNAPSHOT versions", change => {
    const f = fixture();
    expect(() => assertReleasePin(f.pin, f)).not.toThrow();
    if (change === "manifest digest") f.pin.g0.manifestSha256 = "0".repeat(64);
    if (change === "full commit") f.pin.g0.signalCliCommit = "48a0a5e";
    if (change === "artifact binding") f.pin.targets["win32-x64"].jre.sha256 = "0".repeat(64);
    if (change === "missing fixture") writeTestEvidence(f.pin, f.fixtureRoot, m => { m.fixtures.pop(); });
    if (change === "fixture bytes") put(f.fixtureRoot, "own-note.json", "changed");
    if (change === "missing review") delete f.pin.g0.reviewedBy;
    if (change === "neither echo proof") writeTestEvidence(f.pin, f.fixtureRoot, m => { m.results['S1-TS'] = false; });
    if (change === "security contradiction") writeTestEvidence(f.pin, f.fixtureRoot, m => { m.securityInvariants['pni-endpoint'].passed = false; });
    expect(() => assertReleasePin(f.pin, f)).toThrow();
  });
it.each(["authenticatedSenderDiscard", "pniEndpointDiscard"])("T-SYNC-DEPENDENCY: rejects serialization-only %s", field => {
  const f = fixture();
  expect(() => assertReleasePin(f.pin, f)).not.toThrow();
  f.pin.signalNetwork.syncProof[field] = "signal-cli MessageEnvelope.java:1033 JsonMessageEnvelope.java:50-55";
  expect(() => assertReleasePin(f.pin, f)).toThrow(/dependency source/);
});
it("T-JRE-OUTPUT-DIGEST: a build JDK digest cannot substitute for the prelinked JRE", async () => {
  const f = fixture();
  put(f.input, "jdk/lib/modules", "unexpected replacement image");
  writeTestEvidence(f.pin, f.fixtureRoot);
  await expect(stageRuntime({ ...f, host: { platform: "linux", arch: "x64" }, run: runner(f, []) })).rejects.toThrow(/unlisted changed/);
});

it.each(['missing archives', 'unbound G0', 'sender citation', 'PNI citation'])(
  'T-AMENDMENT-BASELINE: legacy valid pin must reject %s', change => {
    const f = fixture();
    // The old schema permits only these two G0 fields. Do not mistake a schema
    // rejection of the NEW contract for RED evidence of the old bypass.
    f.pin.g0 = { signalCliVersion: f.pin.signalCliVersion, citation: 'synthetic legacy proof' };
    if (change === 'missing archives') delete f.pin.releaseInputs;
    if (change === 'sender citation') f.pin.signalNetwork.syncProof.authenticatedSenderDiscard = 'signal-cli MessageEnvelope.java:1033';
    if (change === 'PNI citation') f.pin.signalNetwork.syncProof.pniEndpointDiscard = 'signal-cli JsonMessageEnvelope.java:50-55';
    expect(() => assertReleasePin(f.pin, f)).toThrow();
  });

it('T-ACTIVATION-ECHO-GATE: otherwise verified production wiring requires timestamp or echo proof', async () => {
  const ts = await import('typescript');
  const source = readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8');
  const fn = source.match(/function signalEnabled\(\) \{[\s\S]*?\n\}/)[0];
  const js = ts.transpileModule(fn, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const f = fixture();
  const makeEnabled = () => {
    let verified = false;
    try { assertReleasePin(f.pin, f); verified = true; } catch { /* boot stays disabled */ }
    return new Function('signalRuntimePin', 'signalBoot', `
      const isCloudHome = () => false;
      ${js}
      return signalEnabled;
    `)(f.pin, { adapters: { verified, linkProtocol: verified ? {} : undefined } });
  };
  expect(makeEnabled()()).toBe(true);
  writeTestEvidence(f.pin, f.fixtureRoot, m => { m.results['S1-TS'] = false; });
  // Evidence is consumed at boot; changing it requires a new boot snapshot.
  expect(makeEnabled()()).toBe(false);
});

it.each(FIXTURE_IDS)('T-G0-FULL-SET: omitting %s blocks release even with a freshly reviewed digest', id => {
  const f = fixture();
  expect(() => assertReleasePin(f.pin, f)).not.toThrow();
  writeTestEvidence(f.pin, f.fixtureRoot, m => { m.fixtures = m.fixtures.filter(row => row.id !== id); });
  expect(() => assertReleasePin(f.pin, f)).toThrow();
});
it.each(INVARIANTS)('T-G0-SECURITY: a contradictory %s result blocks release', id => {
  const f = fixture();
  writeTestEvidence(f.pin, f.fixtureRoot, m => { m.securityInvariants[id].passed = false; });
  expect(() => assertReleasePin(f.pin, f)).toThrow();
});
it.each(['S1-TS', 'S1-ECHO'])('T-G0-ECHO: reviewed %s success suffices', proof => {
  const f = fixture();
  writeTestEvidence(f.pin, f.fixtureRoot, m => { m.results = { 'S1-TS': false, 'S1-ECHO': false, 'S7-UNLINK': false, [proof]: true }; });
  expect(() => assertReleasePin(f.pin, f)).not.toThrow();
});
it('T-G0-SELF-HASH: changing a fixture and its manifest hash does not change the reviewed pin', () => {
  const f = fixture();
  const path = join(f.fixtureRoot, 'manifest.json');
  const manifest = JSON.parse(readFileSync(path));
  put(f.fixtureRoot, 'own-note.json', '{"changed":true}');
  manifest.fixtures.find(row => row.id === 'own-note').sha256 = digest('{"changed":true}');
  writeFileSync(path, JSON.stringify(manifest));
  expect(() => assertReleasePin(f.pin, f)).toThrow(/manifest digest/);
});
it('T-ARCHIVE-LAYOUT: rejects an enclosing jars directory before extraction', async () => {
  const f = releaseFixture();
  const original = f.run;
  f.run = (file, args, options) => args[0] === '-tzf'
    ? { status: 0, stdout: 'jars/signal-cli.jar\njars/lib/\nnative/\njdk/\n' }
    : original(file, args, options);
  await expect(staging.stageReleaseRuntime(f)).rejects.toThrow(/archive layout/);
  expect(f.calls).toHaveLength(0);
});

it.skipIf(process.platform !== 'linux').each(Object.keys(TARGETS))(
  'T-NORMALIZE-ROOT-JRE: %s fragment hashes the output image and archives the root contract', async target => {
    const { spawnSync } = await import('node:child_process');
    const f = fixture(target), dist = join(f.root, 'dist'), output = join(f.root, 'archives');
    mkdirSync(dist); mkdirSync(output);
    put(output, 'jdeps.txt', 'java.base');
    put(f.runtime, 'jre/release', readFileSync(join(f.runtime, 'jre/release'), 'utf8') + 'MODULES="java.base"\n');
    // Real ZIPs, synthetic bytes; exercise the production layout normalizer.
    const made = spawnSync('python3', ['-c', `
import pathlib, sys, zipfile
root = pathlib.Path(sys.argv[1])
with zipfile.ZipFile(root / 'signal-cli-0.14.11-SNAPSHOT.jar', 'w') as archive:
    archive.writestr('META-INF/MANIFEST.MF', 'Manifest-Version: 1.0\\nMain-Class: Synthetic\\n')
with zipfile.ZipFile(root / 'libsignal-client-0.106.1.jar', 'w') as archive:
    for entry in ['libsignal_jni_aarch64.dylib', 'signal_jni_amd64.dll', 'libsignal_jni_amd64.so']:
        archive.writestr(entry, 'synthetic JNI')
with zipfile.ZipFile(root / 'sqlite-jdbc-3.54.1.0.jar', 'w') as archive:
    for entry in ['org/sqlite/native/Linux/x86_64/libsqlitejdbc.so', 'org/sqlite/native/Mac/aarch64/libsqlitejdbc.dylib', 'org/sqlite/native/Windows/x86_64/sqlitejdbc.dll']:
        archive.writestr(entry, 'synthetic sqlite')
for name in ['signal-network-2.15.3_unofficial_157.jar'] + ['synthetic-%02d.jar' % i for i in range(47)]:
    with zipfile.ZipFile(root / name, 'w') as archive:
        archive.writestr('Synthetic.class', 'synthetic class')
`, dist], { encoding: 'utf8' });
    expect(made.status, made.stderr).toBe(0);
    const image = join(f.runtime, 'jre');
    const sourcePin = {targets:{[target]:{jars:readdirSync(dist).filter(n=>!n.startsWith('signal-cli-')).map(n=>({path:'lib/'+n,sha256:digest(readFileSync(join(dist,n)))}))}}};
    const pinPath = join(f.root,'source-pin.json'); put(f.root,'source-pin.json',JSON.stringify(sourcePin));
    const fragment = await normalizeRuntime({ dist, jre: image, target, output, build: '25.0.1+1', pinPath, licenseRoot: f.licenseRoot });
    expect(fragment.record.jre.sha256).toBe(treeDigest(image));
    expect(fragment.record.jars).toHaveLength(51);
    expect(fragment.record.jars.some(row => row.path === 'signal-cli.jar')).toBe(true);
    expect(fragment.record.jars.every(row => !row.path.startsWith('jars/'))).toBe(true);
    const archive = join(output, new URL(fragment.releaseInput.url).pathname.split('/').at(-1));
    const listed = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' });
    expect(listed.status).toBe(0);
    expect(new Set(listed.stdout.trim().split('\n').map(path => path.split('/')[0])))
      .toEqual(new Set(['signal-cli.jar', 'lib', 'native', 'jdk']));
    expect(treeDigest(join(output, target, 'jdk'))).toBe(fragment.record.jre.sha256);
  });

it.skipIf(!process.env.SIGNAL_SIGNING_FIXTURES).each([
  ['darwin-arm64','macho',4096],['win32-x64','exe',512],
])('T-INVENTORY-RESIGNED: %s inventory retains authenticated original lengths with an injected trust probe', async (target,ext,offset) => {
  const f=fixture(target), path=`jre/bin/${target==='win32-x64'?'java.exe':'java'}`;
  put(f.runtime,path,readFileSync(join(process.env.SIGNAL_SIGNING_FIXTURES,'original.'+ext)));
  f.pin.targets[target]=pinSyntheticTree(f.runtime,target,f.licenseRoot);
  f.pin.targets[target].integrity.resigned={paths:[path],identity:target==='win32-x64'?{subject:'CN=Murage synthetic signature test'}:{teamId:'SYNTHETIC1'}};
  writeTestEvidence(f.pin,f.fixtureRoot);
  await record(f);
  const signed=readFileSync(join(process.env.SIGNAL_SIGNING_FIXTURES,'signed.'+ext));
  put(f.runtime,path,signed);
  await expect(verifyInventory({...f,probe:()=>true})).resolves.toBeDefined();
  await expect(verifyInventory({...f,probe:()=>false})).rejects.toThrow(/signature/);
  signed[offset]^=1;put(f.runtime,path,signed);
  await expect(verifyInventory({...f,probe:()=>true})).rejects.toThrow(/code changed/);
});
