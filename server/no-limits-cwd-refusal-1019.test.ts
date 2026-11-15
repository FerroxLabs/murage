// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIM 1.0.19 R1: the invalid-command-folder refusal (server/index.ts, rule D3-command-cwd) never reached autoVerdict, so it
// carded the owner at No limits. It now goes through the one finalizer. Fixture strings are inert data, never executed.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

process.env.HOME = "/home/tester";
process.env.USERPROFILE = "/home/tester";
vi.resetModules();
const { commandFolderRefusal, commandFolderVerdict } = await import("./command-folder.ts");
type AutoContext = import("./auto-approve.ts").AutoContext;

const NO_LIMITS = { id: "b", autoApprove: true, fullAccess: true, noLimits: true };
const FULL = { id: "b", autoApprove: true, fullAccess: true };
const ASK = { id: "b", autoApprove: false };
const input = { command: "touch out", cwdInvalid: true };
const refusal = () => commandFolderRefusal(input, "/w");
const ctx = (patch: Partial<AutoContext>): AutoContext =>
  ({ commandText: "touch out", commandCwd: "", commandCwdInvalid: true, ...patch }) as AutoContext;

describe("invalid command folder under No limits", () => {
  it("the refusal itself is a typed deny (the input is a real invalid folder)", () => {
    expect(refusal()).toMatchObject({ approve: null, rule: "D3-command-cwd", classification: "deny" });
  });

  it("owner work runs with no card and one auto line", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    for (const origin of [{ fullAccessOrigin: "owner" }, { fullAccessOrigin: "routine", routineLevel: true, automated: true },
      { fullAccessOrigin: "owner-channel", channelOwner: true, unattended: true, automated: true }] as Partial<AutoContext>[]) {
      info.mockClear();
      const verdict = commandFolderVerdict(NO_LIMITS, "Bash", "touch out", refusal(), ctx(origin));
      expect(verdict, JSON.stringify(origin)).toMatchObject({ source: "no-limits" });
      expect(verdict?.approve).toBeTruthy();
      expect(info.mock.calls.filter((call) => String(call[0]).startsWith("approvals: auto "))).toHaveLength(1);
    }
    info.mockRestore();
  });

  it("another person's work, a missing or conflicting origin keep the deny card", () => {
    for (const origin of [{ fullAccessOrigin: "other" }, {}, { fullAccessOrigin: "owner", unattended: true }] as Partial<AutoContext>[]) {
      const verdict = commandFolderVerdict(NO_LIMITS, "Bash", "touch out", refusal(), ctx(origin));
      expect(verdict, JSON.stringify(origin)).toMatchObject({ approve: null, classification: "deny", rule: "D3-command-cwd" });
    }
  });

  it("a wipe-list command in that folder keeps the card even for the owner", () => {
    for (const command of ["rm -rf /", "rm -rf ~", "mkfs.ext4 /dev/sda"]) {
      const verdict = commandFolderVerdict(NO_LIMITS, "Bash", command, refusal(), ctx({ commandText: command, fullAccessOrigin: "owner" }));
      expect(verdict, command).toMatchObject({ approve: null, source: "always-ask" });
      expect(verdict?.rule).toMatch(/delete-root|delete-home|disk-erase/);
    }
  });

  it("other levels keep the card at every origin", () => {
    for (const bot of [ASK, FULL]) {
      const verdict = commandFolderVerdict(bot, "Bash", "touch out", refusal(), ctx({ fullAccessOrigin: "owner" }));
      expect(verdict).toMatchObject({ approve: null, rule: "D3-command-cwd" });
    }
  });

  it("no refusal passes through as null; a finalizer fault keeps the card", () => {
    expect(commandFolderVerdict(NO_LIMITS, "Bash", "ls", null, ctx({}))).toBeNull();
    const bad = ctx({});
    Object.defineProperty(bad, "fullAccessOrigin", { get(): never { throw new Error("fault"); } });
    expect(commandFolderVerdict(NO_LIMITS, "Bash", "touch out", refusal(), bad)).toMatchObject({ approve: null });
  });

  it("wiring: the engine's refusal goes through commandFolderVerdict, not straight to the verdict (M-cwd-bypass)", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toContain("const judgedVerdict = cwdRefusal ??");
    expect(readFileSync(new URL("./decision/implementation.ts",import.meta.url),"utf8")).toContain("else if(owner(e))");
  });
});
