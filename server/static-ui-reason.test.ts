// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createStaticUiDiagnostics, createStaticUiLogger, describeStaticRootAtBoot, describeStaticUiFailure, staticRootState, staticUiReason,
} from "./static-ui-reason.ts";

const err = (code: string) => Object.assign(new Error("secret file contents must never be logged"), { code });

describe("static ui reason (WIN-NOROUTE19)", () => {
  it("names the cause from the error code", () => {
    expect(staticUiReason(err("ENOENT"))).toEqual({ kind: "missing", code: "ENOENT" });
    expect(staticUiReason(err("ENOTDIR"))).toEqual({ kind: "missing", code: "ENOTDIR" });
    expect(staticUiReason(err("EACCES"))).toEqual({ kind: "permission", code: "EACCES" });
    expect(staticUiReason(err("EPERM"))).toEqual({ kind: "permission", code: "EPERM" });
    expect(staticUiReason(err("EBUSY"))).toEqual({ kind: "locked", code: "EBUSY" });
    expect(staticUiReason(new Error("x"))).toEqual({ kind: "unreadable", code: "unknown" });
    expect(staticUiReason(undefined)).toEqual({ kind: "unreadable", code: "unknown" });
  });

  it("one plain line per failure: reason, which part is missing, the root; never the error message", () => {
    const root = "C:\\Users\\a\\AppData\\Local\\Programs\\Murage\\resources\\ui";
    const missing = describeStaticUiFailure(root, err("ENOENT"), { rootExists: false, indexExists: false });
    expect(missing).toContain("missing ENOENT");
    expect(missing).toContain("the ui folder is missing");
    expect(missing).toContain("update may still be installing");
    expect(missing).toContain(root);
    expect(missing).not.toContain("secret");
    expect(missing).not.toContain("\n");
    expect(describeStaticUiFailure(root, err("EPERM"), { rootExists: true, indexExists: false })).toContain("the ui folder exists but index.html is missing");
    expect(describeStaticUiFailure(root, err("EBUSY"), { rootExists: true, indexExists: true })).toContain("index.html exists but could not be read");
    expect(describeStaticUiFailure(root, err("EBUSY"), { rootExists: true, indexExists: true })).toContain("locked EBUSY");
  });

  it("says each line once per interval", () => {
    const lines: string[] = [];
    let t = 0;
    const say = createStaticUiLogger((l) => lines.push(l), () => t, 30_000);
    say("a"); say("a"); say("b");
    t = 29_999; say("a");
    t = 30_000; say("a");
    expect(lines).toEqual(["a", "b", "a"]);
  });

  it("checks the real folder at boot and on failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "ui-reason-"));
    try {
      const root = join(dir, "ui");
      const lines: string[] = [];
      const diag = createStaticUiDiagnostics(root, (l) => lines.push(l));
      diag.boot();
      expect(lines.pop()).toContain("the ui folder is missing at boot");
      mkdirSync(root);
      diag.boot();
      expect(lines.pop()).toContain("index.html is missing from the ui folder");
      writeFileSync(join(root, "index.html"), "<html>SECRET-PAGE-BODY</html>");
      diag.boot();
      expect(lines.pop()).toBe(`static ui: serving the app from ${root}`);
      expect(staticRootState(root)).toEqual({ rootExists: true, indexExists: true });
      rmSync(join(root, "index.html"));
      diag.unreadable(err("ENOENT"));
      const line = lines.pop() ?? "";
      expect(line).toContain("the ui folder exists but index.html is missing");
      expect(line).not.toContain("SECRET");
    } finally { removeTempDirSync(dir); }
  });

  it("describes the boot state in words", () => {
    expect(describeStaticRootAtBoot("/r", { rootExists: true, indexExists: true })).toBe("static ui: serving the app from /r");
  });

  it("is wired into the server's static handler and its boot", () => {
    const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(index).toContain('from "./static-ui-reason.ts"');
    expect(index).toContain("staticUiDiagnostics?.unreadable(");
    expect(index).toContain("staticUiDiagnostics?.boot()");
  });
});
