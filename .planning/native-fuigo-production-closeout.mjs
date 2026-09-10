import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineManager } from "../server/engine-management.ts";
import { managedFuigoReceipt, nativeFuigoPackage, nativeFuigoTarget, probeNativeFuigo, stageNativeFuigo } from "../server/fuigo-native-update.ts";

// A distinct native proof from the earlier custom synthetic-probe receipt.
// The manager uses its unchanged DEFAULT production probe for every action.
assert.equal(process.platform, "darwin"); assert.equal(process.arch, "x64");
assert.equal(process.versions.node, "24.20.0");
const translated = spawnSync("/usr/sbin/sysctl", ["-in", "sysctl.proc_translated"], { encoding: "utf8", timeout: 5000 });
assert.notEqual(translated.stdout.trim(), "1", "Rosetta is not native Intel qualification");
const root = await mkdtemp(join(tmpdir(), "murage-fuigo-production-closeout-"));
const output = new URL("./0150-intel-native/darwin-x64.json", import.meta.url);
const hash = async path => createHash("sha256").update(await readFile(path)).digest("hex");
const result = { startedAt: new Date().toISOString(), target: `${process.platform}-${process.arch}`, node: process.version, root,
  sourceCandidate: "11549fff0d7f0f15775b8d274e8aed7dffad1bff", fixtureCommit: process.env.GITHUB_SHA ?? null,
  runId: process.env.GITHUB_RUN_ID ?? null, runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  translated: { status: translated.status, value: translated.stdout.trim() }, native: true, probe: "production probeNativeFuigo, no injected FuigoProbe",
  activation: "isolated persisted selection callback; owner HTTP callback proved separately",
  noOwnerCredentials: true, noPrompt: true, previousReceiptsPreserved: true, steps: [], downloads: [] };
