// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  freshStartPreviewRequestSchema, freshStartConfirmRequestSchema,
  freshStartPreviewSchema, freshStartOutcomeSchema,
} from "./gh18-fresh-start-contract.ts";

const confirm = { previewToken: "opaque-preview", confirm: true, idempotencyKey: "0123456789abcdef" };
const preview = {
  policyVersion: "gh18-fresh-start-v2", botId: "bot-a", botName: "Bot A",
  state: "ready", reason: null, staleBlocks: 2, freshSessions: 1,
  retainedBlocks: 3, retainedCapped: false, previewToken: "opaque-preview", expiresAt: 1_800_000_120_000,
};
const outcome = {
  operationId: "operation-a", policyVersion: "gh18-fresh-start-v2", botId: "bot-a",
  state: "done", reason: null, clearedBlocks: 2, freshSessions: 1,
  retainedBlocks: 3, retainedCapped: false, visibilityChanged: false,
};

describe("GH18 frozen wire contract", () => {
  it("gh18_contract_rejects_unknown_fields", () => {
    for (const [schema, value] of [
      [freshStartPreviewRequestSchema, {}], [freshStartConfirmRequestSchema, confirm],
      [freshStartPreviewSchema, preview], [freshStartOutcomeSchema, outcome],
    ] as const) {
      expect(schema.safeParse(value).success).toBe(true);
      for (const field of ["ownerId", "rowIds", "revokeIds", "scopeId", "noLimits", "content"]) {
        expect(schema.safeParse({ ...value, [field]: "forbidden" }).success, field).toBe(false);
      }
    }
  });

  it("gh18_unknown_policy_fails_closed", () => {
    for (const policyVersion of ["gh18-preserve-v1", "gh18-fresh-start-v3", "", null, undefined]) {
      expect(freshStartPreviewSchema.safeParse({ ...preview, policyVersion }).success).toBe(false);
      expect(freshStartOutcomeSchema.safeParse({ ...outcome, policyVersion }).success).toBe(false);
    }
    for (const state of ["success", "cleared", "nothing-eligible", "unknown"]) {
      expect(freshStartPreviewSchema.safeParse({ ...preview, state }).success).toBe(false);
      expect(freshStartOutcomeSchema.safeParse({ ...outcome, state }).success).toBe(false);
    }
  });

  it("gh18_outcome_never_embeds_content", () => {
    for (const field of ["text", "prompt", "lineage", "revokeIds", "foreignBotName", "cursorClears", "previewToken"]) {
      expect(freshStartOutcomeSchema.safeParse({ ...outcome, [field]: "WITHDRAWN_SENTINEL" }).success).toBe(false);
    }
    expect(freshStartOutcomeSchema.safeParse({ ...outcome, reason: "WITHDRAWN_SENTINEL" }).success).toBe(false);
    expect(freshStartOutcomeSchema.safeParse({ ...outcome, retainedBlocks: { text: "WITHDRAWN_SENTINEL" } }).success).toBe(false);
    expect(freshStartOutcomeSchema.parse(outcome)).toEqual(outcome);
  });

  it("gh18_done_counts_are_integers_and_visibility_false", () => {
    expect(freshStartOutcomeSchema.safeParse(outcome).success).toBe(true);
    for (const field of ["clearedBlocks", "freshSessions", "retainedBlocks"]) {
      for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
        expect(freshStartOutcomeSchema.safeParse({ ...outcome, [field]: value }).success, `${field}=${value}`).toBe(false);
      }
    }
    for (const visibilityChanged of [true, 0, "false", undefined]) {
      expect(freshStartOutcomeSchema.safeParse({ ...outcome, visibilityChanged }).success).toBe(false);
    }
  });

  it("gh18_confirm_requires_explicit_confirmation_and_bounded_credentials", () => {
    for (const value of [null, [], "{}", undefined]) {
      expect(freshStartPreviewRequestSchema.safeParse(value).success).toBe(false);
      expect(freshStartConfirmRequestSchema.safeParse(value).success).toBe(false);
    }
    for (const value of [false, "true", 1, undefined]) {
      expect(freshStartConfirmRequestSchema.safeParse({ ...confirm, confirm: value }).success).toBe(false);
    }
    for (const previewToken of ["", "a".repeat(513), "é".repeat(257), null, undefined]) {
      expect(freshStartConfirmRequestSchema.safeParse({ ...confirm, previewToken }).success).toBe(false);
    }
    for (const idempotencyKey of ["a".repeat(15), "a".repeat(129), "é".repeat(16), undefined]) {
      expect(freshStartConfirmRequestSchema.safeParse({ ...confirm, idempotencyKey }).success).toBe(false);
    }
    for (const length of [16, 128]) {
      expect(freshStartConfirmRequestSchema.safeParse({ ...confirm, previewToken: "é".repeat(256), idempotencyKey: "a".repeat(length) }).success).toBe(true);
    }
  });

  it("gh18_states_have_truthful_reasons_and_counts", () => {
    for (const reason of ["deletion-pending", "bot-busy", "lineage-unready", "limit-exceeded", "unsupported-schema", "policy-unavailable"]) {
      expect(freshStartPreviewSchema.safeParse({ ...preview, state: "blocked", reason }).success).toBe(true);
      expect(freshStartOutcomeSchema.safeParse({ ...outcome, state: "blocked", reason, clearedBlocks: 0, freshSessions: 0 }).success).toBe(true);
      expect(freshStartOutcomeSchema.safeParse({ ...outcome, state: "blocked", reason }).success).toBe(false);
    }
    expect(freshStartPreviewSchema.safeParse({ ...preview, state: "nothing-to-do", reason: "no-change", staleBlocks: 0, freshSessions: 0 }).success).toBe(true);
    expect(freshStartOutcomeSchema.safeParse({ ...outcome, state: "nothing-to-do", reason: "no-change", clearedBlocks: 0, freshSessions: 0 }).success).toBe(true);
    for (const reason of ["no-change", "bot-busy", undefined]) {
      expect(freshStartPreviewSchema.safeParse({ ...preview, reason }).success).toBe(false);
      expect(freshStartOutcomeSchema.safeParse({ ...outcome, reason }).success).toBe(false);
    }
    expect(freshStartOutcomeSchema.safeParse({ ...outcome, state: "nothing-to-do", reason: "no-change" }).success).toBe(false);
    expect(freshStartOutcomeSchema.safeParse({ ...outcome, clearedBlocks: 0, freshSessions: 0 }).success).toBe(false);
    expect(freshStartPreviewSchema.safeParse({ ...preview, staleBlocks: 0, freshSessions: 0 }).success).toBe(false);
    // Cursor-only and mark-only changes are distinct valid results.
    expect(freshStartOutcomeSchema.safeParse({ ...outcome, clearedBlocks: 0 }).success).toBe(true);
    expect(freshStartOutcomeSchema.safeParse({ ...outcome, freshSessions: 0 }).success).toBe(true);
  });

  it("gh18_preview_and_retained_counts_are_bounded", () => {
    for (const value of [-1, 1.5, "1", NaN, Infinity, 5001]) {
      expect(freshStartPreviewSchema.safeParse({ ...preview, staleBlocks: value }).success).toBe(false);
    }
    for (const retainedBlocks of [0, 5000, 5001]) {
      const retainedCapped = retainedBlocks > 5000;
      expect(freshStartPreviewSchema.safeParse({ ...preview, retainedBlocks, retainedCapped }).success).toBe(true);
      expect(freshStartOutcomeSchema.safeParse({ ...outcome, retainedBlocks, retainedCapped }).success).toBe(true);
      expect(freshStartOutcomeSchema.safeParse({ ...outcome, retainedBlocks, retainedCapped: !retainedCapped }).success).toBe(false);
    }
    expect(freshStartOutcomeSchema.safeParse({ ...outcome, retainedBlocks: 5002, retainedCapped: true }).success).toBe(false);
    for (const expiresAt of [-1, 0.5, "tomorrow", undefined]) {
      expect(freshStartPreviewSchema.safeParse({ ...preview, expiresAt }).success).toBe(false);
    }
  });
});

it("gh18_applying_outcome_parses_with_operation_id", () => {
  expect(freshStartOutcomeSchema.parse({ ...outcome, state: "applying", reason: "cursor-save-pending" })).toEqual({ ...outcome, state: "applying", reason: "cursor-save-pending" });
});
it("gh18_applying_visibility_false_and_integer_counts", () => {
  const value = { ...outcome, state: "applying", reason: "cursor-save-pending" };
  for (const patch of [{ visibilityChanged: true }, { freshSessions: 1.5 }, { operationId: "" }, { clearedBlocks: 0, freshSessions: 0 }, { reason: null }]) expect(freshStartOutcomeSchema.safeParse({ ...value, ...patch }).success).toBe(false);
});
