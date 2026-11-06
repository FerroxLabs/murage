// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// From the 0.1.60 pre-release audit (A-02 probe): after a customer restores onto a new computer,
// the restored installation must itself be backed up by the next daily
// backup. No existing test backs up a RESTORED data folder. This takes a
// realistic installation (About me, House Rules, What's New, a decision log,
// a skill collection, a channel, startup preferences), backs it up, restores
// it into a new folder, then backs up the restored folder with the real
// stage + fidelity + age path.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { writeEncryptedInstallationBackup, restoreEncryptedInstallationNew } from "./installation-encrypted-backup.ts";
import { backupFixture, testAgeKeys } from "./testing/backup-fixture.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { beginOutsideTurn, forgetOutsideState, markTurnOutside, outsideSince, ownWrite, ownWritten, sessionTainted, turnOutsideRead, wireOutsideStore } from "./email/external-marks.ts";
import { fileOutsideStore } from "./outside-store.ts";

const selection = { scope: "application-data", credentialPolicy: "preserve-in-encrypted-fidelity" } as const;

it.skipIf(!process.env.MURAGE_BACKUP_TEST_AGE_DIR)("a restored installation can itself be backed up", async () => {
  const f = backupFixture(), keys = testAgeKeys();
  writeFileSync(join(f.data, "about-me.md"), "I run a pottery studio in Lisbon.\n");
  writeFileSync(join(f.data, "house-rules.md"), "Be brief.\n");
  writeFileSync(join(f.data, "house-rules.json"), JSON.stringify({ enabled: true }) + "\n");
  writeFileSync(join(f.data, "whats-new.json"), JSON.stringify({ seen: ["0.1.59", "0.1.60"] }) + "\n");
  writeFileSync(join(f.data, "decisions.ndjson"), JSON.stringify({ at: 1, decision: "allowed" }) + "\n");
  mkdirSync(join(f.data, "skill-collection", "brand-voice"), { recursive: true });
  writeFileSync(join(f.data, "skill-collection", "brand-voice", "SKILL.md"), "---\nname: brand-voice\n---\nWrite plainly.\n");
  writeFileSync(join(f.data, "startup-background.json"), JSON.stringify({ keepRunning: true, startAtLogin: true }));
  try {
    const first = join(f.parent, "first.age");
    const saved = await writeEncryptedInstallationBackup(f.data, first, { ...keys, selection });
    const restoredDir = join(f.parent, "restored");
    await restoreEncryptedInstallationNew(restoredDir, first, saved.sha256, keys);
    const names = readdirSync(restoredDir).sort();
    // Owner files came back.
    for (const name of ["about-me.md", "house-rules.md", "whats-new.json", "decisions.ndjson"]) expect(names).toContain(name);
    expect(readFileSync(join(restoredDir, "skill-collection", "brand-voice", "SKILL.md"), "utf8")).toContain("Write plainly");
    // And the restored folder backs up.
    const second = join(f.parent, "second.age");
    await writeEncryptedInstallationBackup(restoredDir, second, { ...keys, selection });
  } finally { f.db.close(); removeTempDirSync(f.parent); }
});

// NOLIMITS: outside-state.jsonl is an owner file. A restore keeps what a chat read from outside: the session's taint, the own
// writes a marked turn made and `outsideSince`. Without the file the restored install would read those writes as clean.
it.skipIf(!process.env.MURAGE_BACKUP_TEST_AGE_DIR)("a restore keeps the outside marks, the session taint, the own writes and outsideSince", async () => {
  const f = backupFixture(), keys = testAgeKeys();
  try {
    expect(wireOutsideStore(fileOutsideStore(join(f.data, "outside-state.jsonl")))).toBe(true);
    beginOutsideTurn("t1", "i1", "turn-1", false);
    markTurnOutside("t1", "web page");
    ownWrite("bot:b1");
    const since = outsideSince();
    expect(since).toBeTypeOf("number");
    forgetOutsideState();
    const archive = join(f.parent, "marks.age");
    const saved = await writeEncryptedInstallationBackup(f.data, archive, { ...keys, selection });
    const restoredDir = join(f.parent, "restored");
    await restoreEncryptedInstallationNew(restoredDir, archive, saved.sha256, keys);
    expect(wireOutsideStore(fileOutsideStore(join(restoredDir, "outside-state.jsonl")))).toBe(true);
    expect(outsideSince()).toBe(since);
    expect(ownWritten("bot:b1")).toBe(true);
    expect(ownWritten("bot:b2")).toBe(false);
    expect(sessionTainted("t1", "i1")).toBe(true);
    beginOutsideTurn("t1", "i1", "turn-2", true);
    expect(turnOutsideRead("t1")).not.toBeNull();
  } finally { forgetOutsideState(); f.db.close(); removeTempDirSync(f.parent); }
});
