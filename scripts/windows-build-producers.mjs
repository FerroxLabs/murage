// Producer adapters/receipts owner: win-sac-sign; sealed tool enrollment and authenticated preparation owner: MAIN.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";
import { peSha256, readWindowsPeSnapshot } from "./windows-pe-signing.mjs";
import { resolveWindowsBuildPlanStage, windowsStageReceiptConsumer } from "./windows-stage-receipts.mjs";

const registries = new WeakMap();
const execute = promisify(execFile);
const fail = () => { throw Error("WINDOWS_BUILD_PRODUCER_REJECTED"); };
const producersByComponent = Object.freeze({
  "engine-exclusion": "native-engine-exclusion", "anchored-read": "native-anchored-read", "presence-guard": "native-presence-guard",
  recovery: "native-recovery", "browser-host": "native-browser-host", "fuigo-probe": "native-fuigo-probe",
  gepa: "gepa-worker", "backup-transport": "backup-transport-final", "murage-app": "electron-resource-edit",
  uninstaller: "nsis-uninstaller", installer: "nsis-installer", "nsis-helper": "nsis-helper",
});
const prebuilt = new Set(["engine-exclusion", "anchored-read", "presence-guard", "recovery", "browser-host", "fuigo-probe", "gepa"]);

/** The caller supplies the already verified controller run manifest. Neighbor
 * files/command outputs never select an expected digest. */
export function windowsPreparedProducerFiles(plan, root, files) {
  if (!path.isAbsolute(root ?? "") || !Array.isArray(files)) fail();
  const select = name => {
    const rows = files.filter(row => row.path === name);
    if (rows.length !== 1 || !/^[a-f0-9]{64}$/.test(rows[0].sha256 ?? "")) fail();
    return { file: path.join(root, ...name.split("/")), sha256: rows[0].sha256 };
  };
  return plan.outputs.filter(row => prebuilt.has(row.component)).map(row => {
    const name = `producer-receipts/${peSha256(row.path)}.json`;
    const receipt = select(name), invocation = select(`${name}.invocation.json`);
    return { path: row.path, ...receipt, invocationFile: invocation.file, invocationSha256: invocation.sha256 };
  });
}

/** Signer callbacks retrieve completed receipts only. Only the reviewed build
 * adapters receive this registry and invoke the command boundary below. */
export async function registerWindowsBuildProducers(plan, { directory, session, toolFiles, prepared = [] } = {}) {
  if (!path.isAbsolute(directory ?? "") || !plan.outputs?.length
    || plan.outputs.some(row => producersByComponent[row.component] !== row.producer)
    || !Array.isArray(toolFiles) || !toolFiles.length) fail();
  plan = structuredClone(plan); toolFiles = structuredClone(toolFiles); prepared = structuredClone(prepared);
  // A new attempt owns a new receipt directory; retries cannot adopt old output.
  await mkdir(directory, { mode: 0o700 });
  const state = { plan, session, toolFiles, directory, started: new Set(), completed: new Map(), failed: false };
  const producers = new Map();
  for (const output of plan.outputs) producers.set(output.producer, async request => {
    const selected = state.completed.get(request.path);
    if (state.failed || !selected || request.stage !== selected.stage || request.planSha256 !== selected.planSha256) fail();
    if (selected.details && session) await session.producer(selected.scope, request.path, async () => selected.details);
    return { file: selected.file, sha256: selected.sha256 };
  });
  if (!Array.isArray(prepared) || prepared.length > plan.outputs.length) fail();
  const imports = new Map();
  for (const selected of prepared) {
    const output = plan.outputs.find(row => row.path === selected.path);
    if (!output || !prebuilt.has(output.component) || imports.has(selected.path)
      || !path.isAbsolute(selected.file ?? "") || !path.isAbsolute(selected.invocationFile ?? "")) fail();
    const receiptBytes = (await readWindowsPeSnapshot(selected.file)).bytes;
    const invocationBytes = (await readWindowsPeSnapshot(selected.invocationFile)).bytes;
    if (peSha256(receiptBytes) !== selected.sha256 || peSha256(invocationBytes) !== selected.invocationSha256) fail();
    const receipt = JSON.parse(receiptBytes), invocation = JSON.parse(invocationBytes);
    if (receipt.invocationSha256 !== peSha256(JSON.stringify(invocation)) || invocation.exitCode !== 0
      || invocation.path !== output.path || invocation.preSignSha256 !== receipt.preSignSha256
      || !path.isAbsolute(invocation.cwd ?? "") || !Array.isArray(invocation.args)
      || invocation.args.some(value => typeof value !== "string" || value.includes("\0"))
      || invocation.command !== invocation.tools?.[0]?.file) fail();
    for (const [rows, expected] of [[invocation.inputs, output.inputs], [invocation.tools, output.tools]]) {
      if (!Array.isArray(rows) || rows.length !== expected.length
        || rows.some((row, index) => !path.isAbsolute(row.file ?? "") || row.sha256 !== expected[index].sha256)) fail();
    }
    if (invocation.tools.some(row => !toolFiles.some(pin => pin.path === row.file && pin.sha256 === row.sha256))) fail();
    imports.set(output.path, { ...selected, stage: output.stage, planSha256: receipt.planSha256,
      scope: output.component === "gepa" ? "gepa" : "app",
      details: { inputDigests: { ...Object.fromEntries(output.inputs.map(row => [row.component, row.sha256])), invocation: receipt.invocationSha256 },
        outputDigests: { [output.path]: receipt.preSignSha256 } } });
  }
  const importedConsumer = windowsStageReceiptConsumer(plan, new Map(plan.outputs.map(output => [output.producer, async request => {
    const selected = imports.get(request.path); if (!selected) fail(); return selected;
  }])), session);
  for (const [name, selected] of imports) {
    await importedConsumer.consume(name, selected.stage);
    state.started.add(name); state.completed.set(name, selected);
  }
  registries.set(producers, state);
  return producers;
}

