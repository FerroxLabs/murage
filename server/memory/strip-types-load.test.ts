// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GATE (1.0.18, TURNSTART L1 root cause): source runs of the server (scripts/dev-server.mjs, the memory worker forked from source by
// worker-controller.ts, every crash child in server/memory/testing/*-child.ts) load .ts files under `node --experimental-strip-types`, which
// refuses non-erasable syntax (an angle-bracket assertion `<T>x`, enums, parameter properties, namespaces). A child that cannot load dies at
// import, and a test that ignores its stderr sees only a timeout. This test (1) strips every server/ and shared/ source file the way Node does
// and (2) imports each crash child's own imports in a real `node --experimental-strip-types` process, failing with the child's stderr.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== "node_modules") sources(path, out); continue; }
    if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") && !entry.name.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

describe("GATE strip-types loadability", () => {
  it("every server/ and shared/ source file is erasable by Node's type stripping", () => {
    const files = [...sources(join(ROOT, "server")), ...sources(join(ROOT, "shared"))];
    expect(files.length).toBeGreaterThan(100);
    const refused: string[] = [];
    for (const file of files) {
      try { stripTypeScriptTypes(readFileSync(file, "utf8"), { mode: "strip" }); }
      catch (error) { refused.push(`${relative(ROOT, file)}: ${String((error as Error).message).split("\n")[0]}`); }
    }
    expect(refused).toEqual([]);
  });

  const testing = join(ROOT, "server", "memory", "testing");
  const children = readdirSync(testing).filter(name => name.endsWith("-child.ts"));
  it("there are crash children to check", () => { expect(children.length).toBeGreaterThan(0); });
  for (const child of children) {
    it(`${child}: every module it imports loads under node --experimental-strip-types (stderr surfaced)`, () => {
      const text = readFileSync(join(testing, child), "utf8");
      const targets = [...text.matchAll(/from\s+"(\.{1,2}\/[^"]+\.ts)"/g)].map(match => new URL(match[1]!, `file://${join(testing, child)}`).href);
      expect(targets.length, "relative .ts imports").toBeGreaterThan(0);
      const script = `for (const t of ${JSON.stringify(targets)}) await import(t);`;
      const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script],
        { windowsHide: true, cwd: ROOT, encoding: "utf8", timeout: 60_000, env: { ...process.env, NODE_OPTIONS: "" } });
      expect({ status: run.status, stderr: run.stderr.split("\n").slice(0, 8).join("\n") }).toEqual({ status: 0, stderr: "" });
    }, 90_000);
  }
});
