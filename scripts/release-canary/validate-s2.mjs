// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

// S2 grading: two fresh-user runs on the same credential epoch both complete a real turn, residue and core
// absent, the file deleted with the user, and the no-credential control refused (O23 section 3, G7).
export function gradeS2(receipt, { epoch }) {
  const runs = receipt.runs;
  if (runs.length >= 2 && runs[1].auth_error) return { state: "FAILED", reason: "CREDENTIAL_ROTATED" };
  const good = (run) => run.completed && run.real_reply && !run.sign_in_ui && run.credential_valid && run.epoch === epoch;
  if (runs.length !== 2 || !runs.every(good)) return { state: "FAILED", reason: "RUNS" };
  if (receipt.residue || receipt.core) return { state: "FAILED", reason: "RESIDUE" };
  if (!runs.every((run) => run.file_deleted)) return { state: "FAILED", reason: "FILE_NOT_DELETED" };
  if (receipt.control === "absent") return { state: "INCOMPLETE", reason: "NO_CONTROL" };
  if (receipt.control === "completed") return { state: "FAILED", reason: "CONTROL_ACCEPTED" };
  return { state: "PROVEN", reason: null };
}