async function snapshotRows(rows, expected) {
  if (!Array.isArray(rows) || rows.length !== expected.length
    || rows.some((row, index) => row.component !== expected[index].component || !path.isAbsolute(row.file ?? ""))) fail();
  const snapshots = [];
  for (const [index, row] of rows.entries()) {
    const snapshot = await readWindowsPeSnapshot(row.file);
    if (peSha256(snapshot.bytes) !== expected[index].sha256) fail();
    snapshots.push({ file: row.file, sha256: expected[index].sha256 });
  }
  return snapshots;
}

/** This wraps the actual tool invocation, never the sign callback. Inputs and
 * tools must also be in the sealed static tree/authenticated source catalogue. */
export async function runWindowsBuildProducer(producers, name, invocation, { run = execute } = {}) {
  const state = registries.get(producers);
  if (!state) fail();
  if (state.failed || state.started.has(name)) { state.failed = true; fail(); }
  state.started.add(name);
  try {
    invocation = structuredClone(invocation);
    const plan = state.plan.schema === 3 ? resolveWindowsBuildPlanStage(state.plan, name, state.session) : state.plan;
    const output = plan.outputs.find(row => row.path === name);
    if (!output || !path.isAbsolute(invocation.output ?? "") || !path.isAbsolute(invocation.command ?? "")
      || !path.isAbsolute(invocation.cwd ?? "") || !Array.isArray(invocation.args)
      || invocation.args.some(value => typeof value !== "string" || value.includes("\0"))
      || invocation.stdin !== undefined && typeof invocation.stdin !== "string"
      || !invocation.env || typeof invocation.env !== "object" || Array.isArray(invocation.env)
      || Object.entries(invocation.env).some(([key, value]) => /^(?:AZURE_|NODE_OPTIONS$|GITHUB_|CSC_|WIN_CSC_)/i.test(key) || typeof value !== "string")
      || invocation.tools?.[0]?.file !== invocation.command
      || invocation.tools.some((row, index) => !state.toolFiles.some(pin => pin.path === row.file && pin.sha256 === output.tools[index]?.sha256))) fail();
    const inputs = await snapshotRows(invocation.inputs, output.inputs);
    const tools = await snapshotRows(invocation.tools, output.tools);
    // Resource editing is the only declared in-place output transformation.
    const inPlace = output.component === "murage-app" && output.transformations.includes("resource-edit")
      && inputs.some(row => row.file === invocation.output);
    if (!inPlace) {
      try { await lstat(invocation.output); fail(); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const perform = async () => {
      if (state.failed) fail();
      await run(invocation.command, invocation.args, { cwd: invocation.cwd, env: { ...invocation.env }, shell: false,
        windowsHide: true, timeout: 300_000, maxBuffer: 1024 * 1024 });
      if (state.failed) fail();
      // Input/tool replacement while the compiler runs invalidates completion.
      for (const row of [...inputs.filter(row => !inPlace || row.file !== invocation.output), ...tools]) {
        if (peSha256((await readWindowsPeSnapshot(row.file)).bytes) !== row.sha256) fail();
      }
      const preSignSha256 = peSha256((await readWindowsPeSnapshot(invocation.output)).bytes);
      const evidence = { command: invocation.command, args: invocation.args, cwd: invocation.cwd, inputs, tools, exitCode: 0, path: name, preSignSha256,
        ...(invocation.stdin === undefined ? {} : { stdinSha256: peSha256(invocation.stdin) }) };
      const bytes = Buffer.from(JSON.stringify({ schema: 2, target: plan.target, sourceRevision: plan.sourceRevision, version: plan.version,
        runId: plan.runId, runAttempt: plan.runAttempt, planSha256: plan.sha256,
        ...(plan.parentPlanSha256 ? { parentPlanSha256: plan.parentPlanSha256, predecessors: plan.predecessors } : {}),
        path: name, stage: output.stage, producer: output.producer, inputs: output.inputs, tools: output.tools,
        transformations: output.transformations, preSignSha256, invocationSha256: peSha256(JSON.stringify(evidence)) }) + "\n");
      const file = path.join(state.directory, `${peSha256(name)}.json`);
      const handle = await open(file, "wx", 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      const evidenceHandle = await open(`${file}.invocation.json`, "wx", 0o600);
      try { await evidenceHandle.writeFile(JSON.stringify(evidence) + "\n"); await evidenceHandle.sync(); } finally { await evidenceHandle.close(); }
      state.completed.set(name, { file, sha256: peSha256(bytes), stage: output.stage, planSha256: plan.sha256 });
      return { inputDigests: Object.fromEntries(output.inputs.map(row => [row.component, row.sha256])), outputDigests: { [name]: preSignSha256 } };
    };
    if (state.session) {
      const scope = output.component === "gepa" ? "gepa" : output.component === "nsis-helper" ? "transient" : ["installer", "uninstaller"].includes(output.component) ? output.component : "app";
      await state.session.producer(scope, name, perform);
    } else await perform();
    return invocation.output;
  } catch (error) { state.failed = true; throw error; }
}
