// The generated catalog and its generator must not drift.
//
// scripts/build-local-catalog.mjs writes library/catalog.json from committed
// sources; the file is committed so staleness is reviewable in a diff. Edit a
// package and forget to regenerate and this fails in the same commit — without
// it the shipped catalog quietly stops describing the shipped packages, which
// is how a "the library says eleven skills, six landed" bug gets made.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { LOCAL_CATALOG_FILE, buildLocalCatalog, localCatalogSources, renderLocalCatalog } from "./build-local-catalog.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe("build-local-catalog", () => {
  it("reproduces the committed library/catalog.json byte for byte", () => {
    const { catalog } = buildLocalCatalog(repoRoot);
    expect(readFileSync(join(repoRoot, LOCAL_CATALOG_FILE), "utf8")).toBe(renderLocalCatalog(catalog));
  });

  it("reads one source per catalog entry, and only committed ones", () => {
    const { catalog, dangling } = buildLocalCatalog(repoRoot);
    expect(localCatalogSources(repoRoot)).toHaveLength(catalog.teams.length);
    // Every skill id every source declares is shipped. A non-empty list here
    // means some entry would install fewer skills than its card promises.
    expect(dangling).toEqual([]);
  });

  it("refuses a source whose package id is not its filename", () => {
    // The generator is the only place slug and document are bound together; a
    // mismatch here would put one entry's bots behind another entry's button.
    const fixture = mkdtempSync(join(tmpdir(), "murage-catalog-src-"));
    try {
      mkdirSync(join(fixture, "library", "packages"), { recursive: true });
      writeFileSync(
        join(fixture, "library", "packages", "not-my-name.json"),
        readFileSync(join(repoRoot, "library", "assistants", "beacon.json"), "utf8"),
      );
      expect(() => buildLocalCatalog(fixture)).toThrow(/does not match its filename/);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
