// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// J5 LOWS (Fable J3/J4): a pre-install abort leaves no staged database behind; one archive-id pattern; the unreadable state never shows the finishing line.
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ARCHIVE_ID_RE, archiveIsLocal, captureEmailCarry, sqliteRestoreEffects } from "./restore-job-effects.ts";
import { RESTORE_FINISHING_LINE, RESTORE_STUCK_LINE, RestoreJobStore } from "./restore-job.ts";

let dir: string, live: string, archives: string, n = 0;
beforeEach(() => { n = 0; dir = mkdtempSync(join(tmpdir(), "restore-j5-")); live = join(dir, "messages.db"); archives = join(dir, "archives"); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const mkdb = (path: string) => { mkdirSync(join(path, ".."), { recursive: true }); const db = new DatabaseSync(path); db.exec("CREATE TABLE email_bindings (bot_id TEXT PRIMARY KEY, inbox_id TEXT, address TEXT, email_key_ref TEXT, op_id TEXT, state TEXT)"); db.close(); };
const make = () => new RestoreJobStore({ dir, now: () => 1_800_000_000_000, uid: p => `${p}-${++n}`, isLocalArchive: id => archiveIsLocal(archives, id), captureCarry: () => captureEmailCarry(live),
  effects: sqliteRestoreEffects({ liveDb: live, archivesDir: archives, now: () => 1_800_000_000_000 }) });
const ARM = { archiveId: "arc1", source: "owner" } as const;
const fx = () => sqliteRestoreEffects({ liveDb: live, archivesDir: archives });

describe("J5 Low 2: the staged database does not outlive an abort", () => {
  it("discard removes the staged copy and its temp; the live database is untouched", () => {
    mkdb(live); mkdb(join(archives, "arc1", "messages.db"));
    const s = make(); s.arm(ARM); s.capture();
    const job = JSON.parse(readFileSync(join(dir, "restore-job.json"), "utf8"));
    fx().stage(job);
    writeFileSync(`${live}.restore-${job.id}.tmp`, "x");
    expect(existsSync(`${live}.restore-${job.id}`)).toBe(true);
    fx().discard!(job);
    expect(existsSync(`${live}.restore-${job.id}`)).toBe(false); expect(existsSync(`${live}.restore-${job.id}.tmp`)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });
  it("a job aborted after staging (pre-install) leaves no messages.db.restore-<id>, even if the abort-time discard did not run (clear tries again)", () => {
    mkdb(live); mkdb(join(archives, "arc1", "messages.db"));
    const s = make(); s.arm(ARM); s.capture();
    const job = JSON.parse(readFileSync(join(dir, "restore-job.json"), "utf8"));
    fx().stage(job); // killed after stage, before install
    expect(s.recover()).toEqual({ action: "aborted" });
    expect(existsSync(`${live}.restore-${job.id}`)).toBe(false);
    // the same, discard lost at abort time: put it back, then the owner's OK clears it
    fx().stage(job); expect(existsSync(`${live}.restore-${job.id}`)).toBe(true);
    expect(s.dismiss()).toMatchObject({ ok: true });
    expect(existsSync(`${live}.restore-${job.id}`)).toBe(false);
  });
});
describe("J5 Low 3: one archive id pattern", () => {
  it("the route and the effects share ARCHIVE_ID_RE", () => {
    expect(ARCHIVE_ID_RE.test("arc-1.2_x")).toBe(true);
    for (const bad of ["", ".", "..", "a/b", "a b", "x".repeat(129)]) expect(ARCHIVE_ID_RE.test(bad)).toBe(false);
    expect(readFileSync(join(__dirname, "restore-owner-routes.ts"), "utf8")).not.toMatch(/const ARCHIVE_ID\b/);
    expect(readFileSync(join(__dirname, "restore-owner-routes.ts"), "utf8")).toContain("ARCHIVE_ID_RE.test(archiveId)");
  });
});
describe("J5 Low 4: the unreadable state does not read as progress", () => {
  it("homeLine is the stuck line, never the finishing line, for an unreadable journal", () => {
    mkdb(live); writeFileSync(join(dir, "restore-job.json"), "garbage");
    const s = make();
    expect(s.state()).toBe("unreadable"); expect(s.homeLine()).toBe(RESTORE_STUCK_LINE); expect(s.homeLine()).not.toBe(RESTORE_FINISHING_LINE);
  });
});
