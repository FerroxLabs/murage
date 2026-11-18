import fs from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { credentialFreeWindowsEnvironment, takeWindowsSigningCredentials, validateWindowsSigningConfig, WINDOWS_CUSTOM_SIGNER } from "./windows-signing-config.mjs";
const valid = () => ({ forceCodeSigning: true, win: { signtoolOptions: { sign: WINDOWS_CUSTOM_SIGNER,
  publisherName: "Ferrox Labs, LLC", signingHashAlgorithms: ["sha256"] } } });
const options = { env: { CSC_IDENTITY_AUTO_DISCOVERY: "false" } };
// Re-pointed. Option A (Sean 2026-11-18T06:42Z): 1.0.19 signs as 1.0.18 shipped; controller-admitted signing + SAC qualification are the first post-release item.
// The shipped configuration is the 1.0.18 Azure form, so the controller's validator must refuse it (the controller driver
// can never run against it), and the controller's own accepted shape stays proven on the synthetic config.
it("RED base builder configuration is the 1.0.18 Azure form, which the controller validator refuses", () => {
  const config = parse(fs.readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8"));
  expect(config.forceCodeSigning).toBe(true);
  expect(config.win.signtoolOptions).toBeUndefined();
  expect(config.win.azureSignOptions.publisherName).toBe("Ferrox Labs, LLC");
  expect(() => validateWindowsSigningConfig(config, options)).toThrow("WINDOWS_SIGNING_EFFECTIVE_CONFIG_REJECTED");
  expect(() => validateWindowsSigningConfig(valid(), options)).not.toThrow();
});
it.each([
  c => { c.win.azureSignOptions = {}; }, c => { delete c.win.signtoolOptions.sign; },
  c => { c.win.signtoolOptions.sign = "stock.mjs"; }, c => { c.win.signtoolOptions.signingHashAlgorithms = ["sha1", "sha256"]; },
  c => { c.win.signtoolOptions.certificateFile = "ambient.pfx"; }, c => { c.win.signtoolOptions.publisherName = "Other"; },
  c => { c.forceCodeSigning = false; }, c => { c.win.signExecutable = false; },
  c => { c.cscLink = "ambient.pfx"; }, c => { c.win.cscLink = "ambient.pfx"; },
  c => { c.win.signExts = []; },
  ...["script", "customNsisBinary", "customNsisResources"].map(key => c => { c.nsis = { [key]: "unreviewed" }; }),
])("rejects hostile effective config, including resolved inherited Azure options", mutate => {
  const c = valid(); mutate(c); expect(() => validateWindowsSigningConfig(c, options)).toThrow("WINDOWS_SIGNING_EFFECTIVE_CONFIG_REJECTED");
});
it("requires disabled certificate discovery and rejects ambient certificates", () => {
  for (const env of [{}, { ...options.env, WIN_CSC_LINK: "ambient" }, { ...options.env, CSC_LINK: "ambient" }]) {
    expect(() => validateWindowsSigningConfig(valid(), { env })).toThrow("WINDOWS_SIGNING_EFFECTIVE_CONFIG_REJECTED");
  }
});
it("privately captures and clears credentials before any hook import; child environment drops ambient secrets", () => {
  const env = { AZURE_TENANT_ID: "fixture-tenant", AZURE_CLIENT_ID: "fixture-client", AZURE_CLIENT_SECRET: "fixture-secret",
    PATH: "fixture-path", GITHUB_TOKEN: "fixture-token", INPUT_TRACE: "true" };
  const privateCredentials = takeWindowsSigningCredentials(env);
  expect(privateCredentials.AZURE_CLIENT_SECRET).toBe("fixture-secret");
  expect(Object.keys(env).some(key => key.startsWith("AZURE_"))).toBe(false);
  expect(credentialFreeWindowsEnvironment(env)).toEqual({ PATH: "fixture-path" });
});
it("clears every Azure setting even when validation rejects unknown discovery or missing credentials", () => {
  for (const env of [{ AZURE_CLIENT_SECRET: "fixture-secret" }, { AZURE_CLIENT_SECRET: "fixture-secret", AZURE_TOKEN_CREDENTIALS: "ambient" }]) {
    expect(() => takeWindowsSigningCredentials(env)).toThrow("WINDOWS_SIGNING_CREDENTIALS_REQUIRED");
    expect(env).toEqual({});
  }
});
