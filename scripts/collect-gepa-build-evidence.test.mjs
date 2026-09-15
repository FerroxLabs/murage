import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectGepaBuildEvidence } from "./collect-gepa-build-evidence.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(stage = "sign-0") {
  const root = mkdtempSync(join(tmpdir(), "murage-gepa-evidence-")); roots.push(root);
  mkdirSync(join(root, "logs"));
  writeFileSync(join(root, "state.json"), JSON.stringify({ stage, status: "BLOCKED", exitCode: 1, elapsedSeconds: 4, error: "PRIVATE_STATE", command: ["PRIVATE_COMMAND"] }));
  return { root, output: join(root, "evidence") };
}
it("preserves the failed signer error with secrets redacted and fixed metadata", () => {
  const f = fixture();
  writeFileSync(join(f.root, "logs/sign-0.log"), "codesign failed: errSecInternalComponent\napi_key=PRIVATE_SECRET_CANARY\n");
  expect(collectGepaBuildEvidence(f.root, f.output)).toBe(true);
  const log = readFileSync(join(f.output, "gepa-build-stage.log"), "utf8");
  expect(log).toContain("errSecInternalComponent"); expect(log).not.toContain("PRIVATE_SECRET_CANARY");
  const state = JSON.parse(readFileSync(join(f.output, "gepa-build-state.json"), "utf8"));
  expect(state).toEqual({ stage: "sign-0", logAvailable: true, status: "BLOCKED", exitCode: 1, elapsedSeconds: 4 });
});
it("rejects a stage that could address another path", () => {
  const f = fixture("../private");
  expect(collectGepaBuildEvidence(f.root, f.output)).toBe(false);
  expect(existsSync(f.output)).toBe(false);
});
it("does not follow a replaced stage log symlink", () => {
  const f = fixture(); writeFileSync(join(f.root, "private"), "PRIVATE_CANARY");
  symlinkSync(join(f.root, "private"), join(f.root, "logs/sign-0.log"));
  expect(collectGepaBuildEvidence(f.root, f.output)).toBe(true);
  expect(existsSync(join(f.output, "gepa-build-stage.log"))).toBe(false);
  expect(JSON.parse(readFileSync(join(f.output, "gepa-build-state.json"), "utf8")).logAvailable).toBe(false);
});
it("does not create evidence when the producer never created state", () => {
  const f = fixture(); rmSync(join(f.root, "state.json"));
  expect(collectGepaBuildEvidence(f.root, f.output)).toBe(false);
  expect(existsSync(f.output)).toBe(false);
});
