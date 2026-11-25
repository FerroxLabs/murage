// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MEMORY V2 lane W: W-COMMIT (design 3.1: "a static list of every COMMIT site in server/** plus a runtime test per site that the subscriber
// runs with no timer"), the static half and the coverage check of the run-time half.
//   1. testing/commit-sites.txt is exactly the list of call sites the TypeScript parser finds (testing/commit-site-scan.ts), one line per
//      site as `file:line:column function#k kind`: a new, removed or moved site fails here until the list is edited on purpose.
//   2. every committing site (commit, release, or a `nested ? RELEASE : COMMIT` choice) has exactly one driver in testing/site-drivers/,
//      and every driver names a site that exists. Each driver calls the site's own production entry point on the real main connection, and
//      its wake-sites-*.test.ts asserts the notice from that file:line once per commit and never on a rollback (testing/commit-site-harness.ts).
//      A site inside embedded worker source runs on the worker's own connection, so its driver is `conn: "own"`.
//   3. each site outside embedded worker text has a mutant (testing/commit-site-mutant.ts, run by commit-site-mutants.sh) that removes
//      exactly that site's call from the observer's view; its receipt is its driver failing at the site assertion of the harness.
//   4. no product code calls exec or prepare around the instrumented method, the one way an end could escape both the observer and this list.
// Round 3 replaced round 2's replay of each file's end statements on a fixture connection (deduplicated by text): every site is now run
// through its own entry, which that replay did not do.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SiteDriver } from "./testing/commit-site-harness.ts";
import { mutateSite, scanBypassForms, scanCommitSites, scanFile, siteEntry, siteId } from "./testing/commit-site-scan.ts";

const SERVER = join(import.meta.dirname, "..");
const LIST = join(import.meta.dirname, "testing", "commit-sites.txt");
const DRIVER_DIR = join(import.meta.dirname, "testing", "site-drivers");

describe("W-COMMIT: the static list of every transaction-ending call site, and a real-entry driver for each committing one", () => {
  const sites = scanCommitSites(SERVER);

  it("commit-sites.txt is exactly the sites the parser finds (file:line:column function#k kind)", () => {
    const listed = readFileSync(LIST, "utf8").split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("#"));
    expect(sites.length).toBeGreaterThan(200);
    expect(sites.map(siteEntry)).toEqual(listed);
  });

  it("the parser finds the forms a line scan misses: a call split over lines, a choice, a named const, embedded worker source", () => {
    const ids = new Set(sites.map(siteId));
    expect(ids).toContain("database.ts transaction#1"); // nested ? `RELEASE ${point}` : "COMMIT"
    expect(sites.filter(site => site.embedded && site.kind === "commit").length).toBeGreaterThan(5);
    expect(sites.some(site => site.file === "memory/optional-index.ts" && site.text === "buildSql")).toBe(true); // a const holding the text
  });

  it("no product code reaches exec or prepare around the instrumented method (.call, .apply, a bracket lookup)", () => {
    expect(scanBypassForms(SERVER)).toEqual([]);
  });

  it("every committing site outside embedded worker text has its mutant, and it removes exactly that site's own call", () => {
    const ids = new Set(sites.map(siteId));
    for (const site of sites.filter(candidate => candidate.kind !== "rollback" && !candidate.embedded)) {
      const mutated = scanFile(SERVER, site.file, mutateSite(SERVER, site));
      // the site's call is gone from its line and column, every other site of the file is still there
      expect({ site: siteId(site), still: mutated.some(other => other.line === site.line && other.col === site.col) }).toEqual({ site: siteId(site), still: false });
      expect({ site: siteId(site), others: mutated.length }).toEqual({ site: siteId(site), others: sites.filter(other => other.file === site.file).length - 1 });
    }
    expect(ids.size).toBe(sites.length);
  });

  it("every committing site has exactly one driver, through its real entry point, and every driver names a real site", async () => {
    const drivers = new Map<string, { group: string; driver: SiteDriver }>();
    const twice: string[] = [];
    for (const name of readdirSync(DRIVER_DIR).filter(file => file.endsWith(".ts")).sort()) {
      const module = await import(join(DRIVER_DIR, name)) as { DRIVERS: Record<string, SiteDriver> };
      for (const [id, driver] of Object.entries(module.DRIVERS)) { if (drivers.has(id)) twice.push(id); drivers.set(id, { group: name, driver }); }
    }
    const committing = sites.filter(site => site.kind !== "rollback");
    const known = new Set(sites.map(siteId));
    expect({ twice }).toEqual({ twice: [] });
    expect({ missing: committing.map(siteId).filter(id => !drivers.has(id)) }).toEqual({ missing: [] });
    expect({ unknown: [...drivers.keys()].filter(id => !known.has(id)) }).toEqual({ unknown: [] });
    expect({ rollbackDriven: [...drivers.keys()].filter(id => sites.find(site => siteId(site) === id)?.kind === "rollback") }).toEqual({ rollbackDriven: [] });
    // a site in embedded worker text never runs on the main handle; any other site runs where its entry puts it, stated by the driver
    expect({ embeddedAsMain: committing.filter(site => site.embedded && drivers.get(siteId(site))?.driver.conn === "main").map(siteId) }).toEqual({ embeddedAsMain: [] });
    // each group's drivers are run by its own test file
    for (const group of new Set([...drivers.values()].map(entry => entry.group))) {
      const test = readFileSync(join(import.meta.dirname, `wake-sites-${group.replace(/\.ts$/, "")}.test.ts`), "utf8");
      expect(test).toContain(`./testing/site-drivers/${group}`);
    }
  });
});
