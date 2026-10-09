// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Security floors from OpenMausBot #2448 (Apache-2.0): patched dompurify and a
// mermaid that no longer pulls the vulnerable lodash-es copy.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const atLeast = (version, floor) => {
  const a = version.split(".").map(Number), b = floor.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};

it("pins dompurify at 3.4.16 or newer in the manifest, the workspace override and the lockfile", () => {
  const pkg = JSON.parse(read("package.json"));
  expect(atLeast(pkg.dependencies.dompurify, "3.4.16")).toBe(true);
  expect(read("pnpm-workspace.yaml")).toMatch(/^\s*dompurify:\s*3\.4\.(1[6-9]|[2-9]\d)\s*$/m);
  const versions = [...read("pnpm-lock.yaml").matchAll(/^ {2}dompurify@(\d+\.\d+\.\d+):/gm)].map((m) => m[1]);
  expect(versions.length).toBeGreaterThan(0);
  for (const v of versions) expect(atLeast(v, "3.4.16")).toBe(true);
});

it("uses mermaid 12.1 or newer and no longer locks lodash-es 4.17.23", () => {
  const pkg = JSON.parse(read("package.json"));
  expect(atLeast(pkg.dependencies.mermaid.replace(/^[\^~]/, ""), "12.1.0")).toBe(true);
  expect(read("pnpm-lock.yaml")).not.toContain("lodash-es@4.17.23");
});
