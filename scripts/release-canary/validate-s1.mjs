// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

// S1 grading (O23 section 3). PROVEN only if the real updater fetched N's bytes, the relaunched process is N and
// the HASH-VALID SIGNATURE-INVALID control was refused. Switches and success lines are never sufficient.
// Returns { state, reason }; nSha256 comes from the request (the fixed source of "consumed == N").
export function gradeS1(receipt, { nSha256 }) {
  const linux = receipt.target === "linux-vm";
  const kind = linux ? "bad-asc" : "hash-valid-sig-invalid";
  if (linux && receipt.signature_source !== "completed") return { state: "INCOMPLETE", reason: "SIGNATURE_SOURCE_UNROUTED" };
  if (!receipt.updater_fetch || !["200", "206"].includes(receipt.transfer_status)) return { state: "FAILED", reason: "NO_UPDATER_FETCH" };
  if (receipt.consumed_sha256 !== nSha256) return { state: "FAILED", reason: "CONSUMED_MISMATCH" };
  // A byte-flip is refused by the yml sha512 before any signature check: it proves nothing about signatures.
  if (receipt.control_result === "absent" || receipt.control_kind !== kind) return { state: "INCOMPLETE", reason: "NO_CONTROL" };
  if (receipt.control_result === "accepted" || receipt.control_relaunched_tampered || receipt.identity === "control") {
    return { state: "FAILED", reason: "CONTROL_ACCEPTED" };
  }
  if (!receipt.relaunch) return { state: "FAILED", reason: "RELAUNCH" };
  if (receipt.identity !== "N") return { state: "FAILED", reason: "IDENTITY" };
  if (receipt.control_refusal_source === "none") return { state: "INCOMPLETE", reason: "NO_CONTROL" };
  return { state: "PROVEN", reason: null };
}
