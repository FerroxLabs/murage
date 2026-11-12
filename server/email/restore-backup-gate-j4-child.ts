// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Child process for restore-backup-gate-j4.test.ts: a desktop backup host that starts a backup (scheduled, or manual through requestManual) and hangs
// inside the capture, so the parent can SIGKILL it mid-backup. argv: mode ("scheduled" | "manual"), state directory, ready file.
import { writeFileSync } from "node:fs";
import { BackupCoordinator } from "../backup-coordinator.ts";

const [mode, stateDirectory, ready] = process.argv.slice(2) as [string, string, string];
const choices = { enabled: true, installationRef: "installation-one", destinationRef: "destination-one", recoveryRef: "recovery-one", timezone: "Asia/Bangkok", time: "09:00", catchupMs: 3 * 86400000, maxBytes: 100000, maxDurationMs: 600000, selection: { scope: "application-data" as const, credentialPolicy: "preserve-in-encrypted-fidelity" as const }, preUpgrade: false };
let clock = Date.parse("2026-09-13T01:00:00Z"); // configured before the 09:00 Bangkok time, then the clock passes it
const coordinator = new BackupCoordinator({
  stateDirectory, now: () => clock,
  claimIdle: async () => ({ state: "claimed" as const, release: async () => {} }),
  captureOffline: () => new Promise(() => { writeFileSync(ready, "capturing"); }), // never settles: the process is killed here
});
coordinator.configure(0, choices);
clock = Date.parse("2026-09-13T03:00:00Z");
if (mode === "manual") coordinator.requestManual(1, "manual-request-one");
void coordinator.tick();
setInterval(() => {}, 1000); // keep the process alive while the capture hangs
