import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const allowedLicences = new Set(["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "MIT-0", "(MIT OR EUPL-1.1+)"]);
const mailDependencies = ["imapflow", "nodemailer", "mailparser"];
type ImporterDependency = { specifier: string; version: string };
type Edges = { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
type Package = { resolution?: { integrity?: string }; hasInstallScript?: boolean; requiresBuild?: boolean };
type Lock = {
  lockfileVersion: string;
  importers: Record<string, { dependencies: Record<string, ImporterDependency> }>;
  packages: Record<string, Package>;
  snapshots: Record<string, Edges>;
};
type Review = {
  version: string;
  integrity: string;
  licence: string;
  installScript: boolean;
  maintainers: string[];
  reviewer: string;
  date: string;
};

function checkReview(dependencies: Record<string, string>, lock: Lock, reviews: Record<string, Review>) {
  expect(lock.lockfileVersion).toBe("9.0");
  const pending = mailDependencies.map(name => {
    const pin = dependencies[name];
    expect(pin, `exact pin for ${name}`).toMatch(/^\d+\.\d+\.\d+$/);
    const entry = lock.importers["."].dependencies[name];
    expect(entry, `lockfile pin for ${name}`).toEqual({ specifier: pin, version: pin });
    return `${name}@${pin}`;
  });

  const visited = new Set<string>();
  const reviewed = new Set<string>();
  for (const id of pending) {
    if (visited.has(id)) continue;
    visited.add(id);
    const pkgId = id.split("(")[0];
    const pkg = lock.packages[pkgId];
    const snapshot = lock.snapshots[id];
    expect(pkg?.resolution?.integrity, `lockfile integrity for ${pkgId}`).toMatch(/^sha512-/);
    expect(snapshot, `lockfile snapshot for ${id}`).toBeDefined();
    const review = reviews[pkgId];
    expect(review, `missing review for ${pkgId}`).toBeDefined();
    expect(review.version, pkgId).toBe(pkgId.slice(pkgId.lastIndexOf("@") + 1));
    expect(review.integrity, pkgId).toBe(pkg.resolution!.integrity);
    expect(allowedLicences.has(review.licence), `licence for ${pkgId}`).toBe(true);
    expect(review.maintainers.length, `maintainers for ${pkgId}`).toBeGreaterThan(0);
    expect(review.maintainers, pkgId).toEqual(review.maintainers.map(() => expect.stringMatching(/\S/)));
    expect(review.reviewer, pkgId).toMatch(/\S/);
    expect(review.date, pkgId).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(review.installScript, pkgId).toBe(false);
    expect(Boolean(pkg.hasInstallScript || pkg.requiresBuild), `install script for ${pkgId}`).toBe(false);
    reviewed.add(pkgId);
    const edges = { ...snapshot.dependencies, ...snapshot.optionalDependencies };
    for (const [name, version] of Object.entries(edges)) pending.push(`${name}@${version}`);
  }
  expect([...reviewed].sort()).toEqual(Object.keys(reviews).sort());
}

function inputs() {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  return {
    dependencies: JSON.parse(read("../../package.json")).dependencies as Record<string, string>,
    lock: parse(read("../../pnpm-lock.yaml")) as Lock,
    reviews: JSON.parse(read("./DEPS-REVIEW.json")) as Record<string, Review>,
  };
}

describe("mail dependency qualification", () => {
  it("D1a/D1b exactly pins and reviews every reachable dependency", () => {
    const { dependencies, lock, reviews } = inputs();
    checkReview(dependencies, lock, reviews);
  });

  it("D1b2 rejects an install script in the reachable lockfile graph", () => {
    const { dependencies, lock, reviews } = inputs();
    checkReview(dependencies, lock, reviews);
    lock.packages[`imapflow@${dependencies.imapflow}`].hasInstallScript = true;
    expect(() => checkReview(dependencies, lock, reviews)).toThrow(/install script for imapflow/);
  });
});
