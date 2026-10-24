// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Codex custom-MCP env launcher (codex.ts MCP_ENV_LAUNCHER) on every OS: a colliding value rides the environment under a
// private alias, never the argv; the launcher restores it under the server's own name for the one child, removes the alias, and
// runs a command whose path has spaces. The launcher text is read from the source, so this proves what ships.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("./codex.ts", import.meta.url)), "utf8");
const literal = /const MCP_ENV_LAUNCHER = (\[[\s\S]*?\])\.join\(""\);/.exec(source);
const LAUNCHER: string = literal ? new Function(`return ${literal[1]}.join("")`)() : "";
const MARK = /const MCP_ENV_LAUNCHER_MARK = "([^"]+)"/.exec(source)?.[1] ?? "";
const ALIAS = "MURAGE_MCPV_0123456789abcdef";
const SECRET = "secret-value-for-two";

it("codex mcp env launcher: restores the alias under the server's own name, removes it, keeps the value off argv, handles spaces", () => {
  expect(LAUNCHER).not.toBe("");
  const dir = mkdtempSync(join(tmpdir(), "launcher with spaces-"));
  const probe = join(dir, "probe script.mjs");
  writeFileSync(probe, "process.stdout.write(JSON.stringify({ token: process.env.NOTES_TOKEN, alias: process.env.MURAGE_MCPV_0123456789abcdef ?? null, runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null, arg: process.argv[2] }));");
  const args = ["-e", LAUNCHER, MARK, JSON.stringify({ NOTES_TOKEN: ALIAS }), process.execPath, probe, "an arg with spaces"];
  expect(args.join("\n")).not.toContain(SECRET);
  const run = spawnSync(process.execPath, args, { env: { ...process.env, [ALIAS]: SECRET, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8" });
  expect(run.status, run.stderr).toBe(0);
  expect(JSON.parse(run.stdout)).toEqual({ token: SECRET, alias: null, runAsNode: null, arg: "an arg with spaces" });
});

it("codex mcp env launcher: a missing command exits non-zero instead of hanging", () => {
  const run = spawnSync(process.execPath, ["-e", LAUNCHER, MARK, "{}", "definitely-not-a-real-command-murage"], { env: process.env, encoding: "utf8", timeout: 20000 });
  expect(run.status).not.toBe(0);
});

// Windows: a command with no direct match (a .cmd shim on PATH, as npx is) is found by the launcher's shell fallback, with a
// path and an argument that hold spaces, and still gets the restored value without the alias.
it.runIf(process.platform === "win32")("codex mcp env launcher: the cmd fallback runs a .cmd shim on PATH with spaces in its path and argument", () => {
  const dir = mkdtempSync(join(tmpdir(), "shim with spaces-"));
  writeFileSync(join(dir, "murageshim.cmd"), "@echo off\r\necho token=%NOTES_TOKEN%\r\necho alias=%MURAGE_MCPV_0123456789abcdef%\r\necho arg=%~1\r\n");
  const env = { ...process.env, [ALIAS]: SECRET, PATH: `${dir};${process.env.PATH ?? ""}` };
  const run = spawnSync(process.execPath, ["-e", LAUNCHER, MARK, JSON.stringify({ NOTES_TOKEN: ALIAS }), "murageshim", "an arg with spaces"], { env, encoding: "utf8", timeout: 30000 });
  expect(run.status, run.stderr).toBe(0);
  expect(run.stdout).toContain(`token=${SECRET}`);
  expect(run.stdout).toContain("alias=%MURAGE_MCPV_0123456789abcdef%");
  expect(run.stdout).toContain("arg=an arg with spaces");
});
