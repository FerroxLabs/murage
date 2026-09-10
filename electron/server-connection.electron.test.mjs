import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { launchVerificationServer } from "../scripts/control-murage.ts";

test("native server connection uses the real browser door and isolated fake engine", { timeout: 90_000 }, async () => {
  const evidence = mkdtempSync(join(tmpdir(), "murage-server-window-proof-"));
  const engine = await launchVerificationServer();
  console.log(JSON.stringify({ evidence, engine: engine.info }));
  try {
    const entry = join(evidence, "fixture.mjs");
    await build({ entryPoints: [new URL("./fixtures/server-connection.mjs", import.meta.url).pathname], outfile: entry, bundle: true, platform: "node", format: "esm", external: ["electron"] });
    const child = spawn(createRequire(import.meta.url)("electron"), [entry], { env: { PATH: process.env.PATH, HOME: evidence, TMPDIR: tmpdir(), MURAGE_CONNECTION_EVIDENCE: evidence, MURAGE_FIXTURE_HARNESS: engine.info.url }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", data => { output += data; });
    child.stderr.on("data", data => { output += data; });
    const timeout = setTimeout(() => child.kill("SIGTERM"), 60_000);
    const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
    clearTimeout(timeout);
    assert.equal(code, 0, output);
    assert.match(output, /SERVER_CONNECTION_NATIVE_PASS/);
    console.log(output);
  } finally { await engine.close(); }
});
