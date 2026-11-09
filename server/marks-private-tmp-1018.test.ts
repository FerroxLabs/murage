// secret-scan: fixture (system path rules under test)
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MARKS 1.0.18, MurageMain ruling 11-08 (S4.unlimited red on Mac): on a clean owner No limits turn the macOS temp folders are
// ordinary, as Linux /tmp is. A bot folder under /private/tmp or /private/var/folders must not card git, npm, pnpm, node or mkdir.
// Every other path under /private and /var stays protected, and the bot's own cwd is never exempt in general (a bot folder set to
// /etc is not ordinary). Mutant M-PRIVATE-TMP (drop the exemption in always-ask.ts systemDescendant) turns the ordinary rows red.
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

process.env.HOME = "/home/tester";
process.env.USERPROFILE = "/home/tester";
vi.resetModules();
const { alwaysAskCommand, protectedClass } = await import("./always-ask.ts");
const { ownerMarks } = await import("./shell/marks.ts");

const read = (command: string, cwd: string) => ownerMarks(() => alwaysAskCommand(command, cwd));
const cls = (path: string) => ownerMarks(() => protectedClass(path));

describe("MARKS: the macOS temp folders are ordinary on an owner No limits turn", () => {
  it.each(["/private/tmp/x", "/private/tmp/botw/a/b", "/private/var/folders/ab/cd/T/x", "/var/folders/ab/cd/T/x", "/tmp/x", "/private/tmp/../tmp/x"])(
    "%s is not a protected path", (path) => { expect(cls(path)).toBeNull(); });
  it.each(["/private/etc/x", "/private/var/db/x", "/private/var/root/x", "/private/usr/x", "/private/var/spool/x", "/private/etc", "/etc/x", "/var/db/x", "/var/log/x"])(
    "%s is still protected", (path) => { expect(cls(path)).not.toBeNull(); });
  it.each(["git status", "npm install", "pnpm install", "mkdir out", "touch out/a", "cp a b"])(
    "%s in a bot folder under /private/tmp runs with no finding", (command) => {
      for (const cwd of ["/private/tmp/botw", "/private/var/folders/ab/cd/T/botw"]) expect(read(command, cwd), `${command} @ ${cwd}`).toBeNull();
    });
  it("writes to the temp folders by absolute path run, and writes to /private/etc and /private/var/db still deny", () => {
    for (const ok of ["touch /private/tmp/x", "touch /private/var/folders/ab/x", "touch /var/folders/ab/x", "cp a /private/tmp/b"]) expect(read(ok, "/private/tmp/botw"), ok).toBeNull();
    for (const bad of ["touch /private/etc/x", "touch /private/var/db/x", "cp a /private/etc/b"]) {
      expect(read(bad, "/private/tmp/botw"), bad).toMatchObject({ rule: "protected-path", classification: "deny" });
    }
  });
  it.each(["/private/tmp/../etc/x", "/private/tmp/../../private/etc/x", "/private/tmp/../var/db/x", "/private/var/folders/../db/x", "/var/folders/../../etc/x",
    "/PRIVATE/TMP/../ETC/x", "/private//tmp/../etc/x", "/private/tmp/./../etc/x", "/private/var/folders/ab/../../db/x"])(
    "%s climbs out of the temp folder and is still protected", (path) => { expect(cls(path), path).not.toBeNull(); expect(read(`touch ${path}`, "/private/tmp/botw"), path).toMatchObject({ rule: "protected-path" }); });
  it("a link inside a temp folder that points at a protected folder is never read as ordinary (a stop: protected-path, or unreadable when the link cannot be followed)", () => {
    const dir = mkdtempSync(join(tmpdir(), "marks-ptmp-"));
    try {
      symlinkSync("/etc", join(dir, "lnk"));
      const hit = read("touch lnk/x", dir);
      expect(hit, "touch lnk/x").not.toBeNull();
      expect(["protected-path", "unreadable"]).toContain(hit?.rule);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("a bot folder set to a protected place is not exempt", () => {
    for (const cwd of ["/etc", "/private/etc", "/private/var/db", "/usr/local"]) expect(read("touch out", cwd), cwd).toMatchObject({ rule: "protected-path" });
  });
});
