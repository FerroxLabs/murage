// The Backups headline never shows a green "all good" for backups that are off
// or old. 1.0.20 owner walk: "Backups off" sat next to a green dot and "Last
// backup 11/4/2026, checked and complete." fifteen days later.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { backupHeadline, BACKUP_STALE_MS } from "./backups-section-ui";

const DAY = 24 * 60 * 60_000;
const NOW = 30 * DAY;
const refs = { installationRef: "i", destinationRef: "d", recoveryRef: "r" };
const status = (over: Record<string, unknown>) => ({
  supported: true, pending: false, enabled: true, revision: 1, phase: "returned", refs,
  schedule: { enabled: true, preUpgrade: false, time: "02:00" }, ...over,
}) as never;
const fmt = (ms: number) => `day ${Math.round(ms / DAY)}`;

describe("Backups headline tells the truth", () => {
  it("on, backed up within two days: green, no action", () => {
    const head = backupHeadline(status({ lastVerified: { verifiedAt: NOW - 3 * 3_600_000, bytes: 1 } }), NOW, fmt);
    expect(head.tone).toBe("ok");
    expect(head.verified).toBe(true);
  });
  it("off with an old checked backup: warning, never green", () => {
    const head = backupHeadline(status({ enabled: false, schedule: { enabled: false, preUpgrade: false }, lastVerified: { verifiedAt: NOW - 15 * DAY, bytes: 1 } }), NOW, fmt);
    expect(head.title).toBe("Backups off");
    expect(head.tone).toBe("warning");
    expect(head.verified).toBe(false);
    expect(head.lines[0]).toBe("Daily backups are off, so nothing new is being backed up.");
    expect(head.lines.join(" ")).toContain("Last backup day 15");
  });
  it("off with a fresh backup is still a warning: the schedule is what keeps you covered", () => {
    const head = backupHeadline(status({ enabled: false, schedule: { enabled: false, preUpgrade: false }, lastVerified: { verifiedAt: NOW - 60_000, bytes: 1 } }), NOW, fmt);
    expect(head.tone).toBe("warning");
    expect(head.verified).toBe(false);
  });
  it("on, but the last backup is older than two days: warning", () => {
    const head = backupHeadline(status({ lastVerified: { verifiedAt: NOW - BACKUP_STALE_MS - 60_000, bytes: 1 } }), NOW, fmt);
    expect(head.tone).toBe("warning");
    expect(head.verified).toBe(false);
    expect(head.lines[0]).toBe("The last backup is more than 2 days old. Check that this computer is on at the backup time, or use Back up now.");
  });
  it("exactly two days old is still fine; the boundary is strict", () => {
    const head = backupHeadline(status({ lastVerified: { verifiedAt: NOW - BACKUP_STALE_MS, bytes: 1 } }), NOW, fmt);
    expect(head.tone).toBe("ok");
  });
  it("the card paints the dot from tone, and the page offers exactly one Turn on daily backups", () => {
    const page = readFileSync(fileURLToPath(new URL("./BackupSettings.tsx", import.meta.url)), "utf8");
    const body = page.slice(page.indexOf("export function BackupHeadline("), page.indexOf("export function LocalRestore("));
    expect(body).toMatch(/head\.tone==="warning"\?"text-warning":"text-success"/);
    expect(body).not.toMatch(/head\.verified&&<span[^>]*text-success/);
    // The headline adds no second button; the Set up card (shown while off) holds the one.
    expect(body).not.toContain("Turn on daily backups");
    const setup = page.slice(page.indexOf("export function ScheduleSetup("), page.indexOf("export function BackupHeadline("));
    expect(setup.match(/>Turn on daily backups</g)?.length).toBe(1);
    expect(page).toMatch(/\{!s\.status\?\.enabled&&<ScheduleSetup /);
  });
});
