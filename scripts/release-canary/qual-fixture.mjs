// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

// Shared fixture for the O23 qualification tests: two replica roots in a neutral temp dir, an injected fence
// provider (public digests, probe hashes), a movable clock and receipt builders. Fixture names are neutral.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openQual } from "./qual.mjs";

export const h = (text) => createHash("sha256").update(text).digest("hex");
export const OS_A = { name: "macos", build: "14.5.1" };
export const OS_B = { name: "macos", build: "14.6" };

export function fixture(prefix = "canary-qual-") {
  const base = mkdtempSync(join(tmpdir(), prefix));
  const roots = [join(base, "mac"), join(base, "hz")];
  roots.forEach((root) => mkdirSync(root));
  const clock = { t: Date.parse("2026-12-01T10:00:00Z") };
  const table = { m1: { n1: h("n1-asset"), n: h("n-asset") } };
  const epoch = { value: 1 };
  const fences = {
    async components({ spike, release, from, to }) {
      const row = table[release ?? to ?? from] ?? table.m1;
      const probe = { probe_sha256: h(`probe-${spike}`), validator_sha256: h(`validator-${spike}`) };
      if (spike === "S1") return { components: { n1_asset_sha256: row.n1, ...probe }, nSha256: row.n, hint: undefined };
      if (spike === "S1-build") return { components: { n1_asset_sha256: row.n1, n_asset_sha256: row.n, ...probe }, nSha256: row.n };
      if (spike === "S3") return { components: { n_asset_sha256: row.n, ...probe }, nSha256: row.n };
      if (spike === "S2") return { components: { epoch: epoch.value, ...probe }, nSha256: null };
      return { components: { app_id: 42, repo_id: 7, ...probe }, nSha256: null };
    },
  };
  const logs = [];
  const open = (overrides = {}) => openQual({ roots, now: () => clock.t, fences, log: (m) => logs.push(m), ...overrides });
  const q = open();
  const req = (spike, target, g) => JSON.parse(readFileSync(join(roots[0], `${spike}-${target}`, `${g}.req.json`), "utf8"));
  const preflight = (target, os = OS_A, instance = q) => instance.appendObservation(target, os);
  return { base, roots, clock, table, epoch, fences, logs, open, q, req, preflight };
}

const common = (fx, spike, target, g, os = OS_A) => ({
  spike, target, gen: g, fence: fx.req(spike, target, g).fence,
  observed: { os_name: os.name, build: os.build }, probe_sha256: h(`probe-${spike}`),
  started: "2026-12-01T10:01:00Z", ended: "2026-12-01T10:05:00Z",
});
const line = (kind, n, after = true) => ({ kind, line: n, sha256: h(`${kind}-${n}`), after_mark: after });

export function s3Receipt(fx, target, g, patch = {}) {
  return {
    ...common(fx, "S3", target, g, patch.os), exit_ms: 4000, wait_signal: "none",
    stop: line("stop-quit", 10), exited: line("exited-0", 11), log_rotated: false, hard_kill_control: "graded-failed", ...patch.body,
  };
}
export function s1Receipt(fx, target, g, patch = {}) {
  const linux = target === "linux-vm";
  return {
    ...common(fx, patch.spike ?? "S1", target, g), spike: patch.spike ?? "S1", switches_passed: true, updater_fetch: true, transfer_status: "200",
    consumed_sha256: fx.table.m1.n, relaunch: true, identity: "N", control_kind: linux ? "bad-asc" : "hash-valid-sig-invalid",
    control_result: "refused", control_refusal_source: linux ? "asc-verify" : "updater-log", control_relaunched_tampered: false,
    signature_source: linux ? "completed" : "not-applicable", ...patch.body,
  };
}
export function s2Receipt(fx, g, patch = {}) {
  const run = { epoch: fx.epoch.value, completed: true, real_reply: true, sign_in_ui: false, auth_error: false, credential_valid: true, file_deleted: true };
  return {
    ...common(fx, "S2", "linux-box", g, { name: "linux", build: "6.8.0" }), engine_version: "2.1.0", runs: [run, { ...run }],
    residue: false, core: false, control: "no-credential", ...patch.body,
  };
}
export function s4Receipt(fx, g, patch = {}) {
  return {
    ...common(fx, "S4", "gh", g), repo_guard: "ok", token_scope: "ok", listed_repos_observed: 1, part_i: true, part_ii: true,
    part_iii_a: "refused-403", part_iii_b: "rule-violation", part_iii_c: true, part_iii_d: true, part_iv: ["tag-move"], part_v: true, ...patch.body,
  };
}
export const bytes = (receipt) => Buffer.from(JSON.stringify(receipt));
