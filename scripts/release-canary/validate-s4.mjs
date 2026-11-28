// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

// S4 proof grading on the throwaway repo (O23 section 3). Only a rule/permission refusal counts; a 404 on a
// resource the probe did not first prove exists, or any 5xx, is PROBE_INVALID, never a refusal.
export function gradeS4(receipt) {
  if (receipt.repo_guard !== "ok") return { state: "FAILED", reason: "REPO_GUARD" };
  if (receipt.token_scope !== "ok") return { state: "FAILED", reason: "TOKEN_SCOPE" };
  if (["404-unproven", "server-error"].includes(receipt.part_iii_a) || receipt.part_iii_b === "other") {
    return { state: "INCOMPLETE", reason: "PROBE_INVALID" };
  }
  if (receipt.part_iii_a === "accepted" || receipt.part_iii_b === "accepted") return { state: "FAILED", reason: "NOT_REFUSED" };
  for (const [part, ok] of [["PART_I", receipt.part_i], ["PART_II", receipt.part_ii], ["PART_IIIC", receipt.part_iii_c],
    ["PART_IIID", receipt.part_iii_d], ["PART_IV", receipt.part_iv.length > 0], ["PART_V", receipt.part_v]]) {
    if (!ok) return { state: "INCOMPLETE", reason: part };
  }
  return { state: "PROVEN", reason: null };
}
