// File tripwire only. The per-engine D3-e/D3-f tests are the guarantee.
// A launcher passed under an unrecognized name can escape this text scan.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { launchDispositions } from "./testing/launch-dispositions.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const scan = (root = resolve(".")) => execFileSync("bash", [resolve("scripts/marks-launch-sites.sh"), root], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
const turnFiles = ["drivers/cli-memory-learning.ts", "drivers/acp/cline.ts", "drivers/acp/cursor.ts", "drivers/acp/custom.ts", "drivers/acp/droid.ts", "drivers/acp/fuigo.ts", "drivers/acp/gemini.ts", "drivers/acp/grok.ts", "drivers/acp/hermes.ts", "drivers/acp/kimi.ts", "drivers/acp/openclaw.ts", "drivers/acp/opencode-go.ts", "drivers/acp/qwen.ts", "drivers/claude.ts", "drivers/codex.ts", "drivers/acp/core.ts", "drivers/antigravity.ts", "drivers/pi.ts", "drivers/headless-text-only.ts", "procs.ts", "host-power.ts", "drivers/chat-mcp-client.ts", "drivers/openai-chat.ts"];
it("R16-a every scanned file has exactly one disposition and every row has a file", () => {
  const files = scan();
  expect(launchDispositions.map(row => row.file).sort()).toEqual(files);
  expect(new Set(launchDispositions.map(row => row.file)).size).toBe(launchDispositions.length);
  for (const row of launchDispositions) {
    expect(["TURN", "PROBE", "NOT-ENGINE"]).toContain(row.kind);
    expect(row.reason.trim()).not.toBe("");
    expect(row.reason).not.toContain("\n");
  }
  for (const file of turnFiles) {
    expect(files).toContain(`server/${file}`);
    expect(launchDispositions.find(row => row.file === `server/${file}`)?.kind).toBe("TURN");
  }
  for (const file of ["channels/whatsapp/bridge-host.ts", "installation-windows-backup-transport.ts", "cloud-home/ui-canary-browser.ts", "memory/worker-controller.ts"]) expect(files).toContain(`server/${file}`);
});
it("R16-d recognizes injected launchers, any receiver, imports and wrapper imports", () => {
  const root = mkdtempSync(join(tmpdir(), "marks-inventory-"));
  try {
    mkdirSync(join(root, "server"));
    const sources = ["deps.spawn('x')", "spawner.spawn('x')", "dependencies.spawn('x')", "this.spawn('x')", "deps.execFile('x')", 'import { spawnCli as launch } from "./procs.ts";', 'import cp from "node:child_process";', 'const cp = require("child_process");', 'const cp = import("node:child_process");', 'export { spawn } from "child_process";', 'class Host { private forkFn: Fork; }', 'function host(nodeFork = injected) {}'];
    sources.forEach((source, i) => writeFileSync(join(root, "server", `${i}.ts`), source));
    writeFileSync(join(root, "server", "none.ts"), "const executable = 1; const executableTarget = 2; const executor = 3; const execution = 4; regex.exec('x');");
    writeFileSync(join(root, "server", "ignored.test.ts"), sources[0]!);
    writeFileSync(join(root, "server", "ignored.d.ts"), sources[0]!);
    expect(scan(root)).toEqual(sources.map((_, i) => `server/${i}.ts`).sort());
  } finally { removeTempDirSync(root); }
});
it("R16-d committed D5 file list matches fresh generation", () => {
  const generated = execFileSync("bash", [resolve("scripts/marks-gen-d5-files.sh"), resolve(".")], { encoding: "utf8" });
  expect(readFileSync(resolve("d5-files.txt"), "utf8")).toBe(generated);
});
