// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The server and the memory helper run as TypeScript with the types stripped (node --experimental-strip-types).
// That mode cannot express parameter properties, enums or namespaces; vitest's own transform accepts them, so a file
// using one passes every test and then fails to start (it did: "TypeScript parameter property is not supported").
// This strips each memory module and the SQLite helpers the way node does.
import { readdirSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { expect, it } from "vitest";

const server = new URL("..", import.meta.url).pathname;
const memory = join(server, "memory");
const files = [
  ...readdirSync(memory).filter(name => name.endsWith(".ts") && !name.endsWith(".test.ts")).map(name => join(memory, name)),
  ...["database.ts", "observe.ts", "sqlite-checkpoint.ts", "io-budget.ts", "early-bundle.ts"].map(name => join(server, name)),
];

it("every memory module and SQLite helper can be run with types stripped", () => {
  expect(files.length).toBeGreaterThan(60);
  const refused: string[] = [];
  for (const file of files) {
    try { stripTypeScriptTypes(readFileSync(file, "utf8"), { mode: "strip" }); }
    catch (error) { refused.push(`${file.slice(server.length)}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  expect(refused).toEqual([]);
});