let version = "1.0.9";
const pins = {
  "1.0.9": { tarballSha256: "5ae11a345d1d93c4dff3a47522019c4425fb742d08c3dc8d9273e46b71f21468", binarySha256: "6b0ad2051183fc3a239594e87b14fe4631e012b087474dca38b032618a41d761" },
  "1.0.10": { tarballSha256: "6957a109e9ebf2a6d51a49e10202318870e87536aac805c4efda9c744aed7753", binarySha256: "c0fad0e8b1b0cd93d278e66acfebc4235f6fc19a4bfcb53af4080c9e7892e8a8" },
};
const productionHashes = {
  "server/fuigo-native-update.ts": "192cdff0a8c1b4d3d1dfb73a04e33d9fd56d5f4dc0887bf15f4dc18dd8d4c4bf",
  "server/engine-management.ts": "cf4fd35fe308797b2b065fb6bd3ba4bc1394068fb7cf4f48df8a31135b4ebdb8",
  "server/codex-managed-windows.ts": "aa340dddb20ae6356bc4182a75c540eb8b03ce6a257ce2775110c99349ac2d35",
};
const fixedFetch = async (input, init) => {
  const url = String(input);
  if (url === "https://registry.npmjs.org/fuigo/latest") return Response.json({ name: "fuigo", version });
  const requestedVersion = Object.keys(pins).find(value => url === `https://registry.npmjs.org/%40fuigo%2Fdarwin-x64/${value}` || url === `https://registry.npmjs.org/@fuigo/darwin-x64/-/darwin-x64-${value}.tgz`);
  assert.ok(requestedVersion, "Only fixed official Intel package requests are allowed");
  result.downloads.push(url);
  const response = await fetch(url, init);
  assert.equal(response.status, 200);
  // Production still validates exact metadata identity and SHA512. This fixture
  // additionally enforces the previously reviewed archive and executable pins.
  if (!url.endsWith(".tgz")) return response;
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; assert(size <= 64 * 1024 * 1024, "Native archive exceeds bound"); chunks.push(Buffer.from(value)); }
  } catch (error) { await reader.cancel(); throw error; }
  finally { reader.releaseLock(); }
  const archive = Buffer.concat(chunks, size), pin = pins[requestedVersion];
  assert.equal(createHash("sha256").update(archive).digest("hex"), pin.tarballSha256);
  assert.equal(createHash("sha256").update(nativeFuigoPackage(archive, "darwin-x64", requestedVersion)).digest("hex"), pin.binarySha256);
  return new Response(new Uint8Array(archive));
};
try {
  for (const [path, expected] of Object.entries(productionHashes)) assert.equal(await hash(new URL(`../${path}`, import.meta.url)), expected, `Production source differs: ${path}`);
  result.productionHashes = productionHashes;
  const seed = await stageNativeFuigo({ root, id: "intel-bundled-seed", version: "1.0.10", target: result.target, fetcher: fixedFetch });
  assert.equal(await hash(seed), pins["1.0.10"].binarySha256);
  assert.equal(nativeFuigoTarget(await readFile(seed)), result.target);
  const bundle = join(root, "bundle"); await mkdir(bundle);
  const bundledCli = join(bundle, "fuigo"); await copyFile(seed, bundledCli);
  const initial = await probeNativeFuigo(bundledCli, "1.0.10", root);
  assert.deepEqual(initial, { version: "1.0.10", protocolVersion: 1, loadSession: true, sessionCreated: true });
  result.steps.push({ action: "production-probe", proof: initial });
  const instance = { instanceId: "fuigo", driverKind: "fuigo", bundledCli, defaultSource: "bundled", snapshot: { state: "available", version: "1.0.10" } };
  const activations = [];
  const manager = new EngineManager({ root, getInstance: async () => instance, isBusy: () => false, fetch: fixedFetch,
    activate: async (_id, cli, expectedCli) => {
      assert.equal(instance.cli ?? null, expectedCli);
      await writeFile(join(root, "selected-config.json"), JSON.stringify({ cli }), { mode: 0o600 });
      instance.cli = cli;
      instance.snapshot.version = (await managedFuigoReceipt(root, "fuigo", cli))?.version ?? "1.0.10";
      activations.push({ cli, expectedCli, version: instance.snapshot.version });
      assert.equal(JSON.parse(await readFile(join(root, "selected-config.json"), "utf8")).cli, cli);
    },
  });
  await manager.install("fuigo"); const first = instance.cli; const firstHash = await hash(first);
  const receiptA = await managedFuigoReceipt(root, "fuigo", first); assert.equal(receiptA.version, "1.0.9");
  result.steps.push({ action: "install-A", receipt: receiptA });
  version = "1.0.10"; await manager.install("fuigo"); const second = instance.cli; const secondHash = await hash(second);
  const receiptB = await managedFuigoReceipt(root, "fuigo", second);
  assert.equal(receiptB.version, "1.0.10"); assert.equal(receiptB.previousManagedCli, first);
  assert.notEqual(first, second); assert.equal((await manager.status("fuigo")).rollbackAvailable, true);
  result.steps.push({ action: "update-B", receipt: receiptB });
  await manager.rollback("fuigo"); assert.equal(instance.cli, first);
  result.steps.push({ action: "rollback-A", selectedVersion: instance.snapshot.version });
  await manager.useBundled("fuigo"); assert.equal(instance.cli, bundledCli);
  assert.equal((await manager.status("fuigo")).source, "bundled");
  result.steps.push({ action: "use-bundled", selectedVersion: instance.snapshot.version });
  assert.equal(await hash(first), firstHash); assert.equal(await hash(second), secondHash);
  assert.equal(await hash(bundledCli), pins["1.0.10"].binarySha256); assert.equal(await hash(seed), pins["1.0.10"].binarySha256);
  assert.equal((await readdir(root)).some(name => name.startsWith("probe-") || name.startsWith("fuigo-bundle-probe-")), false);
  Object.assign(result, { status: "passed", activations, preservedHashes: { first: firstHash, second: secondHash, bundled: pins["1.0.10"].binarySha256 },
    processAndListenerCleanup: "Every production probe returned after confirmed child close and listener close; no probe scratch remains" });
  await rm(root, { recursive: true, force: true }); result.cleaned = true;
} catch (error) {
  Object.assign(result, { status: "failed", error: error.message, code: error.code ?? null, probeMethod: error.probeMethod ?? null, rpcCode: error.rpcCode ?? null, cleaned: false });
  process.exitCode = 1;
}
result.finishedAt = new Date().toISOString();
await mkdir(new URL("./0150-intel-native/", import.meta.url), { recursive: true });
await writeFile(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
