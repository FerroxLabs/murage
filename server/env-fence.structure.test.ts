// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Section (d) of APP-GRANT-FIXPLAN-r6 (Rules 74a, 74d), structurally: env-path.ts holds the one generation and bumps
// it in one place; only engine-env.ts names the check and its result; no driver holds an F12 record at module or
// turn scope, so every record is computed when its card opens.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const server = dirname(fileURLToPath(import.meta.url));
const root = join(server, "..");
const DRIVERS = ["drivers/codex.ts", "drivers/claude.ts", "drivers/pi.ts", "drivers/acp/core.ts"];
const read = (file: string) => readFileSync(join(server, file), "utf8");
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "testing") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

const FUNCTION_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.FunctionExpression, ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration, ts.SyntaxKind.Constructor, ts.SyntaxKind.GetAccessor, ts.SyntaxKind.SetAccessor,
]);
const enclosingFunction = (node: ts.Node): ts.Node | undefined => {
  for (let at = node.parent; at; at = at.parent) if (FUNCTION_KINDS.has(at.kind)) return at;
  return undefined;
};
/** The turn scope: a function whose own body spawns the engine or hands it its environment. */
const isTurnScope = (fn: ts.Node, sf: ts.SourceFile) => /\b(spawnCli|handedEngineEnv)\(/.test(fn.getText(sf));
const lineOf = (sf: ts.SourceFile, node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

describe("environment generation structure (Rules 74a, 74d)", () => {
  it("bumps the generation once, in invalidateEnvCapture", () => {
    const envPath = stripComments(read("env-path.ts"));
    expect(envPath.match(/\bgeneration\s*(\+\+|\+=)|\+\+\s*generation\b/g)).toHaveLength(1);
    const body = envPath.slice(envPath.indexOf("export function invalidateEnvCapture("));
    expect(body.slice(0, body.indexOf("\n}\n"))).toMatch(/generation\+\+/);
    expect(envPath).toMatch(/^let generation = 0;$/m);
    // the let is module-private: no other module can move it; engine-env.ts and the drivers keep no generation of their own
    expect(envPath).not.toMatch(/export let generation/);
    for (const file of ["engine-env.ts", ...DRIVERS]) expect(stripComments(read(file)), file).not.toMatch(/\bgeneration\s*(\+\+|\+=|=[^=])/);
  });

  it("has no other way to drop the capture or the checks", () => {
    for (const file of sources(server).concat(sources(join(root, "shared")))) {
      const text = stripComments(readFileSync(file, "utf8"));
      expect(text, relative(root, file)).not.toMatch(/\b(requestOwnerEnvRecapture|resetExecEnvChecks)\b/);
    }
  });

  it("names checkExecEnv, execEnvOf and CheckResult in engine-env.ts only", () => {
    for (const file of sources(server).concat(sources(join(root, "shared")))) {
      if (file === join(server, "engine-env.ts")) continue;
      const text = stripComments(readFileSync(file, "utf8"));
      expect(text, relative(root, file)).not.toMatch(/\b(checkExecEnv|execEnvOf)\b/);
      // browser-check-state.ts has an unrelated local CheckResult of its own; no module takes engine-env's
      if (/from "(\.\.?\/)+engine-env\.ts"/.test(text)) expect(text, relative(root, file)).not.toMatch(/\bCheckResult\b/);
    }
  });

  it("every driver reports F12 through execEnvNow or execEnvHanded, called when the card opens", () => {
    for (const file of DRIVERS) {
      const sf = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const calls: number[] = [];
      const bad: string[] = [];
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && /^execEnv(Now|Handed)$/.test(node.expression.text)) {
          calls.push(lineOf(sf, node));
          const fn = enclosingFunction(node);
          if (!fn) bad.push(`${file}:${lineOf(sf, node)} at module scope`);
          else if (isTurnScope(fn, sf)) bad.push(`${file}:${lineOf(sf, node)} at turn scope`);
        }
        // no variable or property of the record (or of a check) is declared at module or turn scope
        if ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) && node.type
          && /\b(ExecEnv|CheckResult)\b/.test(node.type.getText(sf))) {
          const fn = enclosingFunction(node);
          if (!fn || isTurnScope(fn, sf)) bad.push(`${file}:${lineOf(sf, node)} holds ${node.type.getText(sf)}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
      expect(bad, file).toEqual([]);
      expect(calls.length, `${file} computes F12 per ask`).toBeGreaterThan(0);
      expect(sf.getFullText(), file).toMatch(/\bexecEnvNow\(/);
    }
  });
});

describe("every engine turn spawn is handed the pinned environment (Rule 74)", () => {
  // A spawn of the configured engine CLI (config.cli) in a driver must sit in a function that itself calls handedEngineEnv.
  // A version probe (`["--version"]`) runs no turn and is the one exemption; the one-shot review is a turn spawn like the rest.
  const TURN_DRIVERS = ["drivers/claude.ts", "drivers/codex.ts", "drivers/pi.ts", "drivers/acp/core.ts"];
  // The scope is the nearest enclosing function that calls handedEngineEnv and holds no other turn spawn: a function that
  // holds several (the driver's create) is a container, and one handed env there would cover a spawn that never saw it.
  const SPAWN = /\bspawnCli\(\s*(?:config\.cli|launchCli),(?!\s*\["--version"\])/g;
  const handedScope = (node: ts.Node, sf: ts.SourceFile): boolean => {
    for (let at = enclosingFunction(node); at; at = enclosingFunction(at)) {
      const text = at.getText(sf);
      if (/\bhandedEngineEnv\(/.test(text)) return (text.match(SPAWN) ?? []).length === 1;
    }
    return false;
  };
  it("has no config.cli spawn outside a handedEngineEnv scope", () => {
    for (const file of TURN_DRIVERS) {
      const sf = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const bad: string[] = [];
      let spawns = 0;
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "spawnCli"
          // launchCli: config.cli resolved to the file the driver's version probe ran (isolation-cache.ts engineLaunchFile)
          && ["config.cli", "launchCli"].includes(node.arguments[0]?.getText(sf) ?? "") && !/^\[\s*"--version"\s*\]$/.test(node.arguments[1]?.getText(sf) ?? "")) {
          spawns++;
          if (!handedScope(node, sf)) bad.push(`${file}:${lineOf(sf, node)} spawns the engine without handedEngineEnv`);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
      expect(bad, file).toEqual([]);
      expect(spawns, `${file} has a turn spawn`).toBeGreaterThan(0);
    }
  });
  it("launches the engine file the version probe ran, never a fresh lookup on the handed PATH", () => {
    for (const file of TURN_DRIVERS) {
      const text = read(file);
      const bound = [...text.matchAll(/\bconst launchCli = ([^;]+);/g)].map((m) => m[1]);
      expect(bound.length, `${file} binds launchCli`).toBeGreaterThan(0);
      // acp/core.ts (1.0.5 Fuigo on Windows, 9094d77a8, merged 58f2f9c46): the file is launchTarget, the driver's own choice of
      // config.cli (support.launchExecutable, e.g. the fuigo.exe resolveFuigoCli version-checked) read on the DRIVER env before the
      // handed map replaces it, and the version probe reads the same launchCliFor. Still never a lookup on the handed PATH.
      const viaTarget = /^engineLaunchFile\(launchTarget, /;
      for (const rhs of bound) expect(rhs, file).toMatch(file === "drivers/acp/core.ts" ? viaTarget : /^engineLaunchFile\(config\.cli, /);
      if (file === "drivers/acp/core.ts") {
        expect(text).toContain("const launchCliFor = (env: Record<string, string | undefined>): string => support.launchExecutable?.(env, config) ?? config.cli;");
        expect([...text.matchAll(/\bconst launchTarget = ([^;]+);/g)].map((m) => m[1]), file).toEqual(["launchCliFor(env)"]);
        // fixed before the handed map is merged into env (Object.assign(env, handed.env)), and the probe runs that same file
        expect(text.indexOf("const launchTarget = launchCliFor(env);")).toBeLessThan(text.indexOf("Object.assign(env, handed.env);"));
        expect(text.indexOf("const launchTarget = launchCliFor(env);")).toBeGreaterThan(-1);
        expect(text).toContain("const cli = launchCliFor(env);\n        const sig = cliSig(cli, env);\n        const raw = await cachedCliVersion(cli,");
      }
      expect(text, `${file} spawns a bare config.cli turn`).not.toMatch(/\bspawnCli\(\s*config\.cli,(?!\s*\["--version"\])/);
    }
  });
});
