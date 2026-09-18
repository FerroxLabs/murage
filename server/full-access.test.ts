// Full access, the level above Auto: which approvals it answers, which it
// leaves to a person, and who may switch it on. The HTTP wiring is pinned in
// full-access-api.test.ts; these pin the rules themselves.
import { describe, expect, it } from "vitest";

import { approvalHoldNote, autoVerdict, hasFullAccess } from "./auto-approve.ts";
import { FULL_ACCESS_ACK_REQUIRED, fullAccessChange } from "./full-access.ts";

const full = { autoApprove: true, fullAccess: true, alwaysAllow: [] };
const auto = { autoApprove: true, fullAccess: false, alwaysAllow: [] };

describe("Full access verdicts", () => {
  // what Auto stops at: shell profiles, API-key variables, credential stores,
  // a destructive command — plus a personal folder and host control
  const autoStops: Array<[string, string, "local-computer" | undefined]> = [
    ["Bash", "cat ~/.zshrc", undefined],
    ["Bash", "echo $OPENAI_API_KEY", undefined],
    ["Bash", "cat ~/.aws/credentials", undefined],
    ["Read", "~/.ssh/id_ed25519", undefined],
    ["Bash", "rm -rf build", undefined],
    ["Read", "~/Documents/tax-return.pdf", undefined],
    ["computer_click", "click the Send button", "local-computer"],
  ];

  for (const [tool, summary, scope] of autoStops) {
    it(`raises no card in a turn the owner started: ${summary}`, () => {
      const verdict = autoVerdict(full, tool, summary, { scope });
      expect(verdict.source).toBe("full-access");
      expect(verdict.approve).toContain("full access");
    });
  }

  it("switching back to Auto restores Auto's stops", () => {
    expect(autoVerdict(auto, "Bash", "cat ~/.zshrc").source).toBe("sensitive-guard");
    expect(autoVerdict(auto, "Bash", "rm -rf build").source).toBe("destructive-guard");
    expect(autoVerdict(auto, "Bash", "cat ~/.zshrc").approve).toBeNull();
  });

  it("a webhook (unattended) turn still asks, exactly as under Auto", () => {
    const fullVerdict = autoVerdict(full, "Bash", "ls", { unattended: true });
    expect(fullVerdict).toEqual(autoVerdict(auto, "Bash", "ls", { unattended: true }));
    expect(fullVerdict.approve).toBeNull();
    expect(approvalHoldNote(fullVerdict)).toContain("outside the desktop");
  });

  it("a routine turn is judged as Auto would judge it", () => {
    const sensitive = autoVerdict(full, "Bash", "cat ~/.zshrc", { automated: true });
    expect(sensitive).toEqual(autoVerdict(auto, "Bash", "cat ~/.zshrc", { automated: true }));
    expect(sensitive.source).toBe("sensitive-guard");
    // and what Auto would let through still goes through
    expect(autoVerdict(full, "Bash", "ls", { automated: true }).source).toBe("auto-mode");
  });

  it("a question is still the owner's to answer", () => {
    expect(autoVerdict(full, "AskUserQuestion", "Which branch?").source).toBe("question-tool");
    expect(autoVerdict(full, "Bash", "ls", { question: true }).approve).toBeNull();
  });

  it("counts only while Auto is on too", () => {
    expect(hasFullAccess(full)).toBe(true);
    expect(hasFullAccess({ autoApprove: false, fullAccess: true })).toBe(false);
    expect(autoVerdict({ autoApprove: false, fullAccess: true }, "Bash", "cat ~/.zshrc").source).toBe("sensitive-guard");
    expect(hasFullAccess(null)).toBe(false);
  });
});

describe("switching Full access on", () => {
  const fresh = { fullAccessAcknowledgedAt: undefined };
  const warned = { fullAccessAcknowledgedAt: 1 };

  it("is refused from anything but the desktop app", () => {
    expect(fullAccessChange({ fullAccess: true, acknowledgeFullAccess: true }, warned, false)).toMatchObject({ ok: false, status: 404 });
  });

  it("needs the warning the first time for a bot, and records it", () => {
    expect(fullAccessChange({ fullAccess: true }, fresh, true)).toEqual({ ok: false, status: 400, error: FULL_ACCESS_ACK_REQUIRED });
    expect(fullAccessChange({ fullAccess: true, acknowledgeFullAccess: true }, fresh, true, 42)).toEqual({
      ok: true, autoApprove: true, fullAccess: true, acknowledgedAt: 42,
    });
  });

  it("does not ask again once the bot's warning was confirmed", () => {
    expect(fullAccessChange({ fullAccess: true }, warned, true)).toEqual({ ok: true, autoApprove: true, fullAccess: true });
  });

  it("ends with any other Auto change, so a stale flag cannot come back", () => {
    expect(fullAccessChange({ autoApprove: true }, warned, true)).toEqual({ ok: true, fullAccess: false });
    expect(fullAccessChange({ autoApprove: false }, warned, false)).toEqual({ ok: true, fullAccess: false });
    expect(fullAccessChange({ fullAccess: false }, warned, false)).toEqual({ ok: true, fullAccess: false });
    expect(fullAccessChange({ title: "x" }, warned, true)).toEqual({ ok: true });
  });

  it("rejects contradictions and non-booleans", () => {
    expect(fullAccessChange({ fullAccess: true, autoApprove: false, acknowledgeFullAccess: true }, warned, true)).toMatchObject({ ok: false, status: 400 });
    expect(fullAccessChange({ fullAccess: "yes" }, warned, true)).toMatchObject({ ok: false, status: 400 });
    expect(fullAccessChange({ fullAccess: true, acknowledgeFullAccess: "yes" }, fresh, true)).toMatchObject({ ok: false, status: 400 });
  });
});
