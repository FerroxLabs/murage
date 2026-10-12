// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Percentiles for the scale rig: nearest-rank, so p90 of ten samples is the ninth.
export const pct = (values, p) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] : null;
};
export const stats = values => {
  const x = (values ?? []).filter(Number.isFinite);
  return { n: x.length, p50: pct(x, 0.5), p90: pct(x, 0.9), max: x.length ? Math.max(...x) : null };
};
