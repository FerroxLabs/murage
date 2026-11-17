// Production producer fixtures owner: win-sac-sign; real Windows tool/image witness owner: MAIN.
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../server/testing/cleanup.ts";
import { peSha256 } from "./windows-pe-signing.mjs";
import { windowsStageReceiptConsumer } from "./windows-stage-receipts.mjs";
import { registerWindowsBuildProducers, runWindowsBuildProducer } from "./windows-build-producers.mjs";
import { unsignedPeFixture } from "./fixtures/windows-pe-signing.mjs";

import { buildProducerFixture as producerFixture } from "./fixtures/windows-build-producer.mjs";

const roots = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) removeTempDirSync(root); });
const buildProducerFixture = () => producerFixture(roots);

it("retrieves only a completed compiler receipt, with exact invocation evidence, through the existing consumer", async () => {
  const f = await buildProducerFixture(), producers = await registerWindowsBuildProducers(f.plan, f.options);
  const consumer = windowsStageReceiptConsumer(f.plan, producers);
  await expect(producers.get(f.output.producer)({ path: f.output.path, stage: f.output.stage, planSha256: f.plan.sha256 })).rejects.toThrow("WINDOWS_BUILD_PRODUCER_REJECTED");
  await runWindowsBuildProducer(producers, f.output.path, f.invocation, f);
  expect(f.run).toHaveBeenCalledWith(f.tool, f.invocation.args, { cwd: f.root, env: { FIXTURE: "1" }, shell: false, windowsHide: true, timeout: 300_000, maxBuffer: 1024 * 1024 });
  const pin = await consumer.consume(f.output.path, f.output.stage);
  expect(pin.sourceSha256).toBe(peSha256(fs.readFileSync(f.destination))); consumer.assertComplete();
  const selected = await producers.get(f.output.producer)({ path: f.output.path, stage: f.output.stage, planSha256: f.plan.sha256 });
  const receipt = JSON.parse(fs.readFileSync(selected.file));
  const evidence = fs.readFileSync(`${selected.file}.invocation.json`, "utf8");
  expect(receipt.invocationSha256).toBe(peSha256(evidence.trimEnd()));
  expect(JSON.parse(evidence)).toMatchObject({ command: f.tool, args: f.invocation.args, exitCode: 0, path: f.output.path });
});

