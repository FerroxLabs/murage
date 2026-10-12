// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The server and the memory helper run as TypeScript with the types stripped (node --experimental-strip-types).
// That mode cannot express parameter properties, enums or namespaces; vitest's own transform accepts them, so a file
// using one passes every test and then fails to start (it did, in three lanes: "TypeScript parameter property is not
// supported"). This strips every non-test module under server/ and shared/ the way node does.
import { readdirSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const server = fileURLToPath(new URL("..", import.meta.url));
const root = join(server, "..");

function modules(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== "node_modules" && entry.name !== "testdata") out.push(...modules(path)); }
    else if (/\.(ts|mts)$/.test(entry.name) && !/\.d\.m?ts$/.test(entry.name) && !/\.test\.m?ts$/.test(entry.name)) out.push(path);
  }
  return out;
}

it("every module under server/ and shared/ can be run with types stripped", () => {
  const files = [...modules(server), ...modules(join(root, "shared"))];
  expect(files.length).toBeGreaterThan(400);
  const refused: string[] = [];
  for (const file of files) {
    try { stripTypeScriptTypes(readFileSync(file, "utf8"), { mode: "strip" }); }
    catch (error) { refused.push(`${relative(root, file)}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  expect(refused).toEqual([]);
});
