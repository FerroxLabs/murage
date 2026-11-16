// Driver graph/tests owner: win-sac-sign; controller coverage and real Windows witness owner: MAIN.
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../server/testing/cleanup.ts";
import { spawnSync } from "node:child_process";
import { beginWindowsSigningSession } from "./windows-signing-session.mjs";
import { appendPeFixtureCertificate } from "./fixtures/windows-pe-signing.mjs";
import { peSha256, signPinnedWindowsPe } from "./windows-pe-signing.mjs";
import * as receipts from "./windows-signing-receipt.mjs";
import { receiptFixture } from "./fixtures/windows-signing-receipt.mjs";
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });
function fixture() {
  const f = receiptFixture(roots), { identity, authority } = f.configuration;
  const file = path.join(f.root, "signing-coverage.json");
  const data = { schema: 1, identity, files: [...f.coverage, { scope: "app", path: "vendor.dll", producerRequired: false }] };
  const run = { ...identity, launchSha256: authority.staticLaunchSha256, sha256: authority.runAuthorizationSha256, artifactId: authority.inputArtifactId,
    outerSha256: authority.inputArtifactDigest, planSha256: authority.buildPlanSha256, files: [] };
  const launch = { schema: 2, runRoot: f.root, runAuthorization: run, providerReceiptSha256: authority.providerReceiptSha256,
    signingAuthority: { enrolled: true, executables: { checker: { sha256: authority.checkerSha256 } },
      trees: [{ component: "builder", files: [{ relativePath: "builder.js", sha256: "d".repeat(64) }] }] } };
  const plan = { ...identity, sha256: authority.buildPlanSha256,
    outputs: f.coverage.filter(row => row.producerRequired).map(row => ({ path: row.path, component: row.scope === "app" ? "murage-app" : row.scope })) };
  const save = () => { fs.writeFileSync(file, JSON.stringify(data)); run.files = [{ path: "signing-coverage.json", sha256: peSha256(fs.readFileSync(file)) }]; };
  save(); return { ...f, file, data, launch, plan, save, create: async () => receipts.windowsSigningDriverReceipt(launch, authority.staticLaunchSha256, plan) };
}
it("creates the real operation graph from controller-authenticated coverage and rejects early packaging before work", async () => {
  const f = fixture(), graph = await f.create(), build = vi.fn();
  await expect(graph.package("app", build)).rejects.toThrow("WINDOWS_SIGNING_RECEIPT_REJECTED");
  expect(build).not.toHaveBeenCalled();
});
it("cannot claim driver completion without a committed complete receipt", async () => {
  const f = fixture(), graph = await f.create();
  expect(() => graph.assertComplete()).toThrow("WINDOWS_SIGNING_RECEIPT_REJECTED");
  await f.build(); await f.complete(); expect(() => f.writer.assertComplete()).not.toThrow();
});
const changes = [
  ["wrong launch schema", f => { f.launch.schema = 1; }],
  ["different plan identity", f => { f.plan.runAttempt = "2"; }],
  ["relative run root", f => { f.launch.runRoot = path.relative(process.cwd(), f.root); }],
  ["different static launch", f => { f.launch.runAuthorization.launchSha256 = "d".repeat(64); }],
  ["missing coverage", f => { f.launch.runAuthorization.files = []; }],
  ["coverage changed after authorization", f => { fs.appendFileSync(f.file, " "); }],
  ["different coverage identity", f => { f.data.identity = { ...f.data.identity, runAttempt: "2" }; f.save(); }],
  ["wrong coverage schema", f => { f.data.schema = 2; f.save(); }],
  ["extra coverage field", f => { f.data.allowed = true; f.save(); }],
  ["unenrolled authority", f => { f.launch.signingAuthority.enrolled = false; }],
  ["wrong plan digest", f => { f.plan.sha256 = "d".repeat(64); }],
  ["missing builder tree", f => { f.launch.signingAuthority.trees = []; }],
  ["omitted planned producer", f => { f.data.files = f.data.files.filter(row => row.path !== "Murage.exe"); f.save(); }],
  ["producer gate disabled", f => { f.data.files.find(row => row.path === "Murage.exe").producerRequired = false; f.save(); }],
  ["producer in wrong scope", f => { f.data.files.find(row => row.path === "Murage.exe").scope = "gepa"; f.save(); }],
];
it.each(changes)("rejects %s before returning a production operation graph", async (_name, change) => {
  const f = fixture(); change(f); await expect(f.create()).rejects.toThrow("WINDOWS_SIGNING_RECEIPT_REJECTED");
});

