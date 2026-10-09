// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";

it.each([
  ["mac", "darwin", "arm64", "release/mac-arm64/Murage.app/Contents/Resources/server", "release/mac-arm64/Murage.app/Contents/MacOS/Murage"],
  ["mac-x64", "darwin", "x64", "release/mac/Murage.app/Contents/Resources/server", "release/mac/Murage.app/Contents/MacOS/Murage"],
  ["windows", "win32", "x64", "release/win-unpacked/resources/server", "release/win-unpacked/Murage.exe"],
  ["linux", "linux", "x64", "release/linux-unpacked/resources/server", "release/linux-unpacked/murage"],
])("requires both WhatsApp gates after packaging and before upload: %s %s %s", (job, platform, arch, server, runtime) => {
  const steps = parse(readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")).jobs[job].steps;
  const packaged = steps.findIndex(step => /pnpm package:(mac|win|linux)|tar -xf x64-app/.test(step.run ?? ""));
  const upload = steps.findIndex(step => step.uses?.startsWith("actions/upload-artifact@"));
  const gate = steps.findIndex(step => step.run?.includes(`--server-directory "${server}"`));
  expect(gate).toBeGreaterThan(packaged); expect(gate).toBeLessThan(upload);
  const step = steps[gate];
  expect(step.if).toBeUndefined(); expect(step["continue-on-error"]).toBeUndefined();
  expect(step.run).toContain("set -euo pipefail");
  expect(step.run).toContain(`node scripts/whatsapp-inventory.mjs "${server}" --check`);
  expect(step.run.indexOf("whatsapp-inventory.mjs")).toBeLessThan(step.run.indexOf("smoke-whatsapp-packaged.mjs"));
  expect(step.run).toContain(`--runtime "${runtime}" --platform ${platform} --arch ${arch} --electron-version`);
  expect(step.run).toContain('require("electron/package.json").version');
  expect(step.run).toContain(`cp "${server}/whatsapp-runtime-manifest.json" qualification-evidence/whatsapp-${platform}-${arch}-inventory.json`);
  expect(step.run).toContain(`> qualification-evidence/whatsapp-${platform}-${arch}.json`);
  expect(step.run).not.toMatch(/\|\|\s*true/);
  const evidence = steps.find(step => step.with?.name === `${job}-whatsapp-gepa-evidence`);
  expect(evidence.with.path).toBe("qualification-evidence/whatsapp-*");
  expect(evidence.with["if-no-files-found"]).toBe("error");
});
