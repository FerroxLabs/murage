// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// nlrace finding 6: the MCP stop probe helper (shared/spawned-proxies.mjs: mcpStopProbe = "drivers/mcp-stop-probe") is spawned by the
// packaged server at dist-server/drivers/mcp-stop-probe.js. tsc emits it under dist-server/server/ (the shared imports widen the emit
// root), so it has to be a bundle entry point. Witness 1 reads the entry list; witness 2 builds the entry the way the bundle does and runs
// the built file from the layout the registry expects.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, test } from "vitest";
import { SPAWNED_PROXY_FILES } from "../shared/spawned-proxies.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundleSource = readFileSync(join(root, "scripts", "bundle-server.mjs"), "utf8");
const entryList = /const ENTRY_POINTS = \[([\s\S]*?)\n\];/.exec(bundleSource)?.[1] ?? "";

test("the MCP stop probe is a bundle entry point at the path the packaged registry expects", () => {
  expect(SPAWNED_PROXY_FILES.mcpStopProbe).toBe("drivers/mcp-stop-probe");
  expect(entryList, "ENTRY_POINTS must list drivers/mcp-stop-probe.ts").toContain(`"${SPAWNED_PROXY_FILES.mcpStopProbe}.ts"`);
});

test("the probe built like the bundle lands at drivers/mcp-stop-probe.js and answers a verdict", async () => {
  const out = mkdtempSync(join(tmpdir(), "mcp-probe-bundle-"));
  try {
    const server = join(root, "server");
    await build({
      entryPoints: [join(server, `${SPAWNED_PROXY_FILES.mcpStopProbe}.ts`)], bundle: true, platform: "node", target: "node20", format: "esm",
      outbase: server, outdir: out, logLevel: "silent", external: ["@huggingface/transformers"],
      banner: { js: 'import { createRequire as __harnessRequire } from "node:module"; const require = __harnessRequire(import.meta.url);' },
    });
    const built = join(out, "drivers", "mcp-stop-probe.js");
    expect(existsSync(built), "built at the registry path").toBe(true);
    const reply = execFileSync(process.execPath, [built], { input: "not a record", encoding: "utf8", timeout: 20_000 });
    expect(JSON.parse(reply.trim()).v).toBe("unknown");
  } finally { rmSync(out, { recursive: true, force: true }); }
});
