// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Stop and failure lines are shown to the owner in the chat. They name the
// engine and the step in plain words: never an environment variable, a
// JSON-RPC or app-server method, a driver's internal kind or a millisecond
// figure. "timed out" stays in the timeout lines so the Inbox groups them
// with other passing provider trouble.
import { describe, expect, it } from "vitest";

import { acpRequestTimeoutMessage, acpStopReasonMessage } from "./acp/core.ts";
import { antigravityResultFailure } from "./antigravity.ts";
import { codexRpcTimeoutMessage } from "./codex.ts";
import { engineClosedLine, plainDuration } from "./stop-copy.ts";

const INTERNAL = /MURAGE_|_MS\b|\d+ ?ms\b|session\/|initialize|thread\/|turn\/|prompt result|Agent\b|max_tokens|max_turn_requests/;

describe("stop line copy", () => {
  it("says a wait in seconds, minutes or hours", () => {
    expect(plainDuration(150)).toBe("1 second");
    expect(plainDuration(90_000)).toBe("90 seconds");
    expect(plainDuration(180_000)).toBe("3 minutes");
    expect(plainDuration(60 * 60_000)).toBe("60 minutes");
    expect(plainDuration(3 * 60 * 60_000)).toBe("3 hours");
  });

  it("says how an engine closed, without a missing exit code or protocol names", () => {
    expect(engineClosedLine("Fuigo", 1)).toBe("Fuigo closed (exit code 1) before it finished its reply");
    expect(engineClosedLine("Codex", null, "SIGKILL")).toBe("Codex closed (signal SIGKILL) before it finished its reply");
    expect(engineClosedLine("Codex", 137, "SIGKILL", "out of memory")).toBe("Codex closed (exit code 137, signal SIGKILL) before it finished its reply: out of memory");
    expect(engineClosedLine("Claude", null)).toBe("Claude closed before it finished its reply");
  });

  it("names the engine and the step when an ACP request times out", () => {
    expect(acpRequestTimeoutMessage("Fuigo", "initialize")).toBe("Fuigo timed out while starting.");
    expect(acpRequestTimeoutMessage("Fuigo", "session/new")).toBe("Fuigo timed out while opening the conversation.");
    expect(acpRequestTimeoutMessage("Fuigo", "session/load")).toBe("Fuigo timed out while opening the conversation.");
    expect(acpRequestTimeoutMessage("Fuigo", "session/set_model")).toBe("Fuigo timed out while applying this conversation's settings.");
    for (const method of ["initialize", "authenticate", "session/new", "session/load", "session/prompt", "session/set_mode", "x/other"]) {
      expect(acpRequestTimeoutMessage("Fuigo", method)).not.toMatch(INTERNAL);
      expect(acpRequestTimeoutMessage("Fuigo", method)).toMatch(/^Fuigo timed out/);
    }
  });

  it("says why an ACP engine ended a turn early without its stop reason code", () => {
    expect(acpStopReasonMessage("Grok", "max_tokens")).toMatch(/^Grok reached its reply length limit, so this turn ended early\. /);
    expect(acpStopReasonMessage("Grok", "max_turn_requests")).toMatch(/^Grok reached its limit of steps for one turn, so this turn ended early\. /);
    expect(acpStopReasonMessage("Grok", "refusal")).toMatch(/^Grok declined to continue, so this turn ended early\. /);
    for (const reason of [undefined, null, "something_new"]) expect(acpStopReasonMessage("Grok", reason)).toMatch(/^Grok stopped before it finished, so this turn ended early\. /);
  });

  it("gives each stop reason its own next step, not one shared line (upstream d1502c648, 0bbd9d4c5)", () => {
    const next = (reason: string | null) => acpStopReasonMessage("Grok", reason).replace(/^.*?ended early\. /, "");
    expect(next("max_tokens")).toBe("Ask it to continue, or ask for a shorter answer.");
    expect(next("max_turn_requests")).toBe("Ask it to carry on from where it stopped, or split the task.");
    expect(next("refusal")).toBe("Reword the request, or switch this bot to another AI.");
    expect(next(null)).toBe("Send the message again.");
    expect(next("something_new")).toBe("Send the message again.");
    const steps = ["max_tokens", "max_turn_requests", "refusal", null].map(next);
    expect(new Set(steps).size).toBe(steps.length);
    for (const reason of ["max_tokens", "max_turn_requests", "refusal", null]) expect(acpStopReasonMessage("Grok", reason)).not.toMatch(INTERNAL);
  });

  it("says why Antigravity ended a turn in plain words, never a bare \"Model turn failed: <status>\" (upstream d67c1b335)", () => {
    expect(antigravityResultFailure({ status: "MAX_TOKENS" })).toBe("Antigravity reached its reply length limit, so this turn ended early. Ask it to continue, or ask for a shorter answer.");
    expect(antigravityResultFailure({ status: "MAX_TURNS" })).toBe("Antigravity reached its limit of steps for one turn, so this turn ended early. Ask it to carry on from where it stopped, or split the task.");
    expect(antigravityResultFailure({ status: "REFUSAL" })).toBe("Antigravity declined to continue, so this turn ended early. Reword the request, or switch this bot to another AI.");
    for (const status of [undefined, "", "ERROR", "SOMETHING_NEW"]) {
      const line = antigravityResultFailure({ status });
      expect(line).toBe("Antigravity stopped before it finished, so this turn ended early. Send the message again.");
      expect(line).not.toMatch(INTERNAL);
      expect(line).not.toContain("Model turn failed");
    }
    // agy's own words win when it gave any
    expect(antigravityResultFailure({ status: "ERROR", message: "Quota exceeded for this account." })).toBe("Quota exceeded for this account.");
    expect(antigravityResultFailure({ status: "ERROR", error: "Sign in again." })).toBe("Sign in again.");
  });

  it("names the step and a plain duration when a Codex request times out", () => {
    expect(codexRpcTimeoutMessage("initialize", 60_000)).toBe("Codex timed out while starting (no answer for 60 seconds).");
    expect(codexRpcTimeoutMessage("thread/start", 60_000)).toBe("Codex timed out while opening the conversation (no answer for 60 seconds).");
    expect(codexRpcTimeoutMessage("turn/start", 60_000)).toBe("Codex timed out while starting the turn (no answer for 60 seconds).");
    for (const method of ["initialize", "thread/start", "thread/resume", "turn/start", "review/start", "skills/list"]) {
      expect(codexRpcTimeoutMessage(method, 10_000)).not.toMatch(INTERNAL);
    }
  });
});
