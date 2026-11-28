// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { test } from "node:test";

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

test("image uses the pinned multi-platform Node runtime and a non-root default", () => {
  const file = read("Containerfile");
  assert.match(file, /FROM node:24-bookworm@sha256:[a-f0-9]{64}/);
  assert.match(file, /USER node/);
  assert.match(file, /HEALTHCHECK .*CMD \["node", "scripts\/container-image-health.mjs"\]/);
  assert.match(file, /CMD \["node", "dist-server\/index.js"\]/);
  assert.doesNotMatch(file, /COPY\s+\.\s|ADD\s|curl|wget|npm install|apt-get|--privileged/);
  assert.match(file, /memory-runtime-manifest.json/);
  assert.match(file, /manifest.arch.*process.arch/);
});

test("both builders send only prepared runtime files, never the checkout or data", () => {
  const docker = read("Containerfile.dockerignore");
  assert.equal(docker, read(".containerignore"));
  assert.equal(docker.split("\n").find(line => line && !line.startsWith("#")), "**");
  const admitted = docker.split("\n").filter(line => line.startsWith("!"));
  assert.deepEqual(admitted, ["!Containerfile", "!dist-server/", "!dist-server/**", "!dist/", "!dist/**", "!scripts/", "!scripts/container-image-health.mjs", "!LICENSE", "!NOTICE"]);
});

test("the data lease and data folder share the writable volume", () => {
  // The existing lease is a sibling of the data directory. A data directory
  // at the volume root would require writing its lease into the image root.
  assert.match(read("Containerfile"), /MURAGE_DATA_DIR=\/data\/murage(?:\s|$)/);
});

test("offline smoke checks the running default, isolated data, and every saved layer", () => {
  const smoke = read("scripts/smoke-container-image.mjs");
  for (const required of ["--network", '"none"', "--read-only", "--cap-drop=ALL", "no-new-privileges", "container-image-health.mjs", '"getuid"', '"save"', "manifest.json", "Layers", "--no-git", "--ignore-gitleaks-allow", "--redact", '"stop"', '"rm"']) {
    assert.ok(smoke.includes(required), required);
  }
  assert.doesNotMatch(smoke, /--privileged|--network.host|\/var\/run\/docker.sock|process\.env\.HOME/);
});

test("qualification builds both architectures on dedicated runners without publishing", () => {
  const workflow = read(".github/workflows/container-image.yml");
  for (const required of ["workflow_dispatch", "self-hosted", "murage-container-builder", "amd64", "arm64", "--network none", "--pull=never", "--frozen-lockfile", "--offline", "smoke-container-image.mjs"]) assert.ok(workflow.includes(required), required);
  assert.doesNotMatch(workflow, /ubuntu-latest|docker push|podman push|packages: write|registry-password/);
});

test("health probe requires the Murage identity and fails on an unrelated or unavailable server", async () => {
  let body = { app: "murage", pid: 12, static: true };
  const server = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const env = { ...process.env, MURAGE_PORT: String(server.address().port) };
  const command = promisify(execFile);
  const file = new URL("./container-image-health.mjs", import.meta.url).pathname;
  try {
    const result = await command(process.execPath, [file], { env });
    assert.equal(result.stdout, "");
    body = { app: "other", pid: 12, static: true };
    await assert.rejects(command(process.execPath, [file], { env }));
    body = { app: "murage", pid: 12, static: false };
    await assert.rejects(command(process.execPath, [file], { env }));
  } finally { await new Promise(resolve => server.close(resolve)); }
  await assert.rejects(command(process.execPath, [file], { env }));
});

test("layer scan allowances require the exact audited bytes and rule, never a path", async () => {
  const { classifyLayerFindings } = await import("./container-image-scan.mjs");
  const fragment = "a public code expression";
  const allowance = { rule: "generic-api-key", sha256: createHash("sha256").update(fragment).digest("hex"), reason: "Fixture code." };
  const known = { RuleID: allowance.rule, Secret: fragment, File: "fixture.js" };
  const near = { ...known, Secret: `${fragment} changed` };
  const wrongRule = { ...known, RuleID: "private-key" };
  const result = classifyLayerFindings([known, near, wrongRule], [allowance]);
  assert.equal(result.codeFragments, 1);
  assert.deepEqual(result.findings, [near, wrongRule]);
  assert.equal(classifyLayerFindings([near], []).findings.length, 1);
  assert.throws(() => classifyLayerFindings([known], [{ ...allowance, sha256: "*" }]));
});
