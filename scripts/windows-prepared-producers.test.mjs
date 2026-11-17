// Authenticated preparation handoff owner: win-sac-sign; signed run manifest/controller owner: MAIN.
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { buildProducerFixture } from "./fixtures/windows-build-producer.mjs";
import { removeTempDirSync } from "../server/testing/cleanup.ts";
import { registerWindowsBuildProducers, runWindowsBuildProducer, windowsPreparedProducerFiles } from "./windows-build-producers.mjs";
import { windowsStageReceiptConsumer } from "./windows-stage-receipts.mjs";
import { peSha256 } from "./windows-pe-signing.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });

export async function preparedProducerFixture() {
  const f = await buildProducerFixture(roots), producers = await registerWindowsBuildProducers(f.plan, f.options);
  await runWindowsBuildProducer(producers, f.output.path, f.invocation, f);
  const selected = await producers.get(f.output.producer)({ path: f.output.path, stage: f.output.stage, planSha256: f.plan.sha256 });
  const root = path.join(f.root, "authenticated-inputs"), name = `producer-receipts/${peSha256(f.output.path)}.json`;
  fs.mkdirSync(path.join(root, "producer-receipts"), { recursive: true });
  const file = path.join(root, name), invocationFile = `${file}.invocation.json`;
  fs.copyFileSync(selected.file, file); fs.copyFileSync(`${selected.file}.invocation.json`, invocationFile);
  const files = [];
  const refresh = () => {
    files.splice(0, files.length, ...[name, `${name}.invocation.json`].map(relative => ({ path: relative, sha256: peSha256(fs.readFileSync(path.join(root, relative))) })));
  };
  refresh();
  const rewrite = (changeReceipt = () => {}, changeInvocation = () => {}) => {
    const receipt = JSON.parse(fs.readFileSync(file)), invocation = JSON.parse(fs.readFileSync(invocationFile));
    changeInvocation(invocation); fs.writeFileSync(invocationFile, JSON.stringify(invocation) + "\n");
    receipt.invocationSha256 = peSha256(JSON.stringify(invocation)); changeReceipt(receipt);
    fs.writeFileSync(file, JSON.stringify(receipt) + "\n"); refresh();
  };
  const context = { ...f, root, file, invocationFile, files, refresh, rewrite, select: rows => rows };
  context.load = async (runRoot = context.root) => registerWindowsBuildProducers(context.plan, { ...context.options, directory: path.join(f.root, "signing-receipts"),
    prepared: context.select(windowsPreparedProducerFiles(context.plan, runRoot, files)) });
  return context;
}
it("imports genuine preparation completions through controller-selected digests without running a compiler or scanning output", async () => {
  const f = await preparedProducerFixture(), producers = await f.load(), consumer = windowsStageReceiptConsumer(f.plan, producers);
  const pin = await consumer.consume(f.output.path, f.output.stage); consumer.assertComplete();
  expect(pin.sourceSha256).toBe(peSha256(fs.readFileSync(f.destination))); expect(f.run).toHaveBeenCalledOnce();
  const compile = vi.fn();
  await expect(runWindowsBuildProducer(producers, f.output.path, f.invocation, { run: compile })).rejects.toThrow();
  expect(compile).not.toHaveBeenCalled();
});
export const preparedProducerViolations = [
  ["missing receipt authorization", f => { f.files.splice(0, 1); }],
  ["missing invocation authorization", f => { f.files.pop(); }],
  ["duplicate authorization", f => { f.files.push({ ...f.files[0] }); }],
  ["changed receipt bytes", f => { fs.appendFileSync(f.file, " "); }],
  ["changed invocation bytes", f => { fs.appendFileSync(f.invocationFile, " "); }],
  ["wrong receipt digest", f => { f.files[0].sha256 = "b".repeat(64); }],
  ["wrong invocation digest", f => { f.files[1].sha256 = "b".repeat(64); }],
  ["relative run root", f => { f.root = path.relative(process.cwd(), f.root); }],
  ["duplicate completion", f => { f.select = rows => [...rows, rows[0]]; }],
  ["undeclared completion", f => { f.select = rows => rows.map(row => ({ ...row, path: "resources/undeclared.node" })); }],
  ["relative receipt file", f => { f.select = rows => rows.map(row => ({ ...row, file: path.relative(process.cwd(), row.file) })); }],
  ["relative invocation file", f => { f.select = rows => rows.map(row => ({ ...row, invocationFile: path.relative(process.cwd(), row.invocationFile) })); }],
  ...["runId", "runAttempt", "sourceRevision", "target", "version", "planSha256", "stage", "producer", "inputs", "tools", "transformations"].map(key =>
    ["receipt " + key, f => f.rewrite(receipt => { receipt[key] = "different"; })]),
  ["invocation binding", f => f.rewrite(receipt => { receipt.invocationSha256 = "b".repeat(64); })],
  ["failed compiler exit", f => f.rewrite(undefined, invocation => { invocation.exitCode = 1; })],
  ["wrong output path", f => f.rewrite(undefined, invocation => { invocation.path = "Murage.exe"; })],
  ["wrong output hash", f => f.rewrite(undefined, invocation => { invocation.preSignSha256 = "b".repeat(64); })],
  ["relative compiler cwd", f => f.rewrite(undefined, invocation => { invocation.cwd = "."; })],
  ["invalid argv", f => f.rewrite(undefined, invocation => { invocation.args = [1]; })],
  ["command differs from compiler", f => f.rewrite(undefined, invocation => { invocation.command = path.join(f.root, "other-tool"); })],
  ["wrong input digest", f => f.rewrite(undefined, invocation => { invocation.inputs[0].sha256 = "b".repeat(64); })],
  ["missing input", f => f.rewrite(undefined, invocation => { invocation.inputs = []; })],
  ["relative input", f => f.rewrite(undefined, invocation => { invocation.inputs[0].file = "source.c"; })],
  ["wrong tool digest", f => f.rewrite(undefined, invocation => { invocation.tools[0].sha256 = "b".repeat(64); })],
  ["unenrolled tool path", f => f.rewrite(undefined, invocation => { invocation.tools[0].file = invocation.command = path.join(f.root, "other-tool"); })],
];
it.each(preparedProducerViolations)("refuses prepared %s without issuing a producer pin", async (_name, mutate) => {
  const f = await preparedProducerFixture(); mutate(f); await expect(f.load()).rejects.toThrow();
});
it("records authenticated invocation evidence in the current operation graph when a prepared producer is consumed", async () => {
  const f = await preparedProducerFixture(), producer = vi.fn(async (_scope, _name, operation) => operation());
  const producers = await registerWindowsBuildProducers(f.plan, { ...f.options, directory: path.join(f.root, "signing-receipts"),
    prepared: windowsPreparedProducerFiles(f.plan, f.root, f.files), session: { producer } });
  await windowsStageReceiptConsumer(f.plan, producers).consume(f.output.path, f.output.stage);
  expect(producer).toHaveBeenCalledWith("app", f.output.path, expect.any(Function));
  expect((await producer.mock.results[0].value).inputDigests.invocation).toBe(JSON.parse(fs.readFileSync(f.file)).invocationSha256);
});
