// The guard that would have prevented 2026-09-20.
//
// Two jobs, tested separately: the decision (pure, exhaustive) and the wiring
// (does patching node:fs actually stop the call). The cases below are not
// invented — the "must still be allowed" list is every production recursive
// delete that targets a path inside DATA_DIR, taken from the audit of
// server/, electron/, shared/, src/ and companion/.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, rmSync as namedRmSync } from "node:fs";
import * as namespaceFs from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DataDirectoryProtected,
  installDataDirGuard,
  protectedRootRefusal,
  uninstallDataDirGuardForTests,
} from "./data-dir-guard.ts";

const DATA = "/Users/someone/.murage";

describe("what the guard refuses", () => {
  it("refuses the exact call that destroyed a live installation", () => {
    // `rmSync(DATA_DIR, { recursive: true, force: true })`.
    expect(protectedRootRefusal(DATA, DATA)).toMatch(/is the Murage installation directory/);
  });

  it("refuses anything that CONTAINS the installation", () => {
    for (const ancestor of ["/Users/someone", "/Users", "/"]) {
      expect(protectedRootRefusal(ancestor, DATA), `${ancestor} must be refused`).toBeTruthy();
    }
  });

  it("refuses the workspaces root — the part that was unrecoverable", () => {
    expect(protectedRootRefusal(join(DATA, "workspaces"), DATA)).toMatch(/every bot workspace/);
  });

  it("refuses a trailing-separator spelling of the same directory", () => {
    expect(protectedRootRefusal(DATA + "/", DATA)).toBeTruthy();
  });

  it("refuses a path that walks back up to the installation", () => {
    expect(protectedRootRefusal(join(DATA, "workspaces", "..", "..", ".murage"), DATA)).toBeTruthy();
  });
});

describe("what the guard must NOT refuse", () => {
  // Every one of these is a real shipped feature. Refusing any of them would
  // leak credentials, orphan data or wedge imports.
  it.each([
    ["workspaces/bot-1", "deleting a bot removes its workspace (store.ts:1967)"],
    ["skill-state/bot-1", "deleting a bot removes its skill state (store.ts:1973)"],
    ["checkpoints/bot-1", "deleting a bot removes its checkpoints (store.ts:1980)"],
    ["workspaces/bot-1/skills/writer", "removing a skill (skills.ts:1060)"],
    ["native/provider-turns/fuigo-ab12", "per-turn provider HOME holding an API key (provider-routing.ts:114)"],
    ["native/grok-provider-context/h/id", "grok provider-home maintenance (provider-routing.ts:72)"],
    ["managed-engines/fuigo/id/1.2.3-uuid", "failed engine download rollback (fuigo-native-update.ts:234)"],
    [".package-import-transaction", "package import journal (package-import-transaction.ts:109)"],
    [".memory-evolution-ab12", "GEPA worker cwd (index.ts:1722)"],
    ["events", "an ordinary child directory"],
  ])("allows %s — %s", (relative) => {
    expect(protectedRootRefusal(join(DATA, relative), DATA)).toBeNull();
  });

  it("allows a SIBLING whose name merely starts with the same text", () => {
    // The restore path really does delete these. A string-prefix check instead
    // of a segment-aware one would refuse every prepared restore.
    for (const sibling of [
      "/Users/someone/.murage-archive-inspection-ab12",   // restore-preparation.ts:205
      "/Users/someone/.murage.restore-uuid.candidate",    // installation-restore.ts:139
      "/Users/someone/.murage-backup-control/digest",     // backup-closed-controller.mjs:8
      "/Users/someone/.murage.previous",                  // the retained pre-restore copy
    ]) {
      expect(protectedRootRefusal(sibling, DATA), `${sibling} is a sibling, not the installation`).toBeNull();
    }
  });

  it("allows a sibling of the workspaces directory", () => {
    expect(protectedRootRefusal(join(DATA, "workspaces-export"), DATA)).toBeNull();
  });

  it("allows a directory whose name is a TEXT PREFIX of the installation", () => {
    // The containment test asks "does the target contain the installation?".
    // Written as a plain `startsWith`, `/Users/someone/.murage` does start with
    // `/Users/someone/.mur`, so deleting that unrelated sibling would be
    // refused. Only a separator-aware comparison gets this right, and without
    // this case a prefix implementation passes the whole suite.
    expect(protectedRootRefusal("/Users/someone/.mur", DATA)).toBeNull();
    expect(protectedRootRefusal("/Users/someone/.murag", DATA)).toBeNull();
    expect(protectedRootRefusal(join(DATA, "work"), DATA)).toBeNull();
  });
});

