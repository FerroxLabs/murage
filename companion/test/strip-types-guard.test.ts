// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The companion sidecar runs under node strip-only TypeScript. A constructor parameter property
// (`constructor(private x: T)`) is accepted by tsc but makes the sidecar exit at boot with
// ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX, so the phone door never comes up.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

const PARAM_PROPERTY = /\bconstructor\s*\(([^)]*)\)/gs;
const MODIFIER = /(^|,)\s*(?:@\w+(?:\([^)]*\))?\s*)*(public|private|protected|readonly)\s/;

describe("companion sources are strip-types clean", () => {
  it("has no constructor parameter property in companion/src", () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(PARAM_PROPERTY)) {
        if (MODIFIER.test(m[1])) offenders.push(`${file}: constructor(${m[1].trim().slice(0, 60)})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the matcher catches the forms it exists for", () => {
    for (const bad of ["private readonly a: X", "a: X, public b: Y", "readonly a: X", "protected a = 1"]) {
      expect(MODIFIER.test(bad), bad).toBe(true);
    }
    for (const ok of ["a: X, b: Y", "deps: { readonlyFlag: boolean }", ""]) expect(MODIFIER.test(ok), ok).toBe(false);
  });
});
