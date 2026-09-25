// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from "node:fs";
import { describe, expect, it } from "vitest";

// The bug report form is read by people running the desktop app, not by
// developers. It must send them to the log folder the app really writes
// (electron/main.mjs LOG_DIR = app.getPath("logs"), and the app name is the
// package.json name, so the folder is lowercase "murage").
const template = fs.readFileSync(new URL("../.github/ISSUE_TEMPLATE/bug_report.yml", import.meta.url), "utf8");

describe("bug report template", () => {
  it("points desktop users at the app's own log folders, not a dev server", () => {
    expect(template).not.toMatch(/pnpm dev:server/);
    expect(template).not.toMatch(/~\/\.murage\/events/);
    expect(template).toContain("~/Library/Logs/murage");
    expect(template).toContain("%APPDATA%\\murage\\logs");
    expect(template).toContain("~/.config/murage/logs");
    expect(template).toContain("server.log");
  });

  it("says where to read the app version", () => {
    expect(template).toMatch(/Settings[^\n]*General[^\n]*Updates/);
  });

  it("keeps product copy rules", () => {
    expect(template).not.toMatch(/—/);
    expect(template).not.toMatch(/composio/i);
  });

  it("names the real app name casing the log folder uses", () => {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    // If productName is ever added, Electron's log folder name changes with it.
    expect(pkg.productName).toBeUndefined();
    expect(pkg.name).toBe("murage");
  });
});
