// Full access, the level above Auto: which approvals it answers, which it
// leaves to a person, and who may switch it on. The HTTP wiring is pinned in
// full-access-api.test.ts; these pin the rules themselves.
import { describe, expect, it } from "vitest";

import { approvalHoldNote, autoVerdict, hasFullAccess } from "./auto-approve.ts";
import { FULL_ACCESS_ACK_REQUIRED, fullAccessChange } from "./full-access.ts";

const full = { autoApprove: true, fullAccess: true, alwaysAllow: [] };
const auto = { autoApprove: true, fullAccess: false, alwaysAllow: [] };

describe("Full access verdicts", () => {
  // what Auto stops at, and Full access does not: a destructive command
  // inside its folder, a personal folder read, host control
  const autoStops: Array<[string, string, "local-computer" | undefined]> = [
    ["Bash", "rm -rf build", undefined],
    ["Read", "~/Documents/tax-return.pdf", undefined],
    ["computer_click", "click the Send button", "local-computer"],
  ];

  for (const [tool, summary, scope] of autoStops) {
    it(`raises no card in a turn the owner started: ${summary}`, () => {
      const verdict = autoVerdict(full, tool, summary, { scope, stopLine: null });
      expect(verdict.source).toBe("full-access");
      expect(verdict.approve).toContain("full access");
    });
  }

  // the key guard still holds under Full access: a bot reading your keys is
  // quiet, permanent and unrecoverable
  for (const [tool, summary] of [["Bash", "cat ~/.zshrc"], ["Bash", "echo $OPENAI_API_KEY"], ["Bash", "cat ~/.aws/credentials"], ["Read", "~/.ssh/id_ed25519"]]) {
    it(`still stops before a key: ${summary}`, () => {
      const verdict = autoVerdict(full, tool, summary, { stopLine: null });
      expect(verdict.source).toBe("sensitive-guard");
      expect(verdict.approve).toBeNull();
    });
  }

  describe("the stop line", () => {
    const hit = (kind: "delete" | "pay" | "message", place?: string, what = "Delete 1 item outside its folder: ~/Documents/x") =>
      ({ kind, ...(place ? { place } : {}), what });
    const outside = hit("delete", "/Users/ada/Documents");

    it("stops Full access before the three kinds, and says what and why", () => {
      for (const stop of [outside, hit("pay", "stripe:cus_1", "Make a payment (stripe create charge) for cus_1"), hit("message", "new@x.com", "Message someone it has not written to before: new@x.com")]) {
        const verdict = autoVerdict(full, "Bash", "whatever", { stopLine: stop });
        expect(verdict).toMatchObject({ approve: null, source: "stop-line", rule: stop.kind, note: stop.what });
        expect(approvalHoldNote(verdict)).toBe(stop.what);
      }
    });

    it("holds under Auto, Ask, routines and webhooks too", () => {
      expect(autoVerdict(auto, "Bash", "x", { stopLine: outside }).source).toBe("stop-line");
      expect(autoVerdict({ autoApprove: false }, "Bash", "x", { stopLine: outside }).source).toBe("stop-line");
      expect(autoVerdict(full, "Bash", "x", { stopLine: outside, automated: true }).approve).toBeNull();
      expect(autoVerdict(full, "Bash", "x", { stopLine: outside, unattended: true }).approve).toBeNull();
      expect(autoVerdict(full, "Bash", "x", { stopLine: outside, unattended: true, automated: true, channelOwner: true }).approve).toBeNull();
    });

    it("an old bare-tool grant never covers a stop", () => {
      const granted = { ...full, alwaysAllow: ["Bash:rm", "mcp__stripe__create_charge"] };
      expect(autoVerdict(granted, "Bash", "rm -rf ~/Documents/x", { stopLine: outside }).source).toBe("stop-line");
      expect(autoVerdict(granted, "mcp__stripe__create_charge", "{}", { stopLine: hit("pay", "stripe:cus_1") }).source).toBe("stop-line");
    });

    it("a scoped always-allow covers the same place, attended only", () => {
      const granted = { ...full, alwaysAllow: ["stop:delete:/Users/ada/Documents"] };
      expect(autoVerdict(granted, "Bash", "x", { stopLine: hit("delete", "/Users/ada/Documents/old") })).toMatchObject({ source: "always-allow", rule: "stop:delete:/Users/ada/Documents" });
      expect(autoVerdict(granted, "Bash", "x", { stopLine: hit("delete", "/Users/ada/Desktop") }).source).toBe("stop-line");
      expect(autoVerdict(granted, "Bash", "x", { stopLine: outside, unattended: true }).source).toBe("unattended-block");
    });

    it("an allowance for this task covers it only on a turn the owner is at", () => {
      expect(autoVerdict(full, "Bash", "x", { stopLine: outside, stopAllowedForTask: "stop:delete:/Users/ada/Documents" })).toMatchObject({ source: "task-allowance", rule: "stop:delete:/Users/ada/Documents" });
      expect(autoVerdict(full, "Bash", "x", { stopLine: outside, stopAllowedForTask: "stop:delete:/Users/ada/Documents", automated: true }).approve).toBeNull();
      expect(autoVerdict(full, "Bash", "x", { stopLine: outside, stopAllowedForTask: "stop:delete:/Users/ada/Documents", unattended: true }).approve).toBeNull();
    });

    it("an allowance never overrides the key guard", () => {
      expect(autoVerdict(full, "Bash", "rm ~/.ssh/id_rsa", { stopLine: outside, stopAllowedForTask: "stop:delete:/Users/ada/Documents" }).source).toBe("sensitive-guard");
    });

    it("nothing crossing the line keeps Full access fast", () => {
      expect(autoVerdict(full, "Bash", "rm -rf build", { stopLine: null }).source).toBe("full-access");
    });
  });

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
