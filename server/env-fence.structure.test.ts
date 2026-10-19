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
