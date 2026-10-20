// Release finding 07-5: message-db.ts imports a legacy messages-<thread>.json into messages.db and renames it
// messages-<thread>.json.imported. The data folder inventory knew only the `.json` name, so every backup of an installation
// that had ever imported one stopped with BACKUP_UNCLASSIFIED_COMPONENT. The renamed file is the legacy transcript record it
// was: backed up under its own name and restored under the same name so the import never runs a second time. On restore it is an
// inert record (messages.db already holds its rows and nothing reads the suffix), so it is copied through as written, never parsed:
// 1.0.2's lenient import accepted transcripts with duplicate ids, and validating one refused the whole restore (INVALID_RESTORE_MESSAGE).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { classifyDataDirEntry, DATA_DIR_PATTERNS } from "./data-dir-inventory.ts";
import { reviewInstallation } from "./installation-activation.ts";
import { restoreEncryptedInstallationNew, writeEncryptedInstallationBackup } from "./installation-encrypted-backup.ts";
import { backupFixture, rawAgeHost, testAgeKeys } from "./testing/backup-fixture.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const selection = { scope: "application-data", credentialPolicy: "preserve-in-encrypted-fidelity" } as const;

it("classifies an imported legacy transcript as the record it was", () => {
  expect(classifyDataDirEntry("messages-thread-1.json.imported")?.backup).toBe("record");
  expect(classifyDataDirEntry("messages-thread-1.json")?.backup).toBe("record");
  // only that one suffix: anything else beside a transcript is still unknown
  expect(classifyDataDirEntry("messages-thread-1.json.imported.bak")).toBeUndefined();
  expect(DATA_DIR_PATTERNS.some(item => item.example === "messages-thread-1.json.imported")).toBe(true);
});

it.skipIf(!rawAgeHost)("backs up an installation holding an imported transcript and restores it under its own name, copied through as written", { timeout: 120_000 }, async () => {
  const f = backupFixture(), keys = testAgeKeys();
  try {
    f.db.close();
    const legacy = {
      activeLeafId: "legacy-2",
      messages: [
        { id: "legacy-1", at: 1, role: "user", kind: "text", text: "imported long ago", queued: true },
        { id: "legacy-2", at: 2, role: "bot", kind: "text", text: "the reply that was imported" },
      ],
    };
    writeFileSync(join(f.data, "messages-legacy-thread.json.imported"), JSON.stringify(legacy), { mode: 0o600 });
    const archive = join(f.parent, "backup.age");
    // BACKUP_UNCLASSIFIED_COMPONENT before the name was classified
    const written = await writeEncryptedInstallationBackup(f.data, archive, { ...keys, selection });
    expect(written.coverage.components).toContainEqual(expect.objectContaining({ path: "messages-legacy-thread.json.imported", status: "included" }));
    const target = join(f.parent, "restored");
    const restored = await restoreEncryptedInstallationNew(target, archive, written.sha256, { ageExecutable: keys.ageExecutable, identity: keys.identity });
    expect(restored.status).toBe("restored-review-required");
    // same name: a restored `.json` would be imported a second time into a database that already holds its rows
    expect(existsSync(join(target, "messages-legacy-thread.json"))).toBe(false);
    const back = JSON.parse(readFileSync(join(target, "messages-legacy-thread.json.imported"), "utf8")) as typeof legacy;
    expect(back.activeLeafId).toBe("legacy-2");
    expect(back.messages.map(message => [message.id, message.text])).toEqual([["legacy-1", "imported long ago"], ["legacy-2", "the reply that was imported"]]);
    // inert: nothing reads it again, so it is not expired or rewritten on restore
    expect(back.messages[0].queued).toBe(true);
    expect(reviewInstallation(target).status).toBe("ready-for-review");
  } finally { removeTempDirSync(f.parent); }
});

it.skipIf(!rawAgeHost)("restores fully when an imported transcript holds duplicate ids (1.0.2's lenient import accepted them)", { timeout: 120_000 }, async () => {
  const f = backupFixture(), keys = testAgeKeys();
  try {
    f.db.close();
    const raw = JSON.stringify({
      activeLeafId: "dup-1",
      messages: [
        { id: "dup-1", at: 1, role: "user", kind: "text", text: "first" },
        { id: "dup-1", at: 2, role: "bot", kind: "text", text: "same id, replaced the first on import" },
      ],
    });
    writeFileSync(join(f.data, "messages-dup-thread.json.imported"), raw, { mode: 0o600 });
    const archive = join(f.parent, "backup.age");
    const written = await writeEncryptedInstallationBackup(f.data, archive, { ...keys, selection });
    expect(written.coverage.components).toContainEqual(expect.objectContaining({ path: "messages-dup-thread.json.imported", status: "included" }));
    const target = join(f.parent, "restored");
    // INVALID_RESTORE_MESSAGE before the sidecar was copied through
    const restored = await restoreEncryptedInstallationNew(target, archive, written.sha256, { ageExecutable: keys.ageExecutable, identity: keys.identity });
    expect(restored.status).toBe("restored-review-required");
    expect(existsSync(join(target, "messages-dup-thread.json"))).toBe(false);
    const back = JSON.parse(readFileSync(join(target, "messages-dup-thread.json.imported"), "utf8")) as { messages: Array<{ id: string; text: string }> };
    expect(back.messages.map(message => [message.id, message.text])).toEqual([["dup-1", "first"], ["dup-1", "same id, replaced the first on import"]]);
    // the whole installation came back: the fixture's database and records are there, and the review before activation passes
    expect(existsSync(join(target, "messages.db"))).toBe(true);
    expect(reviewInstallation(target).status).toBe("ready-for-review");
  } finally { removeTempDirSync(f.parent); }
});
