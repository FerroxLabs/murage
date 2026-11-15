// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { recallPreparationFailure } from "./recall-recovery.ts";

it("routes cold admission and authority loss during assembly through bounded recovery", () => {
  for (const code of ["MEMORY_RECALL_UNAVAILABLE", "MEMORY_SCOPE_DENIED"]) {
    const cause = new Error(code);
    expect(recallPreparationFailure(cause)).toMatchObject({ message: "MEMORY_CONTEXT_REVOKED", cause });
  }
});

it("preserves pin, authentication, reset, cancellation and unknown failures exactly", () => {
  for (const failure of [
    new Error("MEMORY_PIN_UNAVAILABLE: repair or unpin the owner constraint before dispatch"),
    new Error("MEMORY_PIN_BUDGET"), new Error("MEMORY_UNAUTHORIZED"),
    new Error("MEMORY_POLICY_PENDING"), new Error("MEMORY_SESSION_RESET_UNAVAILABLE"),
    new Error("turn stopped before dispatch"), new Error("MEMORY_RECALL_UNAVAILABLE: unexpected detail"),
    new Error("fixture mount failed"), "MEMORY_RECALL_UNAVAILABLE", null,
  ]) expect(recallPreparationFailure(failure)).toBe(failure);
});