export const producerInvocationViolations = [
  ["relative output", f => { f.invocation.output = "relative.node"; }],
  ["relative command", f => { f.invocation.command = "compiler"; }],
  ["relative cwd", f => { f.invocation.cwd = "."; }],
  ["missing args", f => { delete f.invocation.args; }],
  ["nonstring argument", f => { f.invocation.args = [1]; }],
  ["NUL argument", f => { f.invocation.args = ["invalid\0arg"]; }],
  ["missing environment", f => { delete f.invocation.env; }],
  ["array environment", f => { f.invocation.env = []; }],
  ["nonstring environment", f => { f.invocation.env = { FIXTURE: 1 }; }],
  ...["AZURE_CLIENT_SECRET", "azure_client_id", "NODE_OPTIONS", "GITHUB_ENV", "CSC_LINK", "WIN_CSC_KEY_PASSWORD"].map(key => [key, f => { f.invocation.env[key] = "fixture"; }]),
  ["command differs from tool", f => { f.invocation.command = path.join(f.root, "other-compiler"); }],
  ["not enrolled tool", f => { f.options.toolFiles[0].path = path.join(f.root, "other-compiler"); }],
  ["wrong enrolled tool hash", f => { f.options.toolFiles[0].sha256 = "c".repeat(64); }],
  ["input omitted", f => { f.invocation.inputs = []; }],
  ["input component", f => { f.invocation.inputs[0].component = "different"; }],
  ["relative input", f => { f.invocation.inputs[0].file = "source.c"; }],
  ["changed input", f => { fs.appendFileSync(f.input, "changed"); }],
  ["changed tool", f => { fs.appendFileSync(f.tool, "changed"); }],
  ["old output", f => { fs.writeFileSync(f.destination, unsignedPeFixture()); }],
  ["linked input", f => { const link = path.join(f.root, "input-link"); fs.symlinkSync(f.input, link); f.invocation.inputs[0].file = link; }],
];
it.each(producerInvocationViolations)("rejects %s before compiler launch and revokes the registry", async (_name, mutate) => {
  const f = await buildProducerFixture(); mutate(f);
  const producers = await registerWindowsBuildProducers(f.plan, f.options);
  await expect(runWindowsBuildProducer(producers, f.output.path, f.invocation, f)).rejects.toThrow();
  expect(f.run).not.toHaveBeenCalled();
  await expect(producers.get(f.output.producer)({ path: f.output.path, stage: f.output.stage, planSha256: f.plan.sha256 })).rejects.toThrow();
});
it.each(["unknown producer", "relative directory", "old directory", "no enrolled tools"])("rejects registration with %s", async mode => {
  const f = await buildProducerFixture();
  if (mode === "unknown producer") f.plan = { ...f.plan, outputs: [{ ...f.output, producer: "scan-current-files" }] };
  if (mode === "relative directory") f.options.directory = "receipts";
  if (mode === "old directory") fs.mkdirSync(f.options.directory);
  if (mode === "no enrolled tools") f.options.toolFiles = [];
  await expect(registerWindowsBuildProducers(f.plan, f.options)).rejects.toThrow();
});
it.each(["nonzero exit", "compiler stopped after writing", "no output", "linked output", "changed tool", "changed input", "receipt write failure"])("never admits %s as a completed output and forbids retry", async mode => {
  const f = await buildProducerFixture(), producers = await registerWindowsBuildProducers(f.plan, f.options);
  f.run.mockImplementation(async () => {
    if (mode === "nonzero exit") throw Error("fixture compiler failed");
    if (mode === "no output") return;
    if (mode === "linked output") fs.symlinkSync(f.input, f.destination);
    else fs.writeFileSync(f.destination, unsignedPeFixture());
    if (mode === "compiler stopped after writing") throw Error("fixture compiler stopped");
    if (mode === "changed tool") fs.appendFileSync(f.tool, "changed");
    if (mode === "changed input") fs.appendFileSync(f.input, "changed");
    if (mode === "receipt write failure") fs.mkdirSync(path.join(f.options.directory, `${peSha256(f.output.path)}.json`));
  });
  await expect(runWindowsBuildProducer(producers, f.output.path, f.invocation, f)).rejects.toThrow();
  await expect(producers.get(f.output.producer)({ path: f.output.path, stage: f.output.stage, planSha256: f.plan.sha256 })).rejects.toThrow();
  await expect(runWindowsBuildProducer(producers, f.output.path, f.invocation, f)).rejects.toThrow();
  expect(f.run).toHaveBeenCalledOnce();
});
it("rejects reentrant/duplicate execution before launching another process", async () => {
  const f = await buildProducerFixture(), producers = await registerWindowsBuildProducers(f.plan, f.options);
  let release; f.run.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const pending = runWindowsBuildProducer(producers, f.output.path, f.invocation, f);
  await vi.waitFor(() => expect(f.run).toHaveBeenCalledOnce());
  await expect(runWindowsBuildProducer(producers, f.output.path, f.invocation, f)).rejects.toThrow();
  fs.writeFileSync(f.destination, unsignedPeFixture()); release(); await expect(pending).rejects.toThrow();
  await expect(runWindowsBuildProducer(producers, f.output.path, f.invocation, f)).rejects.toThrow();
  expect(f.run).toHaveBeenCalledOnce();
});
it("snapshots command arguments and the enrolled plan before asynchronous launch", async () => {
  const f = await buildProducerFixture(), producers = await registerWindowsBuildProducers(f.plan, f.options);
  const original = [...f.invocation.args];
  const pending = runWindowsBuildProducer(producers, f.output.path, f.invocation, f);
  f.invocation.args[0] = "changed"; f.options.toolFiles[0].sha256 = "c".repeat(64);
  await pending; expect(f.run.mock.calls[0][1]).toEqual(original);
});
it("revokes another producer while its inputs are being measured, before compiler launch", async () => {
  const f = await buildProducerFixture(), producers = await registerWindowsBuildProducers(f.plan, f.options);
  const pending = runWindowsBuildProducer(producers, f.output.path, f.invocation, f);
  await expect(runWindowsBuildProducer(producers, "resources/undeclared.node", f.invocation, f)).rejects.toThrow();
  await expect(pending).rejects.toThrow();
  expect(f.run).not.toHaveBeenCalled(); expect(fs.existsSync(f.destination)).toBe(false);
});
it("records the declared Electron resource edit as an in-place derivation before the sign callback", async () => {
  const f = await buildProducerFixture(); fs.writeFileSync(f.destination, unsignedPeFixture());
  const output = { ...f.output, path: "Murage.exe", component: "murage-app", producer: "electron-resource-edit", stage: "resource-edited",
    inputs: [{ component: "electron", sha256: peSha256(fs.readFileSync(f.destination)) }], transformations: ["resource-edit"] };
  const plan = { ...f.plan, outputs: [output] }, producers = await registerWindowsBuildProducers(plan, f.options);
  const invocation = { ...f.invocation, inputs: [{ component: "electron", file: f.destination }] };
  f.run.mockImplementation(async () => { const bytes = fs.readFileSync(f.destination); bytes[512] ^= 1; fs.writeFileSync(f.destination, bytes); });
  await runWindowsBuildProducer(producers, output.path, invocation, f);
  const pin = await windowsStageReceiptConsumer(plan, producers).consume(output.path, output.stage);
  expect(pin.inputs).toEqual(output.inputs); expect(pin.sourceSha256).toBe(peSha256(fs.readFileSync(f.destination)));
  expect(pin.sourceSha256).not.toBe(output.inputs[0].sha256);
});
it("admits a real successful process with an explicit environment that excludes its parent's credentials", async () => {
  vi.stubEnv("AZURE_CLIENT_SECRET", "fixture-secret");
  const f = await buildProducerFixture(), toolDigest = peSha256(fs.readFileSync(process.execPath));
  const output = { ...f.output, tools: [{ component: "node", sha256: toolDigest }] }, plan = { ...f.plan, outputs: [output] };
  const producers = await registerWindowsBuildProducers(plan, { ...f.options, toolFiles: [{ path: process.execPath, sha256: toolDigest }] });
  const program = "if (Object.keys(process.env).some(k => /AZURE_|NODE_OPTIONS|GITHUB_/i.test(k))) process.exit(8); require('node:fs').writeFileSync(process.argv[1], Buffer.from(process.argv[2], 'base64'));";
  const invocation = { ...f.invocation, command: process.execPath, tools: [{ component: "node", file: process.execPath }],
    args: ["-e", program, f.destination, unsignedPeFixture().toString("base64")] };
  await runWindowsBuildProducer(producers, output.path, invocation);
  const pin = await windowsStageReceiptConsumer(plan, producers).consume(output.path, output.stage);
  expect(pin.sourceSha256).toBe(peSha256(unsignedPeFixture()));
});
it("runs a real credential-free process and rejects its real nonzero exit", async () => {
  const f = await buildProducerFixture(), toolDigest = peSha256(fs.readFileSync(process.execPath));
  const output = { ...f.output, tools: [{ component: "node", sha256: toolDigest }] };
  const producers = await registerWindowsBuildProducers({ ...f.plan, outputs: [output] }, { ...f.options, toolFiles: [{ path: process.execPath, sha256: toolDigest }] });
  const invocation = { ...f.invocation, command: process.execPath, tools: [{ component: "node", file: process.execPath }], args: ["-e", "process.exit(7)"] };
  await expect(runWindowsBuildProducer(producers, output.path, invocation)).rejects.toMatchObject({ code: 7 });
  expect(fs.existsSync(f.destination)).toBe(false);
});
