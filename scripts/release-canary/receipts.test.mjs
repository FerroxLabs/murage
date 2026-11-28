// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, expect, it } from "vitest";
import { ReceiptError, scanBackstop, SCHEMAS, validateClosed } from "./receipt-schema.mjs";
import { bytes, fixture, h, s1Receipt, s2Receipt, s3Receipt, s4Receipt } from "./qual-fixture.mjs";
import { gradeS1 } from "./validate-s1.mjs";
import { gradeS2 } from "./validate-s2.mjs";
import { gradeS3 } from "./validate-s3.mjs";
import { gradeS4 } from "./validate-s4.mjs";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";

const made = [];
afterEach(() => { for (const dir of made.splice(0)) safeWipeSync(dir); });
// Receipts need a request on disk for their fence; the validators themselves take the receipt only.
async function receipts() {
  const f = fixture();
  made.push(f.base);
  const n1 = f.preflight("mac-a");
  await f.q.request({ spike: "S1", target: "mac-a", os: n1, release: "m1" });
  await f.q.request({ spike: "S3", target: "mac-a", os: n1, release: "m1" });
  const lin = f.preflight("linux-vm", { name: "linux", build: "6.8.0" });
  await f.q.request({ spike: "S1", target: "linux-vm", os: lin, release: "m1" });
  const box = f.preflight("linux-box", { name: "linux", build: "6.8.0" });
  await f.q.request({ spike: "S2", target: "linux-box", os: box });
  await f.q.request({ spike: "S4", target: "gh" });
  return f;
}
const grade = (fn, receipt, ctx) => { const r = fn(receipt, ctx); return r.reason ? `${r.state}(${r.reason})` : r.state; };
const kind = (spike) => (code) => { try { validateClosed(bytes(code), SCHEMAS[spike]); } catch (error) { return error.code; } return "stored"; };

it("W7 S1 grading needs the fetch, the consumed hash, the hash-valid signature-invalid control refused and N relaunched", async () => {
  const f = await receipts();
  const n = { nSha256: f.table.m1.n };
  const s1 = (body, target = "mac-a") => s1Receipt(f, target, 1, { body });
  expect(grade(gradeS1, s1({}), n)).toBe("PROVEN");
  expect(grade(gradeS1, s1({ control_refusal_source: "shipit-stderr" }), n)).toBe("PROVEN");
  expect(grade(gradeS1, s1({ updater_fetch: false, transfer_status: "none" }), n)).toBe("FAILED(NO_UPDATER_FETCH)");
  expect(grade(gradeS1, s1({ consumed_sha256: h("other") }), n)).toBe("FAILED(CONSUMED_MISMATCH)");
  expect(grade(gradeS1, s1({ control_result: "accepted" }), n)).toBe("FAILED(CONTROL_ACCEPTED)");
  expect(grade(gradeS1, s1({ control_result: "absent", control_kind: "none", control_refusal_source: "none" }), n)).toBe("INCOMPLETE(NO_CONTROL)");
  expect(grade(gradeS1, s1({ relaunch: false }), n)).toBe("FAILED(RELAUNCH)");
  expect(grade(gradeS1, s1({ identity: "N-1" }), n)).toBe("FAILED(IDENTITY)");
  expect(grade(gradeS1, s1({ identity: "control", control_relaunched_tampered: true }), n)).toBe("FAILED(CONTROL_ACCEPTED)");
  expect(grade(gradeS1, s1({ transfer_status: "206" }), n)).toBe("PROVEN");
  // switches alone are never sufficient
  expect(grade(gradeS1, s1({ updater_fetch: false, transfer_status: "none", switches_passed: true }), n)).not.toBe("PROVEN");
  // a byte-flip control proves nothing about signatures
  expect(grade(gradeS1, s1({ control_kind: "byte-flip" }), n)).toBe("INCOMPLETE(NO_CONTROL)");
  for (const signature_source of ["unrouted", "tls-failure"]) {
    expect(grade(gradeS1, s1({ signature_source }, "linux-vm"), n)).toBe("INCOMPLETE(SIGNATURE_SOURCE_UNROUTED)");
  }
  expect(grade(gradeS1, s1({}, "linux-vm"), n)).toBe("PROVEN");
});

it("W8 S2 grading", async () => {
  const f = await receipts();
  const ctx = { epoch: f.epoch.value };
  const s2 = (body) => s2Receipt(f, 1, { body });
  const run = s2({}).runs[0];
  expect(grade(gradeS2, s2({}), ctx)).toBe("PROVEN");
  expect(grade(gradeS2, s2({ runs: [run] }), ctx)).toBe("FAILED(RUNS)");
  expect(grade(gradeS2, s2({ runs: [run, { ...run, auth_error: true, completed: false }] }), ctx)).toBe("FAILED(CREDENTIAL_ROTATED)");
  expect(grade(gradeS2, s2({ residue: true }), ctx)).toBe("FAILED(RESIDUE)");
  expect(grade(gradeS2, s2({ core: true }), ctx)).toBe("FAILED(RESIDUE)");
  expect(grade(gradeS2, s2({ runs: [run, { ...run, file_deleted: false }] }), ctx)).toBe("FAILED(FILE_NOT_DELETED)");
  expect(grade(gradeS2, s2({ control: "absent" }), ctx)).toBe("INCOMPLETE(NO_CONTROL)");
  expect(grade(gradeS2, s2({ control: "completed" }), ctx)).toBe("FAILED(CONTROL_ACCEPTED)");
});

