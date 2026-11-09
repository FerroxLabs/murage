// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MARKS r13: the rows of Astra r13 (_reviews/MARKS-r13-astra.md on 0d0d4a030), fixed per MurageMain's 11-07 18:40Z rulings.
// Each row goes through the whole auto-approve verdict. Rows named M-* are the witnesses of scripts/check-marks-mutations.py.
// Red before (0d0d4a030): the H1, H2 and H3 rows and M5's runs. Fixture strings are inert data, never executed.
import { describe, expect, it } from "vitest";

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
const cardsProtected = (bot: object, cmd: string, extra: Record<string, unknown> = {}) => {
  const verdict = call(bot, cmd, extra);
  expect(verdict.approve, cmd).toBeNull();
  expect(verdict, cmd).toMatchObject({ source: "always-ask", rule: "protected-path" });
};

describe("Astra r13 H1: a valued ln option moves the link, so no word is exempt", () => {
  it.each(["ln -sf /tmp/blob /etc/marks-link -S .bak", "ln -sf /tmp/blob /etc/marks-link --suffix .bak"])("M-R13-ln-bare %s cards at Full access and No limits", cmd => {
    cardsProtected(FULL, cmd);
    cardsProtected(NO_LIMITS, cmd);
  });
  it.each(["ln -sf /tmp/blob /etc/x", "ln -s -S .bak /tmp/blob /etc/x", "ln -s -t /etc /tmp/blob"])("the link in a system folder cards: %s", cmd => {
    expect(call(FULL, cmd).approve, cmd).toBeNull();
    expect(call(NO_LIMITS, cmd).approve, cmd).toBeNull();
  });
});

describe("Astra r13 M5 (R4): the link text names a protected folder, and only the link is written", () => {
  it.each(["ln -s /etc ./etc-link", "ln -s /usr/lib ./lib-link", "ln -sfn /etc/hosts ./h", "ln -s /usr/bin/x ./y"])("M-FD-ln %s runs at Full access (as at NLH0) and is the protected-path deny at the owner No limits turn", cmd => {
    // MARKS R2 (MurageMain 11-08, MARKS-r14-DENY-CLASS.md:68 rule 4): a link whose text names a protected folder is a protected-path deny at the
    // owner No limits turn. R1 keeps Full access and every other origin byte-identical to NLH0, where the link runs.
    expect(call(FULL, cmd).approve, cmd).toBeTruthy();
    cardsProtected(NO_LIMITS, cmd);
  });
  it("a hard link keeps both as write targets", () => {
    expect(call(FULL, "ln /etc/hosts ./h").approve).toBeNull();
  });
});

describe("Astra r13 H2: the owner-only reliefs need the owner-started proof", () => {
  it.each(["node --version", "bash ./build.sh"])("M-R13-started %s on a turn the owner did not start keeps the card", cmd => {
    expect(call(NO_LIMITS, cmd).approve, `${cmd} on the owner's own turn`).toBeTruthy();
    expect(call(NO_LIMITS, cmd, { ownerStarted: false }).approve, cmd).toBeNull();
    expect(call(NO_LIMITS, cmd, { ownerStarted: undefined }).approve, cmd).toBeNull();
  });
  it("M-R11-unseen-owner bash ./build.sh on a turn the owner did not start keeps the card", () => {
    expect(call(NO_LIMITS, "bash ./build.sh", { ownerStarted: false }).approve).toBeNull();
  });
  // the always-ask.test.ts rows that run only on the owner's own No limits turn with its proof (MurageMain 11-07): the same
  // commands without the proof, from another origin, or at Full access keep their hold (shipped f28a6bad8 holds them too)
  const PROJECT = "/home/tester/project";
  it.each(["env -i PATH=/bin ls", "env -i PATH=/usr/bin bash -lc ls", "(( a < b )) && (( x << 2 ))"])("M-R13-started %s holds without the owner-started proof", cmd => {
    const exact = { exactCommand: { command: cmd, cwd: PROJECT, engine: "claude" } };
    const proof = { fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, outsideRead: null };
    expect(autoVerdict(NO_LIMITS as never, "Bash", cmd, { ...exact, ...proof } as unknown as Context).approve, `${cmd} with the proof`).toBeTruthy();
    for (const extra of [{ ownerStarted: false }, { ownerStarted: undefined }, { fullAccessOrigin: "other", ownerStarted: false }]) {
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
  it.each(["bash /etc/tool.sh", "bash /usr/share/tool.sh", "python3 /usr/lib/tool.py"])("M-R11-unseen-deny Full access %s keeps the card", cmd => {
    cardsProtected(FULL, cmd);
    cardsProtected(NO_LIMITS, cmd);
  });
  it.each(["bash ./build.sh", "node tvcall.mjs"])("an allowed-shape script still runs at Full access: %s", cmd => {
    expect(call(FULL, cmd).approve, cmd).toBeTruthy();
  });
});

describe("Astra r13 L7: a session file the reader cannot read holds in the doubt-free read too", () => {
  it.each([FULL, NO_LIMITS])("python3 ./build.py with no bytes for ./build.py holds (%o)", bot => {
    expect(call(bot, "python3 ./build.py", {}, { "/w/build.py": "unavailable" }).approve).toBeNull();
  });
});
