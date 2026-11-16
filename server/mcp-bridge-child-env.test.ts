// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { removeTempDirSync } from "./testing/cleanup.ts";

it.each([false, true])("the real bridge strips inherited release defaults before applying caller overrides (overrides: %s)", async (overrides) => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-env-fixture-"));
  const report = join(dir, "child-env.json");
  // Read the actual child's environment through a fixture file, without
  // granting this raw child any model-facing release authority.
  const driver = `const {writeFileSync} = require('node:fs');
    process.stdin.resume();
    process.stdin.on('end', () => writeFileSync(process.argv[1], JSON.stringify({
      release: Object.fromEntries(Object.entries(process.env).filter(([key]) => /^MURAGE_RELEASE_/i.test(key))),
      ordinary: process.env.MURAGE_BRIDGE_FIXTURE,
      inherited: process.env.MURAGE_BRIDGE_INHERITED_FIXTURE,
      path: process.env.PATH
    })));`;
  const childEnv = overrides ? { MURAGE_BRIDGE_FIXTURE: "caller-value", MURAGE_RELEASE_FIXTURE_OVERRIDE: "caller-release" } : undefined;
  const script = `import {runMcpBridge} from './server/mcp-bridge.ts';
    runMcpBridge({command:process.execPath,args:['-e',${JSON.stringify(driver)},${JSON.stringify(report)}],
      label:'fixture',childEnv:${JSON.stringify(childEnv)}});`;
  const bridge = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^MURAGE_RELEASE_/i.test(key))),
      MURAGE_RELEASE_FIXTURE_DEFAULT: "inherited-release",
      mUrAgE_rElEaSe_FiXtUrE_mIxEd: "inherited-mixed-case",
      MURAGE_RELEASE_FIXTURE_OVERRIDE: "inherited-override",
      MURAGE_BRIDGE_FIXTURE: "parent-value",
      MURAGE_BRIDGE_INHERITED_FIXTURE: "retained-value",
    },
  });
  let errors = "";
  bridge.stdout.resume();
  bridge.stderr.on("data", chunk => { errors += chunk; });
  const closed = new Promise<number | null>((resolve, reject) => { bridge.once("error", reject); bridge.once("close", resolve); });
  const timer = setTimeout(() => bridge.kill("SIGKILL"), 10_000);
  try {
    bridge.stdin.end();
    expect(await closed, errors).toBe(0);
    const actual = JSON.parse(readFileSync(report, "utf8"));
    expect(actual.release).toEqual(overrides ? { MURAGE_RELEASE_FIXTURE_OVERRIDE: "caller-release" } : {});
    expect(actual.ordinary).toBe(overrides ? "caller-value" : "parent-value");
    expect(actual.inherited).toBe("retained-value");
    expect(actual.path).toEqual(expect.any(String));
    expect(actual.path.length).toBeGreaterThan(0);
  } finally {
    clearTimeout(timer);
    if (bridge.exitCode === null && bridge.signalCode === null) {
      bridge.kill("SIGKILL");
      await closed;
    }
    removeTempDirSync(dir);
  }
});
