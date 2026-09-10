import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineManager } from "../server/engine-management.ts";
import { managedFuigoReceipt, nativeFuigoPackage, nativeFuigoTarget, probeNativeFuigo, stageNativeFuigo } from "../server/fuigo-native-update.ts";

// A distinct native proof from the earlier custom synthetic-probe receipt.
// The manager uses its unchanged DEFAULT production probe for every action.
assert.equal(process.platform, "linux"); assert.equal(process.arch, "x64");
assert.equal(process.versions.node, "24.20.0");
const root = await mkdtemp(join(tmpdir(), "murage-fuigo-production-closeout-"));
const output = new URL("./0150-linux-manager-native/linux-x64.json", import.meta.url);
const hash = async path => createHash("sha256").update(await readFile(path)).digest("hex");
const result = { startedAt: new Date().toISOString(), target: `${process.platform}-${process.arch}`, node: process.version, root,
  sourceCandidate: "f320e846fe4ad49a277f7b8a14c361cce8d51e32", managerCorrection: "4dc37b2190940f1bbec1f6724637964d8031468a", fixtureCommit: process.env.GITHUB_SHA ?? null,
  runId: process.env.GITHUB_RUN_ID ?? null, runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  native: true, reusedIsolationReceipt: "34461913135", reusedResourceReceipt: "34462873619", probe: "production probeNativeFuigo, no injected FuigoProbe",
  activation: "isolated persisted selection callback; owner HTTP callback proved separately",
  noOwnerCredentials: true, noPrompt: true, previousReceiptsPreserved: true, steps: [], downloads: [] };
let version = "1.0.9";
const pins = {
  "1.0.9": { tarballSha256: "9c3a4469be4d1dfc34d00b563d8d25a585281bed50cdbd363a44150250c9359b", binarySha256: "9a4625bb7b41308156e06bc6dcc495e0ea86b054e7511762c2416bc8e0c8ac9a" },
  "1.0.10": { tarballSha256: "fb3c400d47938f69852832b39a6c49f1fd845f9d505202071db2197953576678", binarySha256: "f3d0806e7f30446c85921dcc388725cbc951f74c9de8b706f9db135ef6ba51db" },
};
const productionHashes = {
  "server/fuigo-probe-isolation.ts": "66a35b344a1b0d270a61ce644330d6d7a13da6d67a0da61726e0d118c459bea3",
  "native/fuigo-probe/launcher.c": "78b523456e19f832ff8cd3dde3afbccd0581d7693012d596f041882ca80b119b",
  "scripts/build-fuigo-probe.mjs": "23427074d24acf3974410bbe698fd926d76b730ecb81cb70ab5a5d81657478c2",
  "server/fuigo-native-update.ts": "d4cfb21439d7bb32faa46ca2e5e4d97ae23307947894da9c7744fdb556209415",
  "server/engine-management.ts": "810b00bd1fcb99c0c89565b88200cbc6d2e29e02330c213c5d81bfbbe0ece8a9",
  "server/codex-managed-windows.ts": "aa340dddb20ae6356bc4182a75c540eb8b03ce6a257ce2775110c99349ac2d35",
};
const fixedFetch = async (input, init) => {
  const url = String(input);
  if (url === "https://registry.npmjs.org/fuigo/latest") return Response.json({ name: "fuigo", version });
  const requestedVersion = Object.keys(pins).find(value => url === `https://registry.npmjs.org/%40fuigo%2Flinux-x64/${value}` || url === `https://registry.npmjs.org/@fuigo/linux-x64/-/linux-x64-${value}.tgz`);
  assert.ok(requestedVersion, "Only fixed official Linux package requests are allowed");
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
  assert.equal(createHash("sha256").update(nativeFuigoPackage(archive, "linux-x64", requestedVersion)).digest("hex"), pin.binarySha256);
  return new Response(new Uint8Array(archive));
};
try {
  for (const [path, expected] of Object.entries(productionHashes)) assert.equal(await hash(new URL(`../${path}`, import.meta.url)), expected, `Production source differs: ${path}`);
  result.productionHashes = productionHashes;
  const helper = new URL("../dist-native/fuigo-probe/linux-x64/launcher", import.meta.url);
  const helperManifest = JSON.parse(await readFile(new URL("./manifest.json", helper), "utf8"));
  assert.equal(helperManifest.target, "linux-x64"); assert.equal(helperManifest.executable, "launcher");
  assert.equal(await hash(helper), helperManifest.binarySha256);
  assert.equal(nativeFuigoTarget(await readFile(helper)), "linux-x64");
  result.helper = helperManifest;
  const seed = await stageNativeFuigo({ root, id: "linux-bundled-seed", version: "1.0.10", target: result.target, fetcher: fixedFetch });
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
  assert.equal((await manager.status("fuigo")).supported, true);
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
await mkdir(new URL("./0150-linux-manager-native/", import.meta.url), { recursive: true });
await writeFile(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));

