// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// P9 (1.0.24): the plain reason for each code Murage itself throws on a reply's start path. The line never asks the owner to send again.
import { describe, expect, it } from "vitest";
import { isMurageStartFailureCode, isMurageStartFailureLine, murageStartFailureLine } from "./murage-start-failure.ts";

describe("murageStartFailureLine", () => {
  it.each([
    ["wipe-guard-invalid-turn", "its delete protection could not be set up"],
    ["wipe-path-probe-failed", "its delete protection could not be set up"],
    ["wipe-root-inventory-unavailable", "its delete protection could not be set up"],
    ["instance_not_attached", "its AI engine was reloaded"],
    ["invalid_attachment", "its AI engine changed"],
    ["provider_route_changed", "the AI service picked for this bot changed"],
    ["provider_stop_unconfirmed", "had not confirmed that its previous reply stopped"],
    ["decision-dispatch-without-provenance", "lost track of which message"],
    ["browser_turn_cancelled", "browser task this reply needed was cancelled"],
    ["memory_not_ready", "memory was not ready in time"],
  ])("%s names its real cause and never says 'send it again'", (code, reason) => {
    const line = murageStartFailureLine(code);
    expect(line).toMatch(/^Murage couldn't start this reply because /);
    expect(line).toContain(reason);
    expect(line).not.toMatch(/send it again/i);
    expect(line).not.toContain(code);
    expect(isMurageStartFailureLine(line)).toBe(true);
    expect(isMurageStartFailureCode(code)).toBe(true);
  });
  it("an engine's own code is not Murage's", () => {
    for (const code of ["invalid_api_key", "usage_limit_reached", "rate_limit_exceeded", "model_not_found"]) expect(isMurageStartFailureCode(code)).toBe(false);
    expect(isMurageStartFailureLine("error: invalid_api_key")).toBe(false);
  });
});
