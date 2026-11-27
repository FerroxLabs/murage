// 1.0.20 (Mac, backupmac): the Backups on switch had no handler unless the
// setup card's consent box was ticked, so a press did nothing at all.
import { describe, expect, it } from "vitest";
import { backupSwitchPress, scheduleDraft } from "./backup-schedule-ui";
import { runNowError } from "./backups-section-ui";

const refs = { installationRef: "installation-fixture", destinationRef: "destination-fixture", recoveryRef: "recovery-fixture", destinationLabel: "Backups", recoveryLabel: "key.txt" };
const saved = { enabled: false, preUpgrade: false, installationRef: refs.installationRef, destinationRef: refs.destinationRef, recoveryRef: refs.recoveryRef,
  time: "02:00", timezone: "UTC", catchupMs: 12 * 3600000, maxBytes: 50 * 1024 ** 3, maxDurationMs: 30 * 60000,
  selection: { scope: "application-data", credentialPolicy: "preserve-in-encrypted-fidelity" } };
const status = (over: Record<string, unknown> = {}) => ({ supported: true, pending: false, enabled: false, revision: 3, phase: "returned", schedule: saved, refs, error: null, ...over }) as unknown as BackupScheduleStatus;

describe("Backups on switch", () => {
  it("turns daily backups on with the saved time and limits, without the setup card's box", () => {
    const s = status();
    const press = backupSwitchPress(scheduleDraft(s.schedule), s);
    expect(press.action).toBe("enable");
    if (press.action !== "enable") return;
    expect(press.schedule).toMatchObject({ enabled: true, time: "02:00", timezone: "UTC", catchupMs: saved.catchupMs, maxBytes: saved.maxBytes, maxDurationMs: saved.maxDurationMs, ...{ installationRef: refs.installationRef, destinationRef: refs.destinationRef, recoveryRef: refs.recoveryRef } });
  });
  it("turns them off when on", () => {
    const s = status({ enabled: true, schedule: { ...saved, enabled: true } });
    expect(backupSwitchPress(scheduleDraft(s.schedule), s)).toEqual({ action: "disable" });
  });
  it("says in words why it can't, never a silent press", () => {
    const review = status({ phase: "needs-review" });
    expect(backupSwitchPress(scheduleDraft(review.schedule), review)).toEqual({ action: "refused", message: "Daily backups are still off: the last backup didn't finish. Clear it first, then turn backups on." });
    const busy = status({ pending: true });
    expect(backupSwitchPress(scheduleDraft(busy.schedule), busy)).toEqual({ action: "refused", message: "Daily backups are still off: a backup is being taken. Try again when it has finished." });
    const s = status();
    expect(backupSwitchPress({ ...scheduleDraft(s.schedule), size: "" }, s)).toEqual({ action: "refused", message: "Daily backups are still off: the time each day or a backup limit is missing. Set them under Advanced." });
  });
});

describe("Back up now that never starts", () => {
  it("is said in plain words", () => {
    expect(runNowError(new Error("BACKUP_START_STALLED"))).toBe("Back up now didn't start within 2 minutes, so nothing has been backed up yet. If Murage closes by itself, the backup is going ahead. If not, quit Murage, open it again and choose Back up now.");
  });
});
