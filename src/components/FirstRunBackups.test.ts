import { describe, expect, it } from "vitest";
import { backupHeadline, backupSetupVerified, ensureFirstRunBackup, FIRST_RUN_BACKUP_COPY, type BackupScheduleBridge } from "./backups-section-ui";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Status = BackupScheduleStatus;
// A data folder that has never had backups, as the desktop reports one.
const fresh = { eligible: true, completed: null };
const base = (over: Partial<Status> = {}): Status => ({
  supported: true, pending: false, enabled: false, revision: 1, phase: "idle", firstRun: fresh,
  schedule: { enabled: false, preUpgrade: false } as Status["schedule"], ...over,
});
// A receipt names the folder it was checked against (Settings L5).
const receipt = { verifiedAt: 1_000, bytes: 10, installationRef: "i", destinationRef: "d" } as unknown as NonNullable<Status["lastVerified"]>;
const refs = { installationRef: "i", destinationRef: "d", recoveryRef: "r", destinationLabel: "Backups", recoveryLabel: "key.txt" };
const onSchedule = { enabled: true, preUpgrade: false, installationRef: "i", destinationRef: "d", recoveryRef: "r" } as Status["schedule"];

/** A fake desktop host: setUp chooses refs, configure turns on, runNow starts a
 *  capture whose receipt lands on the `afterReads`-th status read. */
function host(afterReads: number, extra: { firstBackup?: boolean } = {}) {
  let state = base();
  let reads = 0, capturing = false;
  const calls: string[] = [];
  const bridge = {
    status: async () => {
      calls.push("status");
      if (capturing && ++reads >= afterReads) state = { ...state, pending: false, lastVerified: receipt };
      return state;
    },
    setUp: async () => { calls.push("setUp"); state = base({ refs, revision: 2, firstRun: { eligible: false, completed: null } }); return { ...state, created: { label: "key.txt", publicKey: null, folder: "Documents" } }; },
    configure: async (_rev: number, choices: Status["schedule"]) => { calls.push("configure"); state = { ...state, enabled: true, schedule: { ...choices, enabled: true }, revision: 3 }; return state; },
    ...(extra.firstBackup === false ? {} : { runNow: async () => { calls.push("runNow"); capturing = true; state = { ...state, pending: true }; return state; } }),
  } as unknown as BackupScheduleBridge;
  return { bridge, calls, get state() { return state; } };
}
const steps = { applyStatus: () => {}, createdKey: () => {}, notice: () => {} };
const fast = { pollMs: 1, sleep: async () => {} };

describe("first-run backups: setup ends verified", () => {
  it("a fresh install turns a local backup on, runs one, and answers verified only after it is checked", async () => {
    const h = host(3);
    expect(await ensureFirstRunBackup(h.bridge, steps, fast)).toBe("verified");
    expect(h.calls.filter((c) => c !== "status")).toEqual(["setUp", "configure", "runNow"]);
    expect(backupSetupVerified(h.state)).toBe(true);
  });
  it("never answers verified while no receipt exists", async () => {
    const h = host(10_000);
    expect(await ensureFirstRunBackup(h.bridge, steps, { ...fast, waitMs: 20 })).toBe("unverified");
    expect(backupSetupVerified(h.state)).toBe(false);
  });
  it("an app that cannot take the first backup is not called verified", async () => {
    expect(await ensureFirstRunBackup(host(1, { firstBackup: false }).bridge, steps, fast)).toBe("unverified");
  });
  it("a cancelled folder choice turns nothing on", async () => {
    const h = host(1);
    (h.bridge as unknown as { setUp: () => Promise<unknown> }).setUp = async () => ({ cancelled: true });
    expect(await ensureFirstRunBackup(h.bridge, steps, fast)).toBe("cancelled");
    expect(h.calls).not.toContain("configure");
  });
  it("a window that reopened after the backup picks up, and never sets up twice", async () => {
    const done = base({ enabled: true, refs, lastVerified: receipt, schedule: onSchedule });
    const bridge = { status: async () => done, setUp: async () => { throw Error("again"); } } as unknown as BackupScheduleBridge;
    expect(await ensureFirstRunBackup(bridge, steps, fast)).toBe("verified");
  });
  it("on without any backup behind it takes one instead of calling it done", async () => {
    const h = host(2);
    await h.bridge.setUp!(); await h.bridge.configure(2, onSchedule as never);
    h.calls.length = 0;
    expect(await ensureFirstRunBackup(h.bridge, steps, fast)).toBe("verified");
    expect(h.calls).toContain("runNow");
    expect(h.calls).not.toContain("setUp");
  });
});

