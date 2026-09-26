// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Backup mode (and so every restore) asks the harness whether work is idle via
// GET /api/bots?messages=0 and electron/backup-mode.mjs backupActivityBusy.
// A bot that had never run a turn had no `busy` field on the wire, the check
// refused it as BACKUP_ACTIVITY_UNAVAILABLE, and a fresh install could not
// open Backup mode to restore anything (packaged 0.1.60, 2026-09-26).
// Real server, real route, real desktop check; loopback only, no credentials.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error -- plain JavaScript desktop module, as every other test imports it
import { backupActivityBusy } from "../electron/backup-mode.mjs";

const posixOnly = describe.skipIf(process.platform === "win32");
let fixture: VerificationServer, headers: Record<string, string>;

posixOnly("backup activity on a fresh install", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env);
    const secret = (await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string }).secret;
    headers = { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
  }, 60000);
  afterAll(async () => { await fixture?.close(); });

  it("a bot that has never run reads as idle, not as an unreadable activity report", async () => {
    const created = await fetch(`${fixture.info.url}/api/bots`, { method: "POST", headers, body: JSON.stringify({ name: "Never Ran" }) });
    expect(created.status).toBeLessThan(300);
    const activity = await (await fetch(`${fixture.info.url}/api/bots?messages=0`, { headers })).json() as { bots: Array<{ name: string; busy?: unknown }> };
    expect(activity.bots.find(bot => bot.name === "Never Ran")?.busy).toBe(false);
    expect(backupActivityBusy(activity)).toBe(false);
  });
});