describe("the wiring", () => {
  afterEach(() => uninstallDataDirGuardForTests());

  it("makes node:fs itself refuse, not merely advise", () => {
    // The fixture lives under the OS temp dir, so `tempRoot` is pointed
    // elsewhere to stop the guard skipping it as a test rig.
    const parent = mkdtempSync(join(tmpdir(), "murage-guard-"));
    const data = join(parent, ".murage");
    mkdirSync(join(data, "workspaces", "bot-1"), { recursive: true });
    writeFileSync(join(data, "workspaces", "bot-1", "MEMORY.md"), "# do not lose this\n");

    expect(installDataDirGuard(data, { tempRoot: "/nowhere-that-exists" })).toBe(true);

    // The installation itself: refused, and still there afterwards.
    expect(() => rmSync(data, { recursive: true, force: true })).toThrow(DataDirectoryProtected);
    expect(existsSync(join(data, "workspaces", "bot-1", "MEMORY.md"))).toBe(true);

    // The workspaces root: refused.
    expect(() => rmSync(join(data, "workspaces"), { recursive: true, force: true })).toThrow(DataDirectoryProtected);
    expect(existsSync(join(data, "workspaces", "bot-1"))).toBe(true);

    // One bot's workspace: allowed, because deleting a bot is a real feature.
    rmSync(join(data, "workspaces", "bot-1"), { recursive: true, force: true });
    expect(existsSync(join(data, "workspaces", "bot-1"))).toBe(false);
    expect(existsSync(join(data, "workspaces"))).toBe(true);

    uninstallDataDirGuardForTests();
    rmSync(parent, { recursive: true, force: true });
  });

  it("is seen by every way a caller can reach fs.rmSync", () => {
    // The first version of this guard used `import * as fs`, an ESM namespace
    // object whose properties are non-writable by specification. Every patch
    // was silently discarded: the guard reported success and blocked nothing,
    // through all three shapes below. Only a real delete attempt revealed it.
    const parent = mkdtempSync(join(tmpdir(), "murage-guard-"));
    const data = join(parent, ".murage");
    mkdirSync(data, { recursive: true });
    installDataDirGuard(data, { tempRoot: "/nowhere-that-exists" });

    const shapes: [string, (p: string, o: object) => void][] = [
      ["named import", namedRmSync],
      ["namespace", namespaceFs.rmSync],
      ["cjs require", createRequire(import.meta.url)("node:fs").rmSync],
    ];
    for (const [shape, remove] of shapes) {
      expect(() => remove(data, { recursive: true, force: true }), `${shape} bypassed the guard`)
        .toThrow(DataDirectoryProtected);
    }
    expect(existsSync(data)).toBe(true);

    uninstallDataDirGuardForTests();
    rmSync(parent, { recursive: true, force: true });
  });

  it("leaves a NON-recursive delete alone, and skips a temp-dir installation", () => {
    const parent = mkdtempSync(join(tmpdir(), "murage-guard-"));
    const data = join(parent, ".murage");
    mkdirSync(data, { recursive: true });

    // A data dir under the OS temp dir is a test rig; the guard declines to
    // install so existing fixtures can still clean themselves up.
    expect(installDataDirGuard(data)).toBe(false);
    rmSync(parent, { recursive: true, force: true });
    expect(existsSync(parent)).toBe(false);
  });
});
