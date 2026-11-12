// SPDX-License-Identifier: AGPL-3.0-or-later
// Lint-style guard for the key evidence rule (server/flux-key-health.ts): the low-level setters may be called only by the rule
// itself. Any other file reports through beginFluxKeyEvidence + reportFluxKeyEvidence, so a new path cannot skip the ordering.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SETTERS = /\b(noteFluxKeyRefused|noteFluxKeyAccepted|noteKeyRejected|noteKeyAccepted|noteCatalogOutcome)\b/;
const OWNERS = new Set(["server/flux-key-health.ts", "server/key-rejections.ts"]);

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name) && !/\.test\.[a-z]+$/.test(name) && !full.includes(`${join("server", "testing")}`)) out.push(full);
  }
  return out;
}

describe("key evidence has one door", () => {
  const files = ["server", "src", "shared"].flatMap(dir => sources(join(root, dir)));
  it("scans the real tree and the setters still exist where the rule keeps them", () => {
    expect(files.length).toBeGreaterThan(200);
    for (const owner of OWNERS) expect(SETTERS.test(readFileSync(join(root, owner), "utf8"))).toBe(true);
  });
  it("no file outside the rule calls a low-level setter", () => {
    const offenders = files.map(file => relative(root, file)).filter(file => !OWNERS.has(file) && SETTERS.test(readFileSync(join(root, file), "utf8")));
    expect(offenders).toEqual([]);
  });
});
