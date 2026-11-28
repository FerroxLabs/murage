// SPDX-License-Identifier: AGPL-3.0-or-later
// An isolated image fixture, never the running app. Evidence must be external.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { classifyLayerFindings } from "./container-image-scan.mjs";

const [image, evidenceArg] = process.argv.slice(2);
assert.ok(image && evidenceArg, "Use: node scripts/smoke-container-image.mjs IMAGE EVIDENCE_DIRECTORY");
const evidence = realpathSync(evidenceArg);
const root = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const outside = relative(root, evidence);
assert.ok(outside === ".." || outside.startsWith(`..${sep}`) || isAbsolute(outside), "Keep evidence outside the checkout.");
const scratch = mkdtempSync(join(evidence, "image-scratch-"));
const engine = process.env.CONTAINER_ENGINE || "docker";
assert.ok(["docker", "podman"].includes(engine), "Choose Docker or Podman.");
const name = `murage-image-fixture-${randomUUID()}`;
const run = args => execFileSync(engine, args, { encoding: "utf8", stdio: "pipe", timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
let created = false;
try {
  const inspected = JSON.parse(run(["image", "inspect", image]))[0];
  assert.ok(inspected.Config.User && !["0", "root", "0:0", "root:root"].includes(inspected.Config.User), "The image must run as a non-root user.");
  run(["create", "--name", name, "--network", "none", "--read-only", "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--tmpfs", "/data:uid=1000,gid=1000,mode=0700", "--tmpfs", "/tmp:mode=1777", image]);
  created = true;
  run(["start", name]);
  const deadline = Date.now() + 90000;
  let healthy = false;
  while (Date.now() < deadline) {
    try { run(["exec", name, "node", "scripts/container-image-health.mjs"]); healthy = true; break; }
    catch {
      if (!JSON.parse(run(["inspect", name]))[0].State.Running) {
        throw Error("The image stopped before its health check passed.");
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  assert.ok(healthy, "The image must answer its health check.");
  const uid = run(["exec", name, "node", "-p", 'process["getuid"]()']).trim();
  assert.notEqual(uid, "0");
  const state = JSON.parse(run(["inspect", name]))[0];
  assert.equal(state.HostConfig.NetworkMode, "none");
  writeFileSync(join(evidence, "smoke.json"), JSON.stringify({ healthy, uid: Number(uid), architecture: inspected.Architecture, network: "none", readOnly: true }) + "\n");

  // Save and extract EACH layer separately. Scanning only the merged root
  // misses credentials added and deleted in different layers.
  const archive = join(scratch, "image.tar");
  run(["save", "--output", archive, ...(engine === "podman" ? ["--format", "docker-archive"] : []), image]);
  const saved = join(scratch, "saved");
  mkdirSync(saved);
  execFileSync("tar", ["-xf", archive, "-C", saved]);
  const manifests = JSON.parse(readFileSync(join(saved, "manifest.json"), "utf8"));
  assert.ok(manifests.length > 0 && manifests.every(entry => Array.isArray(entry.Layers) && entry.Layers.length > 0), "The image archive must enumerate its layers.");
  const layers = [...new Set(manifests.flatMap(entry => entry.Layers))];
  const scan = join(scratch, "scan");
  mkdirSync(scan);
  for (const [index, layer] of layers.entries()) {
    assert.ok(!isAbsolute(layer) && !layer.split("/").includes(".."), "Invalid layer path.");
    const target = join(scan, `layer-${index}`);
    mkdirSync(target);
    execFileSync("tar", ["-xf", join(saved, layer), "-C", target, "--no-same-owner", "--no-same-permissions"]);
  }
  for (const manifest of manifests) {
    assert.ok(!isAbsolute(manifest.Config) && !manifest.Config.split("/").includes(".."), "Invalid configuration path.");
    writeFileSync(join(scan, basename(manifest.Config)), readFileSync(join(saved, manifest.Config)));
  }
  const scanner = process.env.GITLEAKS || "gitleaks";
  // Keep scanner bytes private until exact code expressions are classified.
  // --redact=0 is confined to scratch; no tool output or raw finding is shown
  // or retained. Redact before writing the review report, including failures.
  const rawReport = join(scratch, "scanner.json");
  const checked = spawnSync(scanner, ["detect", "--no-git", "--source", scan, "--ignore-gitleaks-allow", "--redact=0", "--no-banner", "--report-format", "json", "--report-path", rawReport], { stdio: "pipe", timeout: 300000 });
  assert.ok(!checked.error && [0, 1].includes(checked.status), "The layer scanner did not complete.");
  const allowances = JSON.parse(readFileSync(new URL("./container-image-scan-allowlist.json", import.meta.url), "utf8")).allowances;
  const result = classifyLayerFindings(JSON.parse(readFileSync(rawReport, "utf8")), allowances);
  const redacted = result.findings.map(finding => ({ ...finding, Match: "REDACTED", Secret: "REDACTED" }));
  writeFileSync(join(evidence, "layers-secrets.json"), JSON.stringify(redacted, null, 2) + "\n");
  writeFileSync(join(evidence, "layers.json"), JSON.stringify({ layers: layers.length, findings: result.findings.length, codeFragments: result.codeFragments }) + "\n");
  assert.equal(result.findings.length, 0, "Layer findings need review. See the redacted report.");
  console.log("Image health, non-root runtime, and layer secret scan passed.");
} finally {
  try {
    if (created) {
      try { run(["stop", "--time", "10", name]); }
      finally { run(["rm", "--force", name]); }
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
