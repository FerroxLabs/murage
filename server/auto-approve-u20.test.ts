// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// U20 (Rule 74d): when the consistency check of the handed environment failed, the command ask's F12 record says so with
// its cause, and the verdict holds the card naming that cause at every level, as every other unread call is held.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { approvalHoldNote, autoVerdict, type AutoApprover } from "./auto-approve.ts";

const cause = "the environment changed while it was being checked";
const levels: AutoApprover[] = [
  { alwaysAllow: ["Bash:ls"] },
  { autoApprove: true },
  { autoApprove: true, fullAccess: true },
  { autoApprove: true, fullAccess: true, noLimits: true },
];

describe("U20 reaches the card", () => {
  it("a command ask whose environment check failed is held with the cause, at every level", () => {
    for (const bot of levels) {
      const verdict = autoVerdict(bot, "Bash", "ls", { exactCommand: { command: "ls", cwd: "/tmp/p" } as never, envUnread: cause });
      expect(verdict, JSON.stringify(bot)).toMatchObject({ approve: null, source: "unread-call" });
      expect(verdict.rule).toContain(cause);
      expect(approvalHoldNote(verdict)).toContain(cause);
    }
  });

  it("without U20 the same ask is answered as before", () => {
    expect(autoVerdict({ alwaysAllow: ["Bash:ls"] }, "Bash", "ls", { exactCommand: { command: "ls", cwd: "/tmp/p" } as never }).approve).not.toBeNull();
  });

  it("the harness hands the F12 record's U20 cause to the verdict", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toMatch(/envUnread: event\.execEnv\?\.unread\?\.cause/);
    // only on a command ask (Astra r6 item 8)
    expect(source).toMatch(/event\.execEnv\?\.unread && \(exactCommand !== undefined \|\| isCommandTool\(event\.tool\)/);
  });
});

describe("U19 reaches the card (Rule 68f case 1, Astra r6 item 1)", () => {
  const pins = new Map([["GIT_ASKPASS", ""], ["GIT_TERMINAL_PROMPT", "0"], ["PAGER", "cat"]]);
  it("a per-command value other than its pin holds at every level; the pinned value and plain git do not", () => {
    for (const bot of [...levels, { alwaysAllow: ["Bash:git"] }]) {
      for (const command of ["GIT_ASKPASS=/x git fetch", "git -c core.sshCommand=x fetch", "env GIT_ASKPASS=/tmp/askpass git fetch",
        // Astra r7 item 1: carried through a wrapper, removed by env, set earlier on the line, hidden by a user switch
        "GIT_ASKPASS=/tmp/askpass env git fetch", "GIT_ASKPASS=/x nice git fetch", "env -u GIT_ASKPASS git fetch", "env -i git fetch",
        "export GIT_ASKPASS=/x; git fetch", "GIT_ASKPASS=/x bash -c 'git fetch'", "sudo -n git fetch"]) {
        const verdict = autoVerdict(bot, "Bash", command, { exactCommand: { command, cwd: "/tmp/p" } as never, handedPins: pins });
        // 875166e91 (NOLIMITS 1.0.18 allow-list core, merged in 710480d3d): at owner No limits the always-ask reader now holds some of these
        // as unreadable (measured: approve null, source always-ask, rule unreadable) before the unread-call hold is reached. Every one still asks.
        const verdictSource = (bot as { noLimits?: boolean }).noLimits === true ? ["unread-call", "always-ask"] : ["unread-call"];
        expect(verdict.approve, `${JSON.stringify(bot)} ${command}`).toBeNull();
        expect(verdictSource, `${JSON.stringify(bot)} ${command}`).toContain(verdict.source);
        // the note names the pinned name, the option, or (Astra r8: any env clearing holds) the env form
        if (verdict.source === "unread-call") expect(approvalHoldNote(verdict)).toMatch(/GIT_ASKPASS|core\.sshCommand|PAGER|env -i /);
      }
    }
    for (const command of ["git log", "GIT_ASKPASS= git log", "PAGER=cat git log"]) {
      expect(autoVerdict({ alwaysAllow: ["Bash:git"] }, "Bash", command, { exactCommand: { command, cwd: "/tmp/p" } as never, handedPins: pins }).approve, command).not.toBeNull();
    }
  });

  it("the harness hands the requesting engine's pins to the verdict", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toMatch(/handedPins/);
  });
});
