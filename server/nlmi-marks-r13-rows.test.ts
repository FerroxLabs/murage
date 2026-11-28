// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MARKS r13: the rows of Astra r13 (_reviews/MARKS-r13-astra.md on 0d0d4a030), fixed per MurageMain's 11-07 18:40Z rulings.
// Each row goes through the whole auto-approve verdict. Rows named M-* are the witnesses of scripts/check-marks-mutations.py.
// Red before (0d0d4a030): the H1, H2 and H3 rows and M5's runs. Fixture strings are inert data, never executed.
// Historical row titles retain their IDs; current No limits assertions follow the later wipe-only ruling.
import { describe, expect, it } from "vitest";
import { expectNoLimitsOwnerOutcome } from "./testing/no-limits-1019.ts";

process.env.HOME = "/home/tester";
process.env.USERPROFILE = "/home/tester";
const { autoVerdict } = await import("./auto-approve.ts");

type Context = Parameters<typeof autoVerdict>[3];
const NO_LIMITS = { id: "owned", autoApprove: true, fullAccess: true, noLimits: true };
const FULL = { id: "owned", autoApprove: true, fullAccess: true };
const CLEAN_OWNER = { fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, outsideRead: null } as const;
const STUB = { realpath: (path: string) => path, stat: () => ({ isFile: () => true, isDirectory: () => false }) };

/** Session files by absolute path: `{ text }` or "unavailable". */
type Files = Record<string, string | "unavailable">;
function call(bot: object, cmd: string, extra: Record<string, unknown> = {}, files: Files = {}): ReturnType<typeof autoVerdict> {
  const context = {
    ...CLEAN_OWNER, commandText: cmd, commandCwd: "/w", workFolder: "/w",
    readOnlyHooks: { cwd: "/w", sessionEdits: new Set(Object.keys(files)) }, unseen: { fs: STUB, platform: "posix" },
    sessionFile: (path: string) => (path in files ? (files[path] === "unavailable" ? "unavailable" : { text: files[path]! }) : "unavailable"),
    ...extra,
  } as unknown as Context;
  return autoVerdict(bot as never, "Bash", cmd, context);
}
// OVERREACH #6 (MAIN 2026-11-26): the owner's own Full access turn runs a protected-path row, as No limits does
const runsProtectedFull = (cmd: string, extra: Record<string, unknown> = {}) => expect(call(FULL, cmd, extra).approve, cmd).toBeTruthy();
// NOLIM 1.0.19: the owner's No limits turn runs a protected-path row (only the wipe list still cards); Full access keeps the card
const runsProtected = (cmd: string, extra: Record<string, unknown> = {}) => expectNoLimitsOwnerOutcome(call(NO_LIMITS, cmd, extra), cmd, "protected-path");

describe("Astra r13 H1: a valued ln option moves the link, so no word is exempt", () => {
  it.each(["ln -sf /tmp/blob /etc/marks-link -S .bak", "ln -sf /tmp/blob /etc/marks-link --suffix .bak"])("M-R13-ln-bare %s cards at Full access and runs at No limits", cmd => {
    runsProtectedFull(cmd);
    // MAIN RULING 2026-11-13 wipe-only (S5-DESIGN.md, section 2.C): a protected link write runs at No limits.
    runsProtected(cmd);
  });
  it.each(["ln -sf /tmp/blob /etc/x", "ln -s -S .bak /tmp/blob /etc/x", "ln -s -t /etc /tmp/blob"])("the link in a system folder cards at Full access, runs at No limits: %s", cmd => {
    expect(call(FULL, cmd).approve, cmd).toBeTruthy(); // OVERREACH #6: the owner's own Full access turn runs it too
    // MAIN RULING 2026-11-13 wipe-only (S5-DESIGN.md, section 2.C): a protected link write runs at No limits.
    runsProtected(cmd);
  });
});

describe("Astra r13 M5 (R4): the link text names a protected folder, and only the link is written", () => {
  it.each(["ln -s /etc ./etc-link", "ln -s /usr/lib ./lib-link", "ln -sfn /etc/hosts ./h", "ln -s /usr/bin/x ./y"])("M-FD-ln %s runs at Full access (as at NLH0) and is the protected-path deny at the owner No limits turn", cmd => {
    // Full access keeps its existing link-text behavior. The later wipe-only
    // ruling also runs the owner's No limits turn, even if its evidence flags a protected path.
    expect(call(FULL, cmd).approve, cmd).toBeTruthy();
    runsProtected(cmd);
  });
  it("a hard link keeps both as write targets", () => {
    expect(call(FULL, "ln /etc/hosts ./h").approve).toBeTruthy(); // OVERREACH #6: runs at Full access as at No limits
  });
});

