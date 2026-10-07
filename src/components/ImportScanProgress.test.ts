// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { guardBlockedNote } from "./ImportGuardFindings";
import { ImportScanProgress } from "./ImportScanProgress";
import { withScanId } from "../lib/importScan";

describe("import check progress", () => {
  it("says how many files are checked, with a bar", () => {
    const html = renderToStaticMarkup(createElement(ImportScanProgress, { progress: { filesDone: 12, filesTotal: 41, bytesDone: 500, bytesTotal: 1000 } }));
    expect(html).toContain("Checking 12 of 41 files…");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="50"');
  });
  it("says the check is starting before the first count arrives", () => {
    expect(renderToStaticMarkup(createElement(ImportScanProgress, { progress: null }))).toContain("Starting the check…");
  });
  it("names a package that is too large and a check that could not finish", () => {
    expect(guardBlockedNote({ blocked: true, reviewRequired: false, findings: [], state: "too-large" })).toBe("This package is too large to check, so it was not imported.");
    expect(guardBlockedNote({ blocked: true, reviewRequired: false, findings: [], state: "unavailable" })).toContain("Please try again.");
    expect(guardBlockedNote({ blocked: true, reviewRequired: false, findings: [] })).toContain("Import blocked");
  });
  it("adds the check's id to a request", () => {
    expect(withScanId("/api/teams/import?mode=add", "abc")).toBe("/api/teams/import?mode=add&scanId=abc");
    expect(withScanId("/api/packages/import", "abc")).toBe("/api/packages/import?scanId=abc");
  });
});