describe("first-run backups: the desktop owns the first run (Settings L5)", () => {
  /** A bridge that records every call that could change backups. */
  const watched = (status: Status) => {
    const calls: string[] = [];
    const bridge = {
      status: async () => status,
      setUp: async () => { calls.push("setUp"); return status; },
      configure: async () => { calls.push("configure"); return status; },
      runNow: async () => { calls.push("runNow"); return status; },
      finishFirstRun: async (choice: string) => { calls.push(`finish:${choice}`); return status; },
    } as unknown as BackupScheduleBridge;
    return { bridge, calls };
  };

  it("reopening the card after Keep backups off turns nothing on and starts nothing", async () => {
    const w = watched(base({ firstRun: { eligible: false, completed: "off" } }));
    expect(await ensureFirstRunBackup(w.bridge, steps, fast)).toBe("off");
    expect(w.calls).toEqual([]);
  });

  it("a data folder that has had backups before keeps them as they are", async () => {
    // Backups once configured, then turned off in Settings: never a fresh setup.
    const w = watched(base({ refs, revision: 7, firstRun: { eligible: false, completed: null } }));
    expect(await ensureFirstRunBackup(w.bridge, steps, fast)).toBe("not-first-run");
    expect(w.calls).toEqual([]);
  });

  it("a finished first run is never repeated, even with backups since turned off", async () => {
    // Off now, so not verified now; still never set up again.
    const w = watched(base({ refs, firstRun: { eligible: false, completed: "verified" } }));
    expect(await ensureFirstRunBackup(w.bridge, steps, fast)).toBe("not-first-run");
    expect(w.calls).toEqual([]);
  });

  // Astra r2 R1-5: "verified" is checked against the bindings in use now.
  it("a stale verified answer for a folder and key that changed is not verified", async () => {
    const moved = { ...onSchedule, destinationRef: "d2", recoveryRef: "r2" } as Status["schedule"];
    const status = base({ enabled: true, refs: { ...refs, destinationRef: "d2", recoveryRef: "r2" }, lastVerified: receipt, schedule: moved, phase: "needs-review", firstRun: { eligible: false, completed: "verified" } });
    const w = watched(status);
    expect(await ensureFirstRunBackup(w.bridge, steps, { ...fast, waitMs: 2 })).not.toBe("verified");
    expect(w.calls).not.toContain("setUp");
  });

  // Astra r2 High: a computer where backups cannot run yet keeps the way out.
  it("an unsupported computer that still owes the step keeps the card, with Keep backups off", async () => {
    const w = watched(base({ supported: false, firstRun: { eligible: true, completed: null, owed: true } }));
    expect(await ensureFirstRunBackup(w.bridge, steps, fast)).toBe("unsupported");
    expect(w.calls).toEqual([]);
    const legacy = watched(base({ supported: false, firstRun: { eligible: false, completed: null, owed: false } }));
    expect(await ensureFirstRunBackup(legacy.bridge, steps, fast)).toBe("unavailable");
    const row = readFileSync(fileURLToPath(new URL("./FirstRunBackupsRow.tsx", import.meta.url)), "utf8");
    expect(row).toMatch(/result === "unsupported" && <><FirstRunFailure message=\{t\("settings\.l5\.firstRun\.unsupported"\)\} \/>\{tryAgain\}/);
  });

  it("records the ending with the desktop once the checked backup is there", async () => {
    const w = watched(base({ enabled: true, refs, lastVerified: receipt, schedule: onSchedule, firstRun: { eligible: false, completed: null } }));
    expect(await ensureFirstRunBackup(w.bridge, steps, fast)).toBe("verified");
    expect(w.calls).toEqual(["finish:verified"]);
  });

  it("a receipt from before the folder or key changed does not verify the new setup", async () => {
    const moved = { ...onSchedule, destinationRef: "d2", recoveryRef: "r2" } as Status["schedule"];
    const status = base({ enabled: true, refs: { ...refs, destinationRef: "d2", recoveryRef: "r2" }, lastVerified: receipt, schedule: moved, firstRun: { eligible: false, completed: null } });
    expect(backupSetupVerified(status)).toBe(false);
    const w = watched(status);
    expect(await ensureFirstRunBackup(w.bridge, steps, { ...fast, waitMs: 2 })).toBe("unverified");
    // It takes a backup of the new folder instead of calling the old one done.
    expect(w.calls).toEqual(["runNow"]);
  });
});

describe("Backups page headline", () => {
  it("says on, and when the last backup was checked", () => {
    const head = backupHeadline(base({ enabled: true, refs, lastVerified: { verifiedAt: 0, bytes: 1 } as never, schedule: { time: "03:00", enabled: true } as never }), 12 * 60_000);
    expect(head.title).toBe("Backups on");
    expect(head.lines[0]).toBe("Last backup 12 minutes ago, checked and complete.");
    expect(head.verified).toBe(true);
  });
  it("does not claim a checked backup that does not exist", () => {
    const head = backupHeadline(base({ enabled: true, refs }));
    expect(head.verified).toBe(false);
    expect(head.lines.join(" ")).not.toMatch(/checked and complete/);
  });
  it("keeps the recovery key warning and Save a copy on the first screen, and no <details> remains", () => {
    const read = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
    const page = read("./BackupSettings.tsx");
    expect(page).not.toContain("<details");
    expect(read("./BackupRemoteSettings.tsx")).not.toContain("<details");
    const body = page.slice(page.indexOf("export function BackupSettings()"));
    expect(body.indexOf("RecoveryKeyKeepsafe")).toBeGreaterThan(-1);
    expect(body.indexOf("RecoveryKeyKeepsafe")).toBeLessThan(body.indexOf("<AdvancedSection"));
    expect(body).toContain("Off-site copy");
    expect(body).toContain('section="backups"');
    // Settings search scrolls to the headline by this anchor.
    expect(page).toContain('id="backups-heading"');
  });
  it("copy has no em dashes and never says safe or unsafe", () => {
    for (const text of Object.values(FIRST_RUN_BACKUP_COPY)) expect(text).not.toMatch(/—|\bsafe|\bunsafe/i);
  });
});
