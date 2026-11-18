// Driver/tests owner: win-sac-sign; real locked-builder integration and sealed runner owner: MAIN.
import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { assertSigningWorkflowIsolation, signingWorkflows } from "./fixtures/windows-signing-workflows.mjs";
import { runWindowsSigningDriver } from "./windows-signing-driver.mjs";
it("clears every Azure credential before failing an untrusted launch, without importing the builder", async () => {
  const env = { AZURE_TENANT_ID: "fixture-tenant", AZURE_CLIENT_ID: "fixture-client", AZURE_CLIENT_SECRET: "fixture-secret",
    MURAGE_WINDOWS_SIGNING_LAUNCH: "untrusted", MURAGE_WINDOWS_SIGNING_LAUNCH_SHA256: "0".repeat(64) };
  await expect(runWindowsSigningDriver({ env })).rejects.toThrow("WINDOWS_SIGNING_LAUNCH_REJECTED");
  expect(Object.keys(env).filter(key => key.startsWith("AZURE_"))).toEqual([]);
});
it.each([{}, { AZURE_CLIENT_SECRET: "fixture-secret" }, { AZURE_TENANT_ID: "fixture-tenant", AZURE_CLIENT_ID: "fixture-client",
  AZURE_CLIENT_SECRET: "fixture-secret", AZURE_TOKEN_CREDENTIALS: "ambient" }])("clears incomplete or unexpected credentials before any dynamic import", async env => {
  await expect(runWindowsSigningDriver({ env })).rejects.toThrow("WINDOWS_SIGNING_CREDENTIALS_REQUIRED");
  expect(Object.keys(env).some(key => key.startsWith("AZURE_"))).toBe(false);
});
it("rejects the obsolete separate GEPA credential entry point without importing provider code", () => {
  const result = spawnSync(process.execPath, ["scripts/windows-gepa-ci.mjs"], { encoding: "utf8", timeout: 10_000,
    env: { AZURE_CLIENT_SECRET: "fixture-secret", NODE_OPTIONS: "" } });
  expect(result.status).not.toBe(0); expect(result.stderr).toContain("WINDOWS_SIGNING_DRIVER_REQUIRED");
  expect(result.stderr).not.toContain("fixture-secret");
});

it("never passes Azure credentials to the standalone GEPA entry in any workflow", () => {
  // Zero workflow, job or step Azure credentials reach the standalone GEPA entry point (still enforced under Option A, Sean 2026-11-18T06:42Z).
  assertSigningWorkflowIsolation(signingWorkflows());
});
it("refuses standalone GEPA with zero provider imports and zero signing runs", () => {
  const probe = `
    import childProcess from 'node:child_process';
    import { registerHooks, syncBuiltinESMExports } from 'node:module';
    let providerImports = 0, signingRuns = 0;
    childProcess.execFile = () => { signingRuns++; throw Error('UNEXPECTED_SIGNING_RUN'); };
    syncBuiltinESMExports();
    registerHooks({ resolve(specifier, context, next) {
      if (/windows-(?:azure-signer|signing-provider)\\.mjs/.test(specifier)) providerImports++;
      return next(specifier, context);
    } });
    try { await import('./scripts/windows-gepa-ci.mjs'); }
    catch (error) { console.log(JSON.stringify({ code: error.message, providerImports, signingRuns })); }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { encoding: "utf8", timeout: 10_000,
    env: { AZURE_TENANT_ID: "fixture-tenant", AZURE_CLIENT_ID: "fixture-client", AZURE_CLIENT_SECRET: "fixture-secret", NODE_OPTIONS: "" } });
  // MAIN RULING 1115-WINSAC-WF: standalone GEPA refuses before provider import or any signing execution.
  expect(result.status).toBe(0);
  // MAIN RULING 1115-WINSAC-WF: both counters stay zero on the obsolete entry point.
  expect(JSON.parse(result.stdout)).toEqual({ code: "WINDOWS_SIGNING_DRIVER_REQUIRED", providerImports: 0, signingRuns: 0 });
});