it("W9 closed schema first, backstop second, run rule third", async () => {
  const f = await receipts();
  const clean = s3Receipt(f, "mac-a", 1);
  const extra = (field) => ({ ...clean, extra: field });
  const s3 = kind("S3");
  // (1) secrets in an extra field: refused by the closed schema
  expect(s3(extra("sk-ant-api03-abcdefghij"))).toBe("UNTYPED_FIELD");
  expect(s3(extra("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln"))).toBe("UNTYPED_FIELD");
  expect(s3(extra("QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlq"))).toBe("UNTYPED_FIELD");
  // (2) a clean receipt full of typed hashes is stored
  expect(s3(clean)).toBe("stored");
  const s1 = s1Receipt(f, "mac-a", 1);
  s1.identity_cdhash = "a".repeat(40);
  expect(kind("S1")(s1)).toBe("stored");
  // (3) a typed sha256 field holding a base64 token
  expect(s3({ ...clean, probe_sha256: "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlq" })).toBe("UNTYPED_FIELD");
  // (4) a path field
  expect(s3(extra("/Users/canary-user/Library/Logs/app.log"))).toBe("UNTYPED_FIELD");
  // (5) backstop unit rows on SCHEMA-VALID bytes with secrets spliced in
  const valid = JSON.stringify(clean);
  for (const secret of ["sk-ant-api03-abc", "Bearer abc", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln"]) {
    expect(() => scanBackstop(valid.replace('"S3"', `"S3 ${secret}"`))).toThrow(ReceiptError);
  }
  expect(scanBackstop(valid)).toBe(true);
  expect(() => scanBackstop(valid.replace('"S3"', '"S3 Bearer x"'))).toThrow("REDACTION");
});

it("W10 S3 grading", async () => {
  const f = await receipts();
  const s3 = (body) => s3Receipt(f, "mac-a", 1, { body });
  const stop = s3({}).stop;
  expect(grade(gradeS3, s3({ exit_ms: 60500 }))).toBe("FAILED(NO_GRACEFUL_QUIT)");
  expect(grade(gradeS3, s3({ wait_signal: "SIGKILL" }))).toBe("FAILED(NO_GRACEFUL_QUIT)");
  expect(grade(gradeS3, s3({ stop: { ...stop, after_mark: false } }))).toBe("FAILED(NO_GRACEFUL_QUIT)");
  expect(grade(gradeS3, s3({ exited: undefined }))).toBe("FAILED(NO_GRACEFUL_QUIT)");
  expect(grade(gradeS3, s3({ log_rotated: true }))).toBe("PROVEN");
  expect(grade(gradeS3, s3({ hard_kill_control: "graded-passed" }))).toBe("FAILED(CONTROL_ACCEPTED)");
});

it("W12 S4 proof grading", async () => {
  const f = await receipts();
  const s4 = (body) => s4Receipt(f, 1, { body });
  expect(grade(gradeS4, s4({}))).toBe("PROVEN");
  expect(grade(gradeS4, s4({ part_iii_a: "404-unproven" }))).toBe("INCOMPLETE(PROBE_INVALID)");
  expect(grade(gradeS4, s4({ part_iii_a: "server-error" }))).toBe("INCOMPLETE(PROBE_INVALID)");
  expect(grade(gradeS4, s4({ part_iii_a: "refused-404-proven" }))).toBe("PROVEN");
  expect(grade(gradeS4, s4({ part_iii_b: "rule-violation" }))).toBe("PROVEN");
  expect(grade(gradeS4, s4({ repo_guard: "is-releases" }))).toBe("FAILED(REPO_GUARD)");
  expect(grade(gradeS4, s4({ token_scope: "includes-releases" }))).toBe("FAILED(TOKEN_SCOPE)");
  expect(grade(gradeS4, s4({ token_scope: "unreadable" }))).toBe("FAILED(TOKEN_SCOPE)");
  expect(grade(gradeS4, s4({ part_ii: false }))).toBe("INCOMPLETE(PART_II)");
  expect(grade(gradeS4, s4({ part_iii_c: false }))).toBe("INCOMPLETE(PART_IIIC)");
  expect(grade(gradeS4, s4({ part_v: false }))).toBe("INCOMPLETE(PART_V)");
});
