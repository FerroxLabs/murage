import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../server/testing/cleanup.ts";
import { peSha256 } from "./windows-pe-signing.mjs";
import { readWindowsBuildPlan, windowsStageReceiptConsumer } from "./windows-stage-receipts.mjs";
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stage-receipts-")); roots.push(root);
  const identity = { target: "win32-x64", sourceRevision: "a".repeat(40), version: "1.0.19", runId: "fixture-run", runAttempt: "1" };
  const output = { path: "Murage.exe", component: "murage-app", stage: "resource-edited", producer: "builder-resource-editor",
    inputs: [{ component: "electron", sha256: "b".repeat(64) }], tools: [{ component: "resource-editor", sha256: "c".repeat(64) }],
    transformations: ["resource-edit"], publishers: ["Ferrox Labs, LLC"] };
  const data = { schema: 2, ...identity, outputs: [output] }, file = path.join(root, "plan.json");
  fs.writeFileSync(file, JSON.stringify(data));
  const expected = peSha256(fs.readFileSync(file)), plan = await readWindowsBuildPlan(file, expected, identity);
  const receipt = { schema: 2, ...identity, planSha256: expected, path: output.path, stage: output.stage, producer: output.producer,
    preSignSha256: "d".repeat(64), inputs: output.inputs, tools: output.tools, transformations: output.transformations };
  const receiptFile = path.join(root, "receipt.json");
  const select = () => { fs.writeFileSync(receiptFile, JSON.stringify(receipt)); return { file: receiptFile, sha256: peSha256(fs.readFileSync(receiptFile)) }; };
  const producer = vi.fn(async () => select());
  const producers = new Map([[output.producer, producer]]);
  return { root, identity, output, data, file, expected, plan, receipt, receiptFile, producer, producers, select };
}
it("accepts only a registered stage producer and retains its revision, tool and exact pre-sign pin", async () => {
  const f = await fixture(), consumer = windowsStageReceiptConsumer(f.plan, f.producers);
  expect(() => consumer.assertComplete()).toThrow("WINDOWS_BUILD_RECEIPTS_INCOMPLETE");
  const pin = await consumer.consume("Murage.exe", "resource-edited");
  expect(pin.sourceSha256).toBe(f.receipt.preSignSha256); expect(pin.sourceRevision).toBe(f.identity.sourceRevision);
  expect(pin.sourceReceiptSha256).toBe(f.select().sha256); expect(pin.inputs).toEqual(f.output.inputs);
  expect(f.producer).toHaveBeenCalledWith({ path: "Murage.exe", stage: "resource-edited", planSha256: f.expected });
  consumer.assertComplete(); await expect(consumer.consume("Murage.exe", "resource-edited")).rejects.toThrow("WINDOWS_BUILD_RECEIPT_STAGE_INVALID");
  expect(f.producer).toHaveBeenCalledOnce();
});
it.each(["sourceRevision", "target", "version", "runId"])("rejects a plan from another %s", async field => {
  const f = await fixture();
  await expect(readWindowsBuildPlan(f.file, f.expected, { ...f.identity, [field]: "different" })).rejects.toThrow();
});
it.each(["path", "stage", "producer", "sourceRevision", "target", "version", "runId", "planSha256", "preSignSha256", "inputs", "tools", "transformations"])("rejects substituted receipt %s without admitting a source pin", async field => {
  const f = await fixture(), consumer = windowsStageReceiptConsumer(f.plan, f.producers);
  f.receipt[field] = "substituted";
  await expect(consumer.consume("Murage.exe", "resource-edited")).rejects.toThrow("WINDOWS_BUILD_RECEIPT_IDENTITY_INVALID");
  expect(() => consumer.assertComplete()).toThrow("WINDOWS_BUILD_RECEIPTS_INCOMPLETE");
});
it("rejects wrong stage/undeclared path before producer invocation and rejects missing producer registration", async () => {
  const f = await fixture(), consumer = windowsStageReceiptConsumer(f.plan, f.producers);
  await expect(consumer.consume("Murage.exe", "copied")).rejects.toThrow("WINDOWS_BUILD_RECEIPT_STAGE_INVALID");
  await expect(consumer.consume("resources/unknown.dll", "resource-edited")).rejects.toThrow("WINDOWS_BUILD_RECEIPT_STAGE_INVALID");
  expect(f.producer).not.toHaveBeenCalled(); expect(() => windowsStageReceiptConsumer(f.plan, new Map())).toThrow("WINDOWS_BUILD_PRODUCER_REQUIRED");
});
it("rejects changed plan/receipt hashes and arbitrary scan-produced source hashes in a declared-output plan", async () => {
  const f = await fixture();
  await expect(readWindowsBuildPlan(f.file, "0".repeat(64), f.identity)).rejects.toThrow("WINDOWS_BUILD_PLAN_HASH_MISMATCH");
  f.data.outputs[0].sourceSha256 = "d".repeat(64); fs.writeFileSync(f.file, JSON.stringify(f.data));
  await expect(readWindowsBuildPlan(f.file, peSha256(fs.readFileSync(f.file)), f.identity)).rejects.toThrow("WINDOWS_BUILD_PLAN_OUTPUT_INVALID");
  const selected = f.select(); fs.appendFileSync(f.receiptFile, " "); f.producer.mockResolvedValue(selected);
  await expect(windowsStageReceiptConsumer(f.plan, f.producers).consume("Murage.exe", "resource-edited")).rejects.toThrow("WINDOWS_BUILD_RECEIPT_HASH_MISMATCH");
});
it("rejects duplicate output declarations and upstream components disguised as local producer outputs", async () => {
  const f = await fixture();
  for (const outputs of [[f.output, f.output], [{ ...f.output, path: "resources/vendor.dll" }]]) {
    fs.writeFileSync(f.file, JSON.stringify({ ...f.data, outputs }));
    await expect(readWindowsBuildPlan(f.file, peSha256(fs.readFileSync(f.file)), f.identity)).rejects.toThrow("WINDOWS_BUILD_PLAN_OUTPUT_INVALID");
  }
});
