// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

// S3 grading: graceful quit per OS. The shutdown lines (after the mark, in order) are the evidence on every OS.
export function gradeS3(receipt) {
  const { stop, exited } = receipt;
  const killed = receipt.wait_signal === "SIGKILL";
  if (receipt.exit_ms > 60000 || killed || !stop?.after_mark || !exited?.after_mark || exited.line <= stop.line) {
    return { state: "FAILED", reason: "NO_GRACEFUL_QUIT" };
  }
  if (receipt.hard_kill_control === "absent") return { state: "INCOMPLETE", reason: "NO_CONTROL" };
  if (receipt.hard_kill_control === "graded-passed") return { state: "FAILED", reason: "CONTROL_ACCEPTED" };
  return { state: "PROVEN", reason: null };
}
