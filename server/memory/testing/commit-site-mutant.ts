// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MEMORY V2 lane W, W-COMMIT: one mutant per committing call site, for its receipt. Writes the mutant of one site into the tree (run it in
// a copy): the site's own end statement goes to the handle's un-instrumented method, so the observer hears no end from that line.
//   node --experimental-strip-types server/memory/testing/commit-site-mutant.ts "<file> <fn>#<k>"
// The site's driver (testing/site-drivers/) must then fail at its site assertion in commit-site-harness.ts ("reportsFromSite" for a
// committing site, "ran" for a nested RELEASE). commit-site-mutants.sh runs a list of them one at a time. wake-commit-sites.test.ts checks
// that every driven site has a mutant that removes exactly its own call.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { mutateSite, scanCommitSites, siteId } from "./commit-site-scan.ts";

const root = join(import.meta.dirname, "..", "..");
const id = process.argv[2];
const site = scanCommitSites(root).find(candidate => siteId(candidate) === id);
if (!site) { console.error(`no such site: ${id}`); process.exit(3); }
writeFileSync(join(root, site.file), mutateSite(root, site));
console.log(`MUTATED ${site.file}:${site.line}:${site.col}`);
