// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanBotPackageForImport } from "./bot-package-guard.ts";

// What we ship must pass our own guard. Unsigned for now, so each one gets the full scan.
const root = fileURLToPath(new URL("../", import.meta.url));
const files = ["library/packages", "library/assistants", "bot-library/builtins"].flatMap((dir) =>
  readdirSync(join(root, dir)).filter((name) => name.endsWith(".json") && !name.startsWith(".")).map((name) => join(dir, name)));

describe("shipped teams and bots pass the import guard", () => {
  it("finds the shipped files", () => { expect(files.length).toBeGreaterThan(50); });
  it.each(files)("%s is not blocked and needs no review", (file) => {
    const result = scanBotPackageForImport([{ path: "manifest.json", content: readFileSync(join(root, file), "utf8") }]);
    const report = result.findings.filter((f) => f.message).map((f) => `${f.severity} ${f.field}:${f.line} ${f.message} | ${f.evidence}`);
    expect(result.blocked, report.join("\n")).toBe(false);
    expect(report).toEqual([]);
  });
});
