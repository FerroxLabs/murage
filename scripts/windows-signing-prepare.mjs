// Preparation/receipt producer owner: win-sac-sign; reviewed recipe, tool pins and artifact authorization owner: MAIN.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readWindowsBuildPlan, windowsStageReceiptConsumer } from "./windows-stage-receipts.mjs";
import { peSha256, readWindowsPeSnapshot } from "./windows-pe-signing.mjs";
import { registerWindowsBuildProducers, runWindowsBuildProducer, windowsPreparedProducerFiles } from "./windows-build-producers.mjs";

const components = new Set(["engine-exclusion", "anchored-read", "presence-guard", "recovery", "browser-host", "fuigo-probe", "gepa"]);
const fail = () => { throw Error("WINDOWS_SIGNING_PREPARATION_REJECTED"); };

/** These hashes describe preparation output. Only the controller's subsequent
 * artifact/run authorization can make them signing inputs. */
export async function prepareWindowsBuildProducers(plan, { root, toolFiles, invocations, env = process.env } = {}, execution) {
  const outputs=plan.outputs?.filter(row=>components.has(row.component));
  if (Object.keys(env).some(key => /^AZURE_/i.test(key)) || !path.isAbsolute(root ?? "")
    || !Array.isArray(invocations) || !invocations.length || !outputs?.length
    || invocations.length !== outputs.length
    || new Set(invocations.map(row => row.path)).size !== invocations.length
    || invocations.some(row => !outputs.some(output => output.path === row.path))) fail();
  const producers = await registerWindowsBuildProducers(plan, { directory: path.join(root, "producer-receipts"), toolFiles });
  const consumer = windowsStageReceiptConsumer({ ...plan, outputs }, producers);
  const files = [];
  for (const output of outputs) {
    const selected = invocations.find(row => row.path === output.path);
    await runWindowsBuildProducer(producers, output.path, selected.invocation, execution);
    await consumer.consume(output.path, output.stage);
    const name = `producer-receipts/${peSha256(output.path)}.json`;
    for (const file of [name, `${name}.invocation.json`]) {
      files.push({ path: file, sha256: peSha256((await readWindowsPeSnapshot(path.join(root, file))).bytes) });
    }
  }
  consumer.assertComplete();
  return windowsPreparedProducerFiles(plan, root, files);
}

export async function prepareWindowsSigning(file, expected, env = process.env) {
  if (Object.keys(env).some(key => /^AZURE_/i.test(key)) || !path.isAbsolute(file ?? "") || !/^[a-f0-9]{64}$/.test(expected ?? "")) fail();
  const bytes = (await readWindowsPeSnapshot(file)).bytes;
  if (peSha256(bytes) !== expected) fail();
  const recipe = JSON.parse(bytes);
  if (recipe.schema !== 1) fail();
  const plan = await readWindowsBuildPlan(recipe.plan.file, recipe.plan.sha256, recipe.identity);
  return prepareWindowsBuildProducers(plan, { ...recipe, env });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) fail();
    await prepareWindowsSigning(process.env.MURAGE_WINDOWS_SIGNING_PREPARATION, process.env.MURAGE_WINDOWS_SIGNING_PREPARATION_SHA256);
  } catch { process.stderr.write("WINDOWS_SIGNING_PREPARATION_FAILED\n"); process.exitCode = 1; }
}
