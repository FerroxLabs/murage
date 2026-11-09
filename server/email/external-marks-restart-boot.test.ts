// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// B3 follow-ups (NLINT s6): the test-only restart hook refuses to run outside vitest (so no product path can clear the store latch),
// and production wires the outside store exactly once, unconditionally, at boot.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { fileOutsideStore } from "../outside-store.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import * as marks from "./external-marks.ts";

let root = "";
beforeEach(() => { marks.restartOutsideForTests(); root = mkdtempSync(join(tmpdir(), "murage-b3-boot-")); });
afterEach(() => { marks.restartOutsideForTests(); removeTempDirSync(root); });

const outsideVitest = (run: () => void) => {
  const saved = process.env.VITEST;
  delete process.env.VITEST;
  try { run(); } finally { if (saved !== undefined) process.env.VITEST = saved; }
};

describe("restartOutsideForTests guard", () => {
  // Mutant: remove the VITEST guard line; the throw expectation below goes red.
  it("throws outside vitest and leaves a raised latch raised", () => {
    const file = join(root, "outside-state.jsonl");
    marks.noteStoreFailure();
    outsideVitest(() => expect(() => marks.restartOutsideForTests()).toThrow("tests only"));
    expect(marks.wireOutsideStore(fileOutsideStore(file))).toBe(false);
  });
  it("control: under vitest it clears the latch and the store wires ready", () => {
    const file = join(root, "outside-state.jsonl");
    marks.noteStoreFailure();
    expect(() => marks.restartOutsideForTests()).not.toThrow();
    expect(marks.wireOutsideStore(fileOutsideStore(file))).toBe(true);
  });
});

describe("boot wiring of the outside store", () => {
  const productionSources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "testing" ? [] : productionSources(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
  // Mutant: comment out or guard the index.ts call (an if, a function body); the first two expectations go red.
  it("production wires once, as an unconditional top-level statement of server/index.ts", () => {
    const server = fileURLToPath(new URL("..", import.meta.url));
    const callers = productionSources(server).filter((path) => /\bwireOutsideStore\(/.test(readFileSync(path, "utf8").replace(/^import .*$/gm, "")) && !path.endsWith("external-marks.ts"));
    expect(callers.map((path) => relative(server, path).split("\\").join("/"))).toEqual(["index.ts"]);
    const source = readFileSync(join(server, "index.ts"), "utf8").replace(/\r\n/g, "\n");
    expect(source.match(/\bwireOutsideStore\(/g)?.length).toBe(1);
    // Parsed, not matched: an `if (...) { wireOutsideStore(...) }` wrapper keeps the text but is no longer a top-level statement.
    const tree = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
    const topLevel = tree.statements.filter((statement) => ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) && statement.expression.expression.getText(tree) === "wireOutsideStore");
    expect(topLevel).toHaveLength(1);
    expect(source).toMatch(/^wireOutsideStore\(fileOutsideStore\(join\(DATA_DIR, "outside-state\.jsonl"\)\)\);$/m);
  });
  it("an empty data folder boots ready, and a second boot keeps the first outsideSince", () => {
    removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    const file = join(DATA_DIR, "outside-state.jsonl");
    expect(marks.wireOutsideStore(fileOutsideStore(file))).toBe(true);
    expect(marks.outsideReady()).toBe(true);
    const since = marks.outsideSince();
    expect(since).toBeTypeOf("number");
    marks.restartOutsideForTests();
    expect(marks.wireOutsideStore(fileOutsideStore(file))).toBe(true);
    expect(marks.outsideSince()).toBe(since);
  });
  it("a data folder that is missing fails closed", () => {
    expect(marks.wireOutsideStore(fileOutsideStore(join(root, "missing", "outside-state.jsonl")))).toBe(false);
    expect(marks.outsideReady()).toBe(false);
  });
});
