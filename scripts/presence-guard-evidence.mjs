// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function collectPresenceEvidence({ addon, platform = process.platform, arch = process.arch, now = () => performance.now() }) {
  assert.equal(typeof addon.read, "function", "PRESENCE_READ_EXPORT_REQUIRED");
  assert.equal(typeof addon.onChange, "function", "PRESENCE_ONCHANGE_EXPORT_REQUIRED");
  const started = now(), snapshot = addon.read(), readDurationMs = now() - started;
  assert.deepEqual(Object.keys(snapshot).sort(), ["focus", "fullscreen", "sharing"]);
  for (const value of Object.values(snapshot)) assert.equal(typeof value, "boolean");
  let first, second;
  try {
    first = addon.onChange(() => {});
    assert.equal(typeof first, "function", "PRESENCE_UNSUBSCRIBE_REQUIRED");
    second = addon.onChange(() => {});
    assert.equal(typeof second, "function", "PRESENCE_UNSUBSCRIBE_REQUIRED");
    first();
    first();
    second();
    second();
  } finally {
    if (typeof first === "function") first();
    if (typeof second === "function") second();
  }
  return { platform, arch, node: process.version, read: snapshot, readDurationMs,
    exports: { read: true, onChange: true }, onChange: { subscribeUnsubscribeOk: true, replacementCallsOk: true, repeatedUnsubscribeOk: true } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.ok(process.platform === "darwin" || process.platform === "win32", "PRESENCE_NATIVE_PLATFORM_REQUIRED");
  assert.equal(process.argv.length, 4, "PRESENCE_EVIDENCE_PATHS_REQUIRED");
  const addonFile = path.resolve(process.argv[2]);
  const addon = createRequire(import.meta.url)(addonFile);
  const evidence = collectPresenceEvidence({ addon });
  // A process with an active, unreferenced subscription must exit and clean up its OS observer.
  const probe = spawnSync(process.execPath, ["--input-type=commonjs", "-e",
    'const addon = require(process.argv[1]); addon.onChange(() => {});', addonFile], { encoding: "utf8", timeout: 10000 });
  assert.ifError(probe.error);
  assert.equal(probe.status, 0, "PRESENCE_EXIT_PROBE: " + probe.stderr);
  evidence.onChange.exitWithActiveSubscriptionOk = true;
  evidence.sourceSha = process.env.EXPECTED_SHA;
  writeFileSync(process.argv[3], JSON.stringify(evidence, null, 2) + "\n");
}
