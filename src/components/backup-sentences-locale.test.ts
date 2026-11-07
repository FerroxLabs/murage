// WIN-BACKUP-RT-1018: the translated backup sentences (shared/backup-capture-failure.mjs BACKUP_SENTENCE_KEYS) are
// said in the person's language on the Backups page and in the Inbox, and in English exactly as the English tables.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { setLocale, t } from "@/lib/i18n";
import { BACKUP_SENTENCE_KEYS, BACKUP_WAIT_SENTENCES, backupNoticeSentence, backupWaitSentence, captureFailureReason } from "../../shared/backup-capture-failure.mjs";
import { backupSummary, type BackupSummaryInput } from "./backups-section-ui";

const catalogue = (code: string) => JSON.parse(readFileSync(new URL(`../locales/${code}.json`, import.meta.url), "utf8")) as Record<string, string>;
const en = catalogue("en"), de = catalogue("de");
afterEach(() => setLocale("en"));

const refs = { installationRef: "fixture_install", destinationRef: "fixture_dest", recoveryRef: "fixture_key", destinationLabel: "Fixture backups", recoveryLabel: "Recovery.age" };
const schedule = { enabled: true, preUpgrade: false, time: "22:15", timezone: "Asia/Bangkok", catchupMs: 7200000, maxBytes: 1073741824, maxDurationMs: 600000, ...refs, selection: { scope: "application-data" as const, credentialPolicy: "preserve-in-encrypted-fidelity" as const } };
const lastVerified = { jobId: "a".repeat(64), installationRef: "i", destinationRef: "d", selectionHash: "b".repeat(64), snapshotId: "00000000-0000-4000-8000-000000000000", artifactRef: "x", sha256: "c".repeat(64), bytes: 1234567890, verifiedAt: 1700000000000 };
function input(patch: Record<string, unknown>): BackupSummaryInput {
  return {
    scheduleBridge: true, scheduleStale: false, scheduleFailure: null, closed: { supported: true, state: "installed", closedApp: false }, closedStale: false,
    schedule: { supported: true, pending: false, enabled: true, revision: 3, phase: "idle", schedule, refs, lastVerified, ...patch },
    remoteBridge: true, remoteStale: false, remoteFailure: null,
    remote: { supported: true, pending: false, configured: true, state: "connected", revision: 2, remoteRef: "remote-one", lastUpload: { state: "verified", jobId: "a".repeat(64) }, automaticUpload: { enabled: true, state: "enabled" } },
  } as unknown as BackupSummaryInput;
}
const administrator = input({ phase: "needs-review", captureFailure: { stage: "precondition", code: "BACKUP_STARTED_AS_ADMINISTRATOR" } });
const spaceWait = input({ phase: "waiting", waiting: { cause: "space", neededBytes: 1_400_000_000, drive: "backup" } });
const WAITS: Array<[keyof typeof BACKUP_WAIT_SENTENCES, Record<string, unknown>]> = [
  ["space", { cause: "space", neededBytes: 1_400_000_000, drive: "backup" }], ["data", { cause: "space", neededBytes: 1_400_000_000, drive: "data" }],
  ["spaceUnknown", { cause: "space", drive: "backup" }], ["dataUnknown", { cause: "space", drive: "data" }],
  ["drive", { cause: "drive" }], ["busy", { cause: "busy" }], ["interrupted", { cause: "interrupted" }],
];

describe("backup sentences in the person's language", () => {
  it("every mapped key is in the English catalogue and equals the English table, word for word, and every locale has it", () => {
    expect(Object.keys(BACKUP_SENTENCE_KEYS.wait).sort()).toEqual(Object.keys(BACKUP_WAIT_SENTENCES).sort());
    for (const [cause, key] of Object.entries(BACKUP_SENTENCE_KEYS.wait)) expect(en[key], key).toBe(BACKUP_WAIT_SENTENCES[cause as keyof typeof BACKUP_WAIT_SENTENCES]);
    expect(en[BACKUP_SENTENCE_KEYS.capture.BACKUP_STARTED_AS_ADMINISTRATOR]).toBe(captureFailureReason("BACKUP_STARTED_AS_ADMINISTRATOR"));
    for (const code of ["de", "es", "fr", "pt-br", "ja", "zh", "hi"]) {
      const pack = catalogue(code);
      for (const key of [...Object.values(BACKUP_SENTENCE_KEYS.wait), ...Object.values(BACKUP_SENTENCE_KEYS.capture)]) expect(typeof pack[key] === "string" && pack[key] !== en[key], `${code} ${key}`).toBe(true);
    }
  });

  it("Backups page, German: Run as administrator and a space wait say the German sentences", async () => {
    expect(await setLocale("de")).toBe("de");
    const stopped = backupSummary(administrator, () => "WHEN").attention;
    expect(stopped).toContain(de["backup.stopped.administrator"]);
    expect(stopped.join(" ")).not.toMatch(/administrator, and backups|The last backup stopped/);
    expect(backupSummary(spaceWait, () => "WHEN").attention).toContain(de["backup.waiting.space"].replace("{size}", "1.4 GB"));
    for (const [key, wait] of WAITS) expect(backupWaitSentence(wait, t), key).toBe(key === "space" || key === "data" ? de[`backup.waiting.${key}`].replace("{size}", "1.4 GB") : de[`backup.waiting.${key}`]);
  });

  it("Backups page, English: exactly the English sentences, Run as administrator as a whole sentence", async () => {
    await setLocale("en");
    expect(backupSummary(administrator, () => "WHEN").attention).toContain(en["backup.stopped.administrator"]);
    expect(backupSummary(administrator, () => "WHEN").attention.join(" ")).not.toContain("The last backup stopped");
    expect(backupSummary(spaceWait, () => "WHEN").attention).toContain(BACKUP_WAIT_SENTENCES.space.replace("{size}", "1.4 GB"));
    for (const [key, wait] of WAITS) expect(backupWaitSentence(wait, t), key).toBe(backupWaitSentence(wait));
  });

  it("Inbox: the stopped-backup row says the locale sentence for a translated code and the stored English otherwise", async () => {
    const english = en["backup.stopped.administrator"];
    await setLocale("de");
    expect(backupNoticeSentence({ sentence: english, code: "BACKUP_STARTED_AS_ADMINISTRATOR" }, t)).toBe(de["backup.stopped.administrator"]);
    expect(backupNoticeSentence({ sentence: "The last backup stopped while copying your workspace.", code: "BACKUP_FILE_IN_USE" }, t)).toBe("The last backup stopped while copying your workspace.");
    await setLocale("en");
    expect(backupNoticeSentence({ sentence: english, code: "BACKUP_STARTED_AS_ADMINISTRATOR" }, t)).toBe(english);
    const inbox = readFileSync(new URL("./Inbox.tsx", import.meta.url), "utf8");
    expect(inbox, "the Inbox row renders through backupNoticeSentence with the catalogue").toContain("{backupNoticeSentence(backupFailed, t)}");
    expect(inbox).not.toContain("{backupFailed.sentence}");
  });
});
