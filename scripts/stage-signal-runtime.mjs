import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import { SIGNAL_FIXTURE_SOURCE, SIGNAL_RUNTIME_RESOURCE, signalFixtureDir } from "../server/channels/signal/runtime-paths.mjs";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Local staging is offline. Only --release may fetch reviewed inputs, on the
// matching release runner. Never infer pins or use a workstation's system Java.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { ROOT, PIN_PATH, TARGETS, json, digest, safePath, assertReleasePin, verifyLicenses, generateInventory, verifyInventory } from "./signal-inventory.mjs";

import { stageRuntimeLicenses } from "../server/channels/signal/runtime-licenses.mjs";
import { verifyRuntimeTree } from "../server/channels/signal/runtime-integrity.mjs";

const releaseHost = () => ({ platform: process.platform, arch: process.arch,
  releaseRunner: process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_WORKFLOW_REF?.includes("/.github/workflows/release.yml@") });

export async function stageRuntime({ input, target, destination, pin = json(PIN_PATH),
  licenseRoot = join(ROOT, "licenses/signal-runtime"), sourceRoot = ROOT,
  fixtureRoot = join(sourceRoot, SIGNAL_FIXTURE_SOURCE),
  host = releaseHost(),
  run = spawnSync }) {
  assertReleasePin(pin, { fixtureRoot });
  if (!Object.hasOwn(TARGETS, target)) throw Error("Unsupported Signal target");
  if (`${host.platform}-${host.arch}` !== target) throw Error("Signal runtime requires the matching target host");
  if (pin.releaseInputs?.[target]?.layout !== "prelinked-jre") throw Error("Signal prelinked-jre layout required");
  const record = pin.targets[target];
  if (record.libsignal.provenance.kind === "source-build" && !host.releaseRunner) throw Error("Signal source JNI requires the macOS release runner");
  // The shared verifier checks the isolated candidate before it is published.
  verifyLicenses(licenseRoot);
  const output = resolve(destination ?? join(ROOT, "dist-native", SIGNAL_RUNTIME_RESOURCE, target));
  if (existsSync(output)) throw Error("Signal stage destination already exists; use a fresh output directory");
  mkdirSync(dirname(output), { recursive: true });
  const scratch = mkdtempSync(join(dirname(output), ".signal-stage-"));
  try {
    const entries = (await import("node:fs")).readdirSync(input).sort();
    if (JSON.stringify(entries) !== JSON.stringify(["jdk", "lib", "native", "signal-cli.jar"])) throw Error("Signal input root layout differs");
    cpSync(input, scratch, { recursive: true, verbatimSymlinks: true });
    renameSync(join(scratch, "jdk"), join(scratch, "jre"));
    stageRuntimeLicenses(licenseRoot, join(scratch, "licenses"), record.jars);
    cpSync(fixtureRoot, signalFixtureDir(scratch), { recursive: true });
    await verifyRuntimeTree({ root: scratch, pin, target });
    const options = { runtime: scratch, pin, target, licenseRoot, sourceRoot, fixtureRoot };
    writeFileSync(join(scratch, "runtime-pin.json"), JSON.stringify(pin, null, 2) + "\n");
    writeFileSync(join(scratch, "signal.inventory.json"), JSON.stringify(await generateInventory(options), null, 2) + "\n");
    await verifyInventory(options);
    renameSync(scratch, output);
    return output;
  } finally {
    // Only this invocation's unique temporary directory can be removed.
    if (existsSync(scratch)) safeWipeSync(scratch, { within: dirname(output) });
  }
}

/** Download only the reviewed immutable archive; local tests inject fetchInput. */
export async function stageReleaseRuntime({ target, pin = json(PIN_PATH), host = releaseHost(),
  fetchInput = fetch, run = spawnSync, temporaryRoot = tmpdir(), sourceRoot = ROOT,
  fixtureRoot = join(sourceRoot, SIGNAL_FIXTURE_SOURCE), ...options }) {
  assertReleasePin(pin, { fixtureRoot });
  if (!host.releaseRunner) throw Error("Signal inputs may only be fetched by the release runner");
  if (!Object.hasOwn(TARGETS, target) || `${host.platform}-${host.arch}` !== target) throw Error("Signal release inputs require the matching target host");
  const inputPin = pin.releaseInputs?.[target];
  if (!inputPin) throw Error("G0_REQUIRED: reviewed release input archive is missing");
  const scratch = mkdtempSync(join(temporaryRoot, "signal-release-inputs-"));
  try {
    if (new URL(inputPin.url).protocol !== "https:") throw Error("Signal release inputs require HTTPS");
    if (inputPin.layout !== "prelinked-jre") throw Error("Signal prelinked-jre layout required");
    const response = await fetchInput(inputPin.url, { signal: AbortSignal.timeout(300_000), redirect: "follow" });
    if (response.url && new URL(response.url).protocol !== "https:") throw Error("Signal release inputs redirect requires HTTPS");
    if (!response.ok) throw Error("Signal release input download failed");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (digest(bytes) !== inputPin.sha256) throw Error("Signal release input archive hash mismatch");
    const archive = join(scratch, "inputs.tar.gz"), input = join(scratch, "input");
    writeFileSync(archive, bytes);
    mkdirSync(input);
    const commandOptions = { cwd: scratch, shell: false, encoding: "utf8", timeout: 300_000, maxBuffer: 16 * 1024 * 1024 };
    const listed = run("tar", ["-tzf", archive], commandOptions);
    if (listed.error || listed.status !== 0 || !listed.stdout?.trim()) throw Error("Signal release input archive cannot be listed");
    const roots = new Set();
    for (const entry of listed.stdout.trim().split(/\r?\n/)) {
      const path = entry.replace(/^\.\//, "").replace(/\/$/, "");
      if (entry !== "." && entry !== "./") {
        safePath(path);
        const root = path.split("/")[0];
        if (!["signal-cli.jar", "lib", "native", "jdk"].includes(root)) throw Error("Signal release input archive layout differs from root contract");
        roots.add(root);
      }
    }
    if (["signal-cli.jar", "lib", "native", "jdk"].some(root => !roots.has(root))) throw Error("Signal release input archive layout is incomplete");
    const extracted = run("tar", ["-xzf", archive, "-C", input], commandOptions);
    if (extracted.error || extracted.status !== 0) throw Error("Signal release input extraction failed");
    return await stageRuntime({ ...options, input, target, pin, host, run, sourceRoot, fixtureRoot });
  } finally {
    safeWipeSync(scratch, { within: temporaryRoot });
  }
}

export async function runStageCommand(args, options = {}) {
  const [targetFlag, target, inputFlag, input] = args;
  if (targetFlag === "--target" && inputFlag === "--release" && args.length === 3) {
    return `Staged Signal runtime: ${await stageReleaseRuntime({ ...options, target })}`;
  }
  if (targetFlag !== "--target" || inputFlag !== "--input" || !input || args.length !== 4) throw Error("usage: --target <os-arch> --input <reviewed-local-directory>, or --target <os-arch> --release");
  return `Staged Signal runtime: ${await stageRuntime({ ...options, target, input })}`;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(await runStageCommand(process.argv.slice(2))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