it("the production driver passes one real graph to both receipt consumers and rejects packaging before GEPA freeze", () => {
  const f = fixture();
  const result = spawnSync(process.execPath, ["scripts/fixtures/windows-builder-config.mjs", path.join(f.root, "driver"), "graph"],
    { encoding: "utf8", timeout: 30_000, env: { NODE_OPTIONS: "", PATH: "" } });
  expect(result.status, result.stderr + result.stdout).toBe(0);
  const counts = JSON.parse(result.stdout.trim().split("\n").at(-1));
  expect(counts.graphRegistrations).toBe(1); expect(counts.graphConsumers).toBe(1); expect(counts.buildRuns).toBe(0);
});
it.each(["signed", "preserved"])("records the actual common PE %s operation in the active driver graph", async disposition => {
  const f = receiptFixture(roots);
  if (disposition === "preserved") {
    const original = f.file("gepa"); fs.mkdirSync(path.dirname(original), { recursive: true });
  }
  await f.produce("gepa");
  if (disposition === "preserved") {
    fs.writeFileSync(f.file("gepa"), appendPeFixtureCertificate(fs.readFileSync(f.file("gepa"))));
    f.pins.get("gepa").sourceSha256 = peSha256(fs.readFileSync(f.file("gepa")));
  }
  const sign = vi.fn(async file => { fs.writeFileSync(file, appendPeFixtureCertificate(fs.readFileSync(file))); return true; });
  const end = beginWindowsSigningSession({ sign, graph: f.writer });
  try {
    const record = await signPinnedWindowsPe(f.file("gepa"), f.pins.get("gepa"), f.trust, sign);
    expect(record.disposition).toBe(disposition); expect(sign).toHaveBeenCalledTimes(disposition === "signed" ? 1 : 0);
    f.records.set("gepa", record); await f.freeze("gepa");
  } finally { end(); }
  await f.writer.package("app", async () => {
    await f.prepare("app"); await f.prepare("uninstaller"); await f.prepare("transient");
    await f.writer.package("installer", async () => f.prepare("installer"));
  });
  await f.writer.packageComplete(async () => {}); const { receipt } = await f.complete();
  expect(receipt.events.find(row => row.path === f.coverage[0].path)?.event).toBe(disposition === "signed" ? "sign" : "preserve");
});
it("refuses a common signing operation in the wrong phase before provider execution", async () => {
  const f = receiptFixture(roots); await f.produce("gepa"); await f.sign("gepa"); await f.freeze("gepa");
  const sign = vi.fn(), end = beginWindowsSigningSession({ sign, graph: f.writer });
  try { await expect(signPinnedWindowsPe(f.file("gepa"), f.pins.get("gepa"), f.trust, sign)).rejects.toThrow("WINDOWS_SIGNING_RECEIPT_REJECTED"); }
  finally { end(); }
  expect(sign).not.toHaveBeenCalled();
});
it("the production driver commits its real complete graph through package finalization and authenticated extraction", () => {
  const f = fixture();
  const result = spawnSync(process.execPath, ["scripts/fixtures/windows-builder-config.mjs", path.join(f.root, "driver"), "complete"],
    { encoding: "utf8", timeout: 30_000, env: { NODE_OPTIONS: "", PATH: "" } });
  expect(result.status, result.stderr + result.stdout).toBe(0);
  const counts = JSON.parse(result.stdout.trim().split("\n").at(-1));
  expect(counts.graphRegistrations).toBe(1); expect(counts.graphConsumers).toBe(1); expect(counts.buildRuns).toBe(1);
  expect(counts.providerRuns).toBe(4); expect(counts.credentialLeaks).toBe(0);
  const receipt = JSON.parse(fs.readFileSync(path.join(f.root, "driver/driver-receipt.json")));
  expect(receipt.complete).toBe(true); expect(receipt.events.at(-1).event).toBe("verify");
  expect(receipt.result.extractionResultSha256).toMatch(/^[a-f0-9]{64}$/);
});
