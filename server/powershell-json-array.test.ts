// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const excluded = new Set(["node_modules", ".git", "dist", "build", "dist-native", "evidence", "lane-evidence"]);

function unsafeEnvJsonParses(script: string): string[] {
  // On Windows PowerShell 5.1 ConvertFrom-Json writes an array as one object.
  // Enumerate it inside @(), before either counting or consuming the paths.
  const unwrapped = [...script.matchAll(/@\(\(\s*\$env:\w+\s*\|\s*ConvertFrom-Json\s*\)\s*\|\s*ForEach-Object\s*\{\s*\$_\s*\}\s*\)/gi)];
  return [...script.matchAll(/\$env:\w+\s*\|\s*ConvertFrom-Json\b/gi)]
    .filter(parse => !unwrapped.some(safe => safe.index! <= parse.index! && safe.index! + safe[0].length >= parse.index! + parse[0].length))
    .map(parse => parse[0]);
}

function embeddedParsers(dir: string): Array<{ file: string; script: string }> {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return excluded.has(entry.name) || entry.name.startsWith(".") ? [] : embeddedParsers(path);
    if (!entry.isFile() || !/\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name) || /\.(?:test|node-test|spec)\./.test(entry.name)) return [];
    const source = readFileSync(path, "utf8");
    if (!source.includes("ConvertFrom-Json")) return [];
    const scripts: Array<{ file: string; script: string }> = [];
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
        const script = ts.isTemplateExpression(node) ? node.getText() : node.text;
        if (/\$env:\w+\s*\|\s*ConvertFrom-Json/i.test(script)) scripts.push({ file: relative(root, path).split("\\").join("/"), script });
      }
      ts.forEachChild(node, visit);
    };
    visit(ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true));
    return scripts;
  });
}

it("rejects PS 5.1 nested arrays even when enumeration happens outside @()", () => {
  const parse = "$env:FIXTURE_PATHS | ConvertFrom-Json";
  expect(unsafeEnvJsonParses(`$paths = @(${parse})`)).toEqual([parse]);
  expect(unsafeEnvJsonParses(`@(${parse}) | ForEach-Object { Get-Item $_ }`)).toEqual([parse]);
  expect(unsafeEnvJsonParses(`@((${parse}) | ForEach-Object { $_ })`)).toEqual([]);
  expect(unsafeEnvJsonParses(`@((${parse}) | ForEach-Object { $_ }); @(${parse})`)).toEqual([parse]);
});

it("every embedded PowerShell env JSON array parser unwraps inside @() for PS 5.1", () => {
  const parsers = embeddedParsers(root);
  expect(parsers.map(({ file }) => file)).toEqual(expect.arrayContaining([
    "server/channels/signal/storage.ts", "server/channels/signal/service.ts",
  ]));
  expect(parsers.flatMap(({ file, script }) => unsafeEnvJsonParses(script).map(parse => `${file}: ${parse}`))).toEqual([]);
});

it("standalone Windows array readers unwrap manifests, phases and process receipts", () => {
  const readers: Record<string, number> = {
    "scripts/windows/parse-native.ps1": 1,
    "scripts/windows/job-check.ps1": 1,
    "scripts/win-gate/run-win-tests.ps1": 1,
    "scripts/windows/winbox-gate.ps1": 3,
  };
  for (const [file, count] of Object.entries(readers)) {
    const script = readFileSync(join(root, file), "utf8");
    expect(script.match(/@\(\(Get-Content[^\n]+?\| ConvertFrom-Json\) \| ForEach-Object \{ \$_ \}\)/g), file).toHaveLength(count);
    expect(script, file).not.toMatch(/@\(Get-Content[^\n]+?\| ConvertFrom-Json\)/);
  }
});
