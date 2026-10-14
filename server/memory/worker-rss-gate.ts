// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The helper's memory gate (verify-memory-faults.ts): the helper's peak resident memory under load must stay under a limit.
// The figure used to ride in every search answer and was read back as "0 when absent", so when it was removed from answers
// (it is shaped by records a reader may not read) the gate went on passing, measuring nothing. It is now measured privately
// from the helper's own replies inside the server process, and a gate with no measurement FAILS.
export function workerMemoryGate(measured: { workerPeakRssBytes?: unknown; workerRssSamples?: unknown }, limitBytes: number): { ok: boolean; reason?: string } {
  const samples = Number(measured.workerRssSamples), peak = Number(measured.workerPeakRssBytes);
  if (!Number.isFinite(samples) || samples < 1) return { ok: false, reason: "no helper memory measurement was taken" };
  if (!Number.isFinite(peak) || peak <= 0) return { ok: false, reason: "the helper memory measurement is not a positive number" };
  if (peak > limitBytes) return { ok: false, reason: `helper peak ${peak} bytes is over the ${limitBytes} byte limit` };
  return { ok: true };
}
