// Build producer fixture owner: win-sac-sign; Windows deployment/witness consumer: MAIN.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { peSha256 } from "../windows-pe-signing.mjs";
import { readWindowsBuildPlan } from "../windows-stage-receipts.mjs";
import { unsignedPeFixture } from "./windows-pe-signing.mjs";

export async function buildProducerFixture(roots) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "build-producer-")); roots.push(root);
  const tool = path.join(root, "compiler"), input = path.join(root, "source.c"), destination = path.join(root, "engine-exclusion.node");
  fs.writeFileSync(tool, "fixture compiler"); fs.writeFileSync(input, "fixture source");
  const identity = { target: "win32-x64", sourceRevision: "a".repeat(40), version: "1.0.19", runId: "1", runAttempt: "1" };
  const output = { path: "resources/engine-exclusion.node", component: "engine-exclusion", stage: "native-compiled", producer: "native-engine-exclusion",
    inputs: [{ component: "source", sha256: peSha256(fs.readFileSync(input)) }], tools: [{ component: "compiler", sha256: peSha256(fs.readFileSync(tool)) }],
    transformations: ["compile"], publishers: ["Ferrox Labs, LLC"] };
  const planFile = path.join(root, "plan.json");
  fs.writeFileSync(planFile, JSON.stringify({ schema: 2, ...identity, outputs: [output] }));
  const plan = await readWindowsBuildPlan(planFile, peSha256(fs.readFileSync(planFile)), identity);
  const options = { directory: path.join(root, "receipts"), toolFiles: [{ path: tool, sha256: output.tools[0].sha256 }] };
  const invocation = { command: tool, args: [input, destination], cwd: root, env: { FIXTURE: "1" }, output: destination,
    inputs: [{ component: "source", file: input }], tools: [{ component: "compiler", file: tool }] };
  const run = vi.fn(async () => { fs.writeFileSync(destination, unsignedPeFixture()); });
  return { root, plan, output, options, invocation, tool, input, destination, run };
}
