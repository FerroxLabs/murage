#!/usr/bin/env node
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// node scripts/delegation-pack-inventory.mjs [--check]
// Discover declarations in code, including new DelegationPack components; require a one-line reason.
import { globSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INVENTORY = join(ROOT, "server/delegation-pack.inventory.json");

export function inventorySources(root = ROOT) {
  const sources = new Map();
  for (const pattern of ["server/**/*.ts", "src/**/*.tsx"]) {
    for (const path of globSync(pattern, { cwd: root })) {
      if (/\.(?:test|typetest|vitest)\./.test(path)) continue;
      const source = readFileSync(join(root, path), "utf8");
      if (/DelegationPack|delegation-context|\/api\/delegation-packs/.test(source)) sources.set(path.replaceAll("\\", "/"), source);
    }
  }
  return sources;
}

export function collectInventory(sources) {
  const rows = [];
  for (const [file, source] of sources) {
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    function add(node, name, expected, value) {
      const annotation = node.getFullText(ast).match(/@delegation-pack ([\w-]+) ([^\r\n]*?)(?:\s*\*\/|\r?\n)/);
      if (!annotation || annotation[1] !== expected || !annotation[2].trim()) throw new Error(`delegation pack inventory: declare ${file}:${name}`);
      rows.push({ file, name, kind: expected, ...(value ? { value } : {}), why: annotation[2].trim() });
    }
    for (const node of ast.statements) {
      if (ts.isFunctionDeclaration(node) && node.name && /^DelegationPack[A-Z]/.test(node.name.text)) {
        const name = node.name.text;
        const kind = { DelegationPackLine: "line", DelegationPackChip: "chip", DelegationPackSheet: "sheet" }[name];
        if (!kind) throw new Error(`delegation pack inventory: declare ${file}:${name}`);
        add(node, name, kind);
      }
      if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) {
        const value = declaration.initializer;
        if (!value || !ts.isStringLiteral(value)) continue;
        const kind = value.text === "delegation-context" ? "prompt-part" : value.text.startsWith("/api/delegation-packs") ? "owner-route" : null;
        if (kind) add(node, declaration.name.getText(ast), kind, value.text);
      }
    }
  }
  return rows.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

export function checkInventory(generated, saved) {
  if (JSON.stringify(generated) !== JSON.stringify(saved)) throw new Error("delegation pack inventory is stale; run node scripts/delegation-pack-inventory.mjs");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const generated = collectInventory(inventorySources());
  if (process.argv.includes("--check")) checkInventory(generated, JSON.parse(readFileSync(INVENTORY, "utf8")));
  else writeFileSync(INVENTORY, `${JSON.stringify(generated, null, 2)}\n`);
}