describe("Astra r13 H2: the owner-only reliefs need the owner-started proof", () => {
  // NOLIM 1.0.19 (N2.4): who started the work is the STORED origin; ownerStarted is never read. Stored "owner" runs; "other" or no stored
  // origin keeps the card.
  it.each(["node --version", "bash ./build.sh"])("M-R13-started %s runs for stored owner work, cards for another origin or none", cmd => {
    expect(call(NO_LIMITS, cmd).approve, `${cmd} on the owner's own turn`).toBeTruthy();
    expect(call(NO_LIMITS, cmd, { ownerStarted: false }).approve, cmd).toBeTruthy();
    expect(call(NO_LIMITS, cmd, { ownerStarted: undefined }).approve, cmd).toBeTruthy();
    expect(call(NO_LIMITS, cmd, { fullAccessOrigin: "other" }).approve, `${cmd} other origin`).toBeNull();
    expect(call(NO_LIMITS, cmd, { fullAccessOrigin: undefined }).approve, `${cmd} no stored origin`).toBeNull();
  });
  it("M-R11-unseen-owner bash ./build.sh on stored owner work runs without ownerStarted, another origin keeps the card", () => {
    expect(call(NO_LIMITS, "bash ./build.sh", { ownerStarted: false }).approve).toBeTruthy();
    expect(call(NO_LIMITS, "bash ./build.sh", { ownerStarted: false, fullAccessOrigin: "other" }).approve).toBeNull();
  });
  // the always-ask.test.ts rows that run only on the owner's own No limits turn with its proof (MurageMain 11-07): the same
  // commands without the proof, from another origin, or at Full access keep their hold (shipped f28a6bad8 holds them too)
  const PROJECT = "/home/tester/project";
  it.each(["env -i PATH=/bin ls", "env -i PATH=/usr/bin bash -lc ls", "(( a < b )) && (( x << 2 ))"])("M-R13-started %s holds without the owner-started proof", cmd => {
    const exact = { exactCommand: { command: cmd, cwd: PROJECT, engine: "claude" } };
    const proof = { fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, outsideRead: null };
    expect(autoVerdict(NO_LIMITS as never, "Bash", cmd, { ...exact, ...proof } as unknown as Context).approve, `${cmd} with the proof`).toBeTruthy();
    // NOLIM 1.0.19 (N2.4): a stored owner origin runs without ownerStarted; another origin keeps the card
    for (const extra of [{ ownerStarted: false }, { ownerStarted: undefined }]) {
      expect(autoVerdict(NO_LIMITS as never, "Bash", cmd, { ...exact, ...proof, ...extra } as unknown as Context).approve, `${cmd} ${JSON.stringify(extra)}`).toBeTruthy();
    }
    for (const extra of [{ fullAccessOrigin: "other", ownerStarted: false }]) {
      expect(autoVerdict(NO_LIMITS as never, "Bash", cmd, { ...exact, ...proof, ...extra } as unknown as Context).approve, `${cmd} ${JSON.stringify(extra)}`).toBeNull();
      expect(autoVerdict(NO_LIMITS as never, "Bash", cmd, { ...proof, ...extra } as unknown as Context).approve, `${cmd} no cwd ${JSON.stringify(extra)}`).toBeNull();
    }
    expect(autoVerdict(NO_LIMITS as never, "Bash", cmd, exact as unknown as Context).approve, `${cmd} with no proof at all`).toBeNull();
    expect(autoVerdict(FULL as never, "Bash", cmd, { ...exact, ...proof } as unknown as Context).approve, `${cmd} at Full access`).toBeNull();
  });
  it.each(["node --version", "bash ./build.sh"])("a channel turn keeps the card: %s", cmd => {
    expect(call(NO_LIMITS, cmd, { channelOwner: true }).approve, cmd).toBeNull();
  });
});

describe("Astra r13 H3 (R2): a script a deny rule names cards at every level", () => {
  it.each(["bash /etc/tool.sh", "bash /usr/share/tool.sh", "python3 /usr/lib/tool.py"])("M-R11-unseen-deny Full access %s keeps the card, No limits runs it", cmd => {
    runsProtectedFull(cmd);
    runsProtected(cmd);
  });
  it.each(["bash ./build.sh", "node tvcall.mjs"])("an allowed-shape script still runs at Full access: %s", cmd => {
    expect(call(FULL, cmd).approve, cmd).toBeTruthy();
  });
});

describe("Astra r13 L7: a session file the reader cannot read holds in the doubt-free read too", () => {
  // MAIN-RULING 2026-11-27 (3): Full access is never looser than No limits, and a written script the wipe check cannot read is a wipe-check
  // fault at both: the same card (it ran at No limits before, as could-not-read; the wipe check now reads the body, so it cannot be skipped)
  it("python3 ./build.py with no bytes for ./build.py takes the same wipe-check card at Full access and at No limits", () => {
    const files = { "/w/build.py": "unavailable" };
    expect(call(FULL, "python3 ./build.py", {}, files)).toMatchObject({ approve: null, source: "always-ask" });
    expect(call(NO_LIMITS, "python3 ./build.py", {}, files)).toMatchObject({ approve: null, source: "always-ask", rule: "wipe-check-fault" });
    expect(call(FULL, "python3 ./build.py", {}, files).rule).toBe("wipe-check-fault");
  });
});
