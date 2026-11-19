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
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { windowsHidePrelude } from "../../shared/win-hide-child-process.mjs";

const source = readFileSync(fileURLToPath(new URL("./codex.ts", import.meta.url)), "utf8");
const literal = /const MCP_ENV_LAUNCHER = (\[[\s\S]*?\])\.join\(""\);/.exec(source);
const LAUNCHER: string = literal ? new Function('windowsHidePrelude', `return ${literal[1]}.join("")`)(windowsHidePrelude) : "";
const MARK = /const MCP_ENV_LAUNCHER_MARK = "([^"]+)"/.exec(source)?.[1] ?? "";
const ALIAS = "MURAGE_MCPV_0123456789abcdef";
const SECRET = "secret-value-for-two";

it.each([false, true])('codex mcp env launcher hides the executed child (Windows fallback: %s)', fallback => {
  const calls: unknown[][] = [];
  const nativeCalls: Array<Record<string, unknown>> = [];
  const errors: Array<(error: {code: string}) => void> = [];
  class FixtureChild {
    spawn(options: Record<string, unknown>) { nativeCalls.push(options); }
    on(event: string, handler: (error: {code: string}) => void) { if (event === 'error') errors.push(handler); }
    kill() {}
  }
  const childProcess = {
    ...Object.fromEntries(['spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork'].map(name => [name, () => { throw new Error(`unexpected ${name}`); }])),
    ChildProcess: FixtureChild,
    spawn(...args: unknown[]) {
      calls.push(args);
      const child = new FixtureChild();
      const options = args.at(-1) as {env: Record<string, string>};
      child.spawn({...options, envPairs: Object.entries(options.env).map(([key, value]) => `${key}=${value}`)});
      return child;
    },
  };
  const preloadPath = fileURLToPath(new URL('../../shared/win-hide-child-process.cjs', import.meta.url));
  const scope = {
    require: (name: string) => {
      if (name === 'node:module') return {syncBuiltinESMExports: () => {}};
      expect(name).toBe('node:child_process');
      return childProcess;
    },
    process: {argv: ['node', MARK, JSON.stringify({NOTES_TOKEN: ALIAS}), 'a command', 'an arg'],
      env: {[ALIAS]: SECRET, ELECTRON_RUN_AS_NODE: '1'}, platform: 'win32', execArgv: [] as string[], on: () => {},
      binding: () => ({spawn: () => { throw new Error('unexpected synchronous spawn'); }}),
      getBuiltinModule: (name: string) => { expect(name).toBe('node:worker_threads'); return {Worker: class {}}; },
      exit: () => { throw new Error('unexpected exit'); }},
    console,
  };
  // A real eval descendant runs its inherited CJS preload before this body.
  // Execute that same installer, then observe its native-boundary hook.
  runInNewContext(`(function(require, module, __filename) {${readFileSync(preloadPath, 'utf8')}\n})(require, {exports: {}}, ${JSON.stringify(preloadPath)});`, scope);
  runInNewContext(LAUNCHER, scope);
  if (fallback) errors[0]({code: 'ENOENT'});
  expect(calls).toHaveLength(fallback ? 2 : 1);
  expect(nativeCalls).toHaveLength(calls.length);
  for (const native of nativeCalls) expect(native).toMatchObject({windowsHide: true});
  for (const call of calls) {
    expect(call.at(-1)).toMatchObject({stdio: 'inherit', env: {NOTES_TOKEN: SECRET}});
    expect((call.at(-1) as {env: object}).env).not.toHaveProperty(ALIAS);
    expect((call.at(-1) as {env: object}).env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
    expect((call.at(-1) as {env: {NODE_OPTIONS: string}}).env.NODE_OPTIONS).toContain('win-hide-child-process.cjs');
  }
  if (fallback) expect(calls[1]).toEqual(['"a command" "an arg"', expect.objectContaining({shell: true})]);
  else expect(calls[0].slice(0, 2)).toEqual(['a command', ['an arg']]);
});

it('codex mcp env launcher refuses a Windows descendant with no inherited preload', () => {
  expect(() => runInNewContext(LAUNCHER, {process: {platform: 'win32'}})).toThrow('Missing Windows hide preload');
});

it("codex mcp env launcher: restores the alias under the server's own name, removes it, keeps the value off argv, handles spaces", () => {
  expect(LAUNCHER).not.toBe("");
  const dir = mkdtempSync(join(tmpdir(), "launcher with spaces-"));
  const probe = join(dir, "probe script.mjs");
  writeFileSync(probe, "process.stdout.write(JSON.stringify({ token: process.env.NOTES_TOKEN, alias: process.env.MURAGE_MCPV_0123456789abcdef ?? null, runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null, arg: process.argv[2] }));");
  const args = ["-e", LAUNCHER, MARK, JSON.stringify({ NOTES_TOKEN: ALIAS }), process.execPath, probe, "an arg with spaces"];
  expect(args.join("\n")).not.toContain(SECRET);
  const run = spawnSync(process.execPath, args, { windowsHide: true, env: { ...process.env, [ALIAS]: SECRET, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8" });
  expect(run.status, run.stderr).toBe(0);
  expect(JSON.parse(run.stdout)).toEqual({ token: SECRET, alias: null, runAsNode: null, arg: "an arg with spaces" });
});

it("codex mcp env launcher: a missing command exits non-zero instead of hanging", () => {
  const run = spawnSync(process.execPath, ["-e", LAUNCHER, MARK, "{}", "definitely-not-a-real-command-murage"], { windowsHide: true, env: process.env, encoding: "utf8", timeout: 20000 });
  expect(run.status).not.toBe(0);
});

// Windows: a command with no direct match (a .cmd shim on PATH, as npx is) is found by the launcher's shell fallback, with a
// path and an argument that hold spaces, and still gets the restored value without the alias.
it.runIf(process.platform === "win32")("codex mcp env launcher: the cmd fallback runs a .cmd shim on PATH with spaces in its path and argument", () => {
  const dir = mkdtempSync(join(tmpdir(), "shim with spaces-"));
  writeFileSync(join(dir, "murageshim.cmd"), "@echo off\r\necho token=%NOTES_TOKEN%\r\nif defined MURAGE_MCPV_0123456789abcdef (echo alias=present) else (echo alias=absent)\r\necho arg=%~1\r\n");
  const env = { ...process.env, [ALIAS]: SECRET, PATH: `${dir};${process.env.PATH ?? ""}` };
  const run = spawnSync(process.execPath, ["-e", LAUNCHER, MARK, JSON.stringify({ NOTES_TOKEN: ALIAS }), "murageshim", "an arg with spaces"], { windowsHide: true, env, encoding: "utf8", timeout: 30000 });
  expect(run.status, run.stderr).toBe(0);
  expect(run.stdout).toContain(`token=${SECRET}`);
  // (inside a batch file an undefined %VAR% expands to nothing, so the shim asks `if defined` instead of echoing it)
  expect(run.stdout).toContain("alias=absent");
  expect(run.stdout).toContain("arg=an arg with spaces");
});
