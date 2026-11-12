// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lint (UX-L2C-PAUSE r4 2.2, Grok H1): every server source that reaches Flux declares in flux-admission.ts whether it is
// `entitled` (an in-process call inside an admitted turn), `admits` (a start), `child` (an engine child process) or `none` (no billable request of its own).
// A new call site without a declaration fails here, like flux-memory-headers.lint.test.ts does for the headers.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { FLUX_ADMISSION } from "./flux-admission.ts";

const SERVER = dirname(fileURLToPath(import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "testing" ? [] : sources(path);
    return /\.(ts|mjs)$/.test(entry.name) && !/\.(test|spec)\.|\.d\.ts$|\.fixture\./.test(entry.name) ? [path] : [];
  });
}

/** The same reach test as flux-memory-headers.lint.test.ts. */
const REACHES_FLUX = (text: string): boolean =>
  /api\.fluxrouter\.ai|FLUX_OPENAI_BASE|FLUX_RESPONSES_BASE|FLUX_ANTHROPIC_BASE|\bfluxKey\(/.test(text)
  || (/flux/i.test(text) && /fetch\(|fetchImpl|fetcher|\.fetch\b|new WebSocket|WebSocket\(/.test(text));

const files = sources(SERVER).map((path) => ({ rel: relative(SERVER, path).split("\\").join("/"), text: readFileSync(path, "utf8") }));
const reaching = files.filter((file) => REACHES_FLUX(file.text));

describe("every Flux call site declares how it meets the spend gate", () => {
  it("has a declaration for every file that reaches Flux", () => {
    const undeclared = reaching.filter((file) => !(file.rel in FLUX_ADMISSION)).map((file) => file.rel);
    expect(undeclared, "add these to FLUX_ADMISSION (flux-admission.ts) as entitled, admits or none").toEqual([]);
  });
  it("keeps the declarations honest: a declared file still exists and still reaches Flux, and says why", () => {
    const names = new Set(reaching.map((file) => file.rel));
    expect(Object.keys(FLUX_ADMISSION).filter((name) => !names.has(name)), "remove these from FLUX_ADMISSION").toEqual([]);
    expect(Object.entries(FLUX_ADMISSION).filter(([, entry]) => !entry.why.trim()).map(([name]) => name)).toEqual([]);
  });
  it("a file that declares `admits` or `entitled` really calls authorizeFluxDispatch(); `child` and `none` need not", () => {
    const liars = Object.entries(FLUX_ADMISSION)
      .filter(([, entry]) => entry.kind === "admits" || entry.kind === "entitled")
      .filter(([name]) => !/\bauthorizeFluxDispatch\(/.test(files.find((file) => file.rel === name)?.text ?? ""))
      .map(([name]) => name);
    expect(liars, "these say `admits` or `entitled` but never call authorizeFluxDispatch()").toEqual([]);
  });
  it("uses only the four kinds", () => {
    for (const entry of Object.values(FLUX_ADMISSION)) expect(["entitled", "admits", "child", "none"]).toContain(entry.kind);
  });
});
