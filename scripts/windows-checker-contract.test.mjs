import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../server/testing/cleanup.ts";
import { peSha256, runnerWindowsPeTrust } from "./windows-pe-signing.mjs";
import { parseWindowsCheckerVerdict } from "./windows-checker-contract.mjs";
const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) removeTempDirSync(dir); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "checker-contract-")); dirs.push(root);
  const file = path.join(root, "checker.exe"), attestation = path.join(root, "attestation.json");
  fs.writeFileSync(file, "independent fixture checker");
  const binarySha256 = peSha256(fs.readFileSync(file));
  const data = { schema: 1, component: "windows-trust-checker", binarySha256, sourceRevision: "a".repeat(40), sourceSha256: "b".repeat(64),
    toolchain: { version: "fixture-1", sha256: "c".repeat(64) }, tools: [{ component: "fixture-compiler", sha256: "d".repeat(64) }], contract: "embedded-winverifytrust-v1" };
  fs.writeFileSync(attestation, JSON.stringify(data));
  const env = { MURAGE_WINDOWS_TRUST_CHECKER: file, MURAGE_WINDOWS_TRUST_CHECKER_SHA256: binarySha256,
    MURAGE_WINDOWS_TRUST_CHECKER_ATTESTATION: attestation, MURAGE_WINDOWS_TRUST_CHECKER_ATTESTATION_SHA256: peSha256(fs.readFileSync(attestation)),
    AZURE_CLIENT_SECRET: "fixture-secret", GITHUB_TOKEN: "fixture-token", SystemRoot: "fixture-system" };
  const verdict = { status: "Valid", embedded: true, publisher: "Fixture Vendor", timestamp: true };
  const run = vi.fn(async () => ({ stdout: JSON.stringify(verdict) }));
  return { root, file, attestation, data, env, run, verdict, load: () => runnerWindowsPeTrust(env, { platform: "win32", run }) };
}
it("uses only the independent pinned checker with credential-free child env", async () => {
  const f = fixture(), checker = await f.load(); await expect(checker.authenticode(path.join(f.root, "target.node"))).resolves.toEqual(f.verdict);
  expect(f.run).toHaveBeenCalledWith(f.file, [path.join(f.root, "target.node")], expect.objectContaining({ env: expect.not.objectContaining({ AZURE_CLIENT_SECRET: expect.anything(), GITHUB_TOKEN: expect.anything() }) }));
});
it.each(["binary", "attestation", "pin", "missing-attestation", "build-identity"])("rejects changed %s before executing checker", async change => {
  const f = fixture();
  if (change === "binary") fs.appendFileSync(f.file, "changed");
  if (change === "attestation") fs.appendFileSync(f.attestation, " ");
  if (change === "pin") f.env.MURAGE_WINDOWS_TRUST_CHECKER_SHA256 = "0".repeat(64);
  if (change === "missing-attestation") delete f.env.MURAGE_WINDOWS_TRUST_CHECKER_ATTESTATION;
  if (change === "build-identity") { f.data.sourceRevision = "stale"; fs.writeFileSync(f.attestation, JSON.stringify(f.data)); f.env.MURAGE_WINDOWS_TRUST_CHECKER_ATTESTATION_SHA256 = peSha256(fs.readFileSync(f.attestation)); }
  await expect(f.load()).rejects.toThrow(); expect(f.run).not.toHaveBeenCalled();
});
it("rechecks before and after every execution, including failed executions", async () => {
  const f = fixture(), checker = await f.load();
  f.run.mockImplementation(async () => { fs.appendFileSync(f.file, "changed"); throw Error("fixture-exit"); });
  await expect(checker.authenticode("target.node")).rejects.toThrow("WINDOWS_PE_RUNNER_CHECKER_PIN_MISMATCH");
  f.run.mockClear(); await expect(checker.authenticode("target.node")).rejects.toThrow("WINDOWS_PE_RUNNER_CHECKER_PIN_MISMATCH"); expect(f.run).not.toHaveBeenCalled();
});
it.each([
  { status: "Valid", embedded: false, publisher: "Fixture", timestamp: true },
  { status: "Valid", embedded: true, publisher: "", timestamp: true },
  { status: "Valid", embedded: true, publisher: "Fixture" },
  { status: "Unexpected", embedded: true, publisher: "Fixture", timestamp: true },
])("rejects malformed/catalog-only checker verdict %j", verdict => {
  expect(() => parseWindowsCheckerVerdict(JSON.stringify(verdict))).toThrow("WINDOWS_CHECKER_VERDICT_INVALID");
});
