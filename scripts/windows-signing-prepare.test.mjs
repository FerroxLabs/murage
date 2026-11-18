// Preparation tests owner: win-sac-sign; Windows compiler/acquisition witness owner: MAIN.
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { removeTempDirSync } from "../server/testing/cleanup.ts";
import { buildProducerFixture } from "./fixtures/windows-build-producer.mjs";
import { peSha256 } from "./windows-pe-signing.mjs";
import { prepareWindowsBuildProducers, prepareWindowsSigning } from "./windows-signing-prepare.mjs";
import { registerWindowsBuildProducers } from "./windows-build-producers.mjs";
import { readWindowsBuildPlan, windowsStageReceiptConsumer } from "./windows-stage-receipts.mjs";
import { unsignedPeFixture } from "./fixtures/windows-pe-signing.mjs";
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });
async function fixture() {
  const f = await buildProducerFixture(roots);
  f.options = { root: f.root, toolFiles: f.options.toolFiles, invocations: [{ path: f.output.path, invocation: f.invocation }], env: {} };
  return f;
}
it("runs the real preparation entry through the command boundary and imports only its completed receipts", async () => {
  const f = await fixture();
  // Exercise the exported preparation boundary with a fake compiler, then the
  // production import/consumer path with the exact returned receipt digests.
  const prepared = await prepareWindowsBuildProducers(f.plan, f.options, f);
  expect(f.run).toHaveBeenCalledOnce();
  const producers = await registerWindowsBuildProducers(f.plan, { directory: path.join(f.root, "signing-receipts"), toolFiles: f.options.toolFiles, prepared });
  const consumer = windowsStageReceiptConsumer(f.plan, producers);
  expect((await consumer.consume(f.output.path, f.output.stage)).sourceSha256).toBe(peSha256(fs.readFileSync(f.destination)));
  consumer.assertComplete();
});
it("executes the authenticated recipe with a real credential-free child process", async () => {
  const f = await fixture(), toolSha256 = peSha256(fs.readFileSync(process.execPath));
  const output = { ...f.output, tools: [{ component: "node", sha256: toolSha256 }] };
  const planFile = path.join(f.root, "plan.json"), recipeFile = path.join(f.root, "preparation.json");
  fs.writeFileSync(planFile, JSON.stringify({ ...f.plan, outputs: [output] }));
  const invocation = { ...f.invocation, command: process.execPath, tools: [{ component: "node", file: process.execPath }],
    args: ["-e", "if(Object.keys(process.env).some(k=>/AZURE_|NODE_OPTIONS|GITHUB_/i.test(k)))process.exit(9);require('node:fs').writeFileSync(process.argv[1],Buffer.from(process.argv[2],'base64'));", f.destination, unsignedPeFixture().toString("base64")] };
  const recipe = { schema: 1, ...f.options, identity: f.plan, toolFiles: [{ path: process.execPath, sha256: toolSha256 }],
    plan: { file: planFile, sha256: peSha256(fs.readFileSync(planFile)) }, invocations: [{ path: output.path, invocation }] };
  fs.writeFileSync(recipeFile, JSON.stringify(recipe));
  const expected = peSha256(fs.readFileSync(recipeFile));
  await expect(prepareWindowsSigning(recipeFile, "0".repeat(64), {})).rejects.toThrow("WINDOWS_SIGNING_PREPARATION_REJECTED");
  expect(fs.existsSync(f.destination)).toBe(false);
  expect(await prepareWindowsSigning(recipeFile, expected, {})).toHaveLength(1);
  expect(fs.readFileSync(f.destination)).toEqual(unsignedPeFixture());
});
it.each(["credentials", "unknown output", "duplicate invocation", "missing invocation", "late output"])("refuses preparation with %s before a compiler starts", async mode => {
  const f = await fixture();
  if (mode === "credentials") f.options.env = { AZURE_CLIENT_SECRET: "fixture" };
  if (mode === "unknown output") f.options.invocations[0].path = "undeclared.exe";
  if (mode === "duplicate invocation") f.options.invocations.push(f.options.invocations[0]);
  if (mode === "missing invocation") f.options.invocations = [];
  if (mode === "late output") f.plan = { ...f.plan, outputs: [{ ...f.output, component: "installer" }] };
  await expect(prepareWindowsBuildProducers(f.plan, f.options, f)).rejects.toThrow("WINDOWS_SIGNING_PREPARATION_REJECTED");
  expect(f.run).not.toHaveBeenCalled();
});
it("does not report completed preparation after a compiler fails", async () => {
  const f = await fixture(); f.run.mockRejectedValue(Error("fixture compiler failure"));
  await expect(prepareWindowsBuildProducers(f.plan, f.options, f)).rejects.toThrow("fixture compiler failure");
  expect(fs.readdirSync(path.join(f.root, "producer-receipts"))).toEqual([]);
});
it("prepares the raw-input stages of the full schema-3 graph without changing its parent digest or late inputs",async()=>{
  const f=await fixture(),late={...f.output,path:"Murage.exe",component:"murage-app",producer:"electron-resource-edit",stage:"resource-edited",
    transformations:["resource-edit"],inputs:[{component:"gepa",fromEvent:{scope:"gepa",path:"resources/gepa-worker/gepa-worker.exe",event:"freeze"}}]};
  const file=path.join(f.root,"full-plan.json");fs.writeFileSync(file,JSON.stringify({...f.plan,schema:3,outputs:[f.output,late]}));
  const plan=await readWindowsBuildPlan(file,peSha256(fs.readFileSync(file)),f.plan);
  const prepared=await prepareWindowsBuildProducers(plan,f.options,f),receipt=JSON.parse(fs.readFileSync(prepared[0].file));
  expect(receipt.parentPlanSha256).toBe(plan.sha256);expect(receipt.predecessors).toEqual([]);
  const producers=await registerWindowsBuildProducers(plan,{directory:path.join(f.root,"signing-receipts"),toolFiles:f.options.toolFiles,prepared});
  const consumer=windowsStageReceiptConsumer(plan,producers);
  expect((await consumer.consume(f.output.path,f.output.stage)).sourceSha256).toBe(peSha256(fs.readFileSync(f.destination)));
  expect(()=>consumer.assertComplete()).toThrow("WINDOWS_BUILD_RECEIPTS_INCOMPLETE");
  await expect(consumer.consume("Murage.exe","resource-edited")).rejects.toThrow();
});
