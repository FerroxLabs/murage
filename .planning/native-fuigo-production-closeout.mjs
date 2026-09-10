import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineManager } from "../server/engine-management.ts";
import { managedFuigoReceipt, nativeFuigoTarget, probeNativeFuigo } from "../server/fuigo-native-update.ts";

// A distinct native proof from the earlier custom synthetic-probe receipt.
// The manager uses its unchanged DEFAULT production probe for every action.
assert.equal(process.platform, "darwin"); assert.equal(process.arch, "arm64");
const prior = JSON.parse(await readFile(new URL("../../swarm-0149-fuigo-update/.planning/native-mac-synthetic-approved-closeout.json", import.meta.url), "utf8"));
const root = await mkdtemp(join(tmpdir(), "murage-fuigo-production-closeout-"));
const output = new URL("./updater-closeout-native-r1.json", import.meta.url);
const hash = async path => createHash("sha256").update(await readFile(path)).digest("hex");
const result = { startedAt: new Date().toISOString(), target: `${process.platform}-${process.arch}`, node: process.version, root,
  sourceCandidate: "ca190343", native: true, probe: "production probeNativeFuigo, no injected FuigoProbe",
  activation: "isolated persisted selection callback; owner HTTP callback proved separately",
  noOwnerCredentials: true, noPrompt: true, previousReceiptsPreserved: true, steps: [], downloads: [] };
let version = "1.0.9";
const pins = {
  "1.0.9": "sha512-BS7PaxvSTdinONPHjFyaZmGReNf4QL+Nkn/tzOBsEFZr1IcUU7Ya05TgxfsZoDDLQ5wbAcjS+VMovCAmUSlZLA==",
  "1.0.10": "sha512-fFXj9lixzvd+E6Cq4DB/LGng8Bersc0xamoBQ6WMAcUmQtbZ1SQrzsRXuuxAmPV0xGm4nYy1ehr5Jn9QXtuIUw==",
};
const fixedFetch = async (input, init) => {
  const url = String(input);
  if (url === "https://registry.npmjs.org/fuigo/latest") return Response.json({ name: "fuigo", version });
  const metadataUrl = `https://registry.npmjs.org/%40fuigo%2Fdarwin-arm64/${version}`;
  const tarball = `https://registry.npmjs.org/@fuigo/darwin-arm64/-/darwin-arm64-${version}.tgz`;
  assert.ok(url === metadataUrl || url === tarball, "Only fixed official native package requests are allowed");
  result.downloads.push(url);
  const response = await fetch(url, init);
  if (url === metadataUrl) {
    assert.equal(response.status, 200);
    const metadata = await response.json(); assert.equal(metadata.dist.integrity, pins[version]);
    return Response.json(metadata);
  }
  return response;
};
try {
  assert.equal(await hash(prior.binaryRetained), prior.binarySha256);
  assert.equal(nativeFuigoTarget(await readFile(prior.binaryRetained)), result.target);
  const bundle = join(root, "bundle"); await mkdir(bundle);
  const bundledCli = join(bundle, "fuigo"); await copyFile(prior.binaryRetained, bundledCli);
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
  assert.equal(await hash(bundledCli), prior.binarySha256); assert.equal(await hash(prior.binaryRetained), prior.binarySha256);
  assert.equal((await readdir(root)).some(name => name.startsWith("probe-") || name.startsWith("fuigo-bundle-probe-")), false);
  Object.assign(result, { status: "passed", activations, preservedHashes: { first: firstHash, second: secondHash, bundled: prior.binarySha256 },
    processAndListenerCleanup: "Every production probe returned after confirmed child close and listener close; no probe scratch remains" });
  await rm(root, { recursive: true, force: true }); result.cleaned = true;
} catch (error) {
  Object.assign(result, { status: "failed", error: error.message, code: error.code ?? null, probeMethod: error.probeMethod ?? null, rpcCode: error.rpcCode ?? null, cleaned: false });
  process.exitCode = 1;
}
result.finishedAt = new Date().toISOString();
await writeFile(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
