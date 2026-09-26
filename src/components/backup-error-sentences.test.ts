// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.60 audit IPC-L1/L2: feeds the renderer's real error-to-sentence
// functions exactly what a rejected ipcRenderer.invoke carries on the real
// bridge: Electron's prefix plus ONLY the thrown message (a custom `code`
// property is dropped). Each code the desktop can refuse with gets its own
// sentence, not "Backup settings could not be updated".
import { describe, expect, it } from "vitest";
import { scheduleError } from "./backup-schedule-ui";
import { firstBackupError, runNowError } from "./backups-section-ui";

const rejected = (channel: string, message: string) => new Error(`Error invoking remote method '${channel}': Error: ${message}`);
const GENERIC = "Backup settings could not be updated. Your data is preserved. Refresh status before trying again.";

describe("desktop refusals the Backups page names in plain words", () => {
  it("L1: the closed-app volume refusal main keeps across IPC", () => {
    const text = scheduleError(rejected("backup-closed:install", "BACKUP_CLOSED_VOLUME_UNREADABLE"));
    expect(text).not.toBe(GENERIC);
    expect(text).toMatch(/own disk/);
  });
  it("L2: Back up now refused by the activity check or the pause handshake", () => {
    for (const code of ["BACKUP_ACTIVITY_UNAVAILABLE", "BACKUP_PREPARE_UNCONFIRMED"]) {
      const text = runNowError(rejected("backup-schedule:run-now", code));
      expect(text, code).not.toBe(GENERIC);
      expect(text, code).not.toMatch(/[A-Z]{2,}_[A-Z_]+/);
    }
  });
  it("L2: the backup tool's refusal carries its code in the message, so it survives invoke", () => {
    const text = runNowError(rejected("backup-schedule:run-now", "BACKUP_UNAVAILABLE"));
    expect(text).not.toBe(GENERIC);
    // During setup the first-backup line no longer contradicts itself.
    expect(firstBackupError(rejected("backup-schedule:run-now", "BACKUP_UNAVAILABLE"))).not.toContain("Backup settings could not be updated");
  });
  it("the desktop throws those codes as the message itself", async () => {
    const { readFileSync } = await import("node:fs");
    const main = readFileSync(new URL("../../electron/main.mjs", import.meta.url), "utf8");
    const mode = readFileSync(new URL("../../electron/backup-mode.mjs", import.meta.url), "utf8");
    for (const source of [main, mode]) expect(source).not.toMatch(/new Error\("(?:Encrypted backup unavailable|Backup ownership changed)"\)/);
  });
});
