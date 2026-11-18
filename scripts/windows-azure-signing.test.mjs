// Option A (Sean 2026-11-18T06:42Z): 1.0.19 signs Windows in-job exactly as 1.0.18 shipped; controller-admitted signing +
// SAC qualification are the first post-release item. These witnesses hold the shipped electron-builder.yml to that signer
// and pin the refusal rules of assertAzureSigning, which scripts/after-pack.mjs runs before any Windows signing call
// (the package-level refusals are witnessed through afterPack itself in after-pack-windows-signing.test.mjs).
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { assertAzureSigning, assertAzureSigningConfig, assertAzureSigningEnv, AZURE_SIGNING_ENV } from "./windows-azure-signing.mjs";

const shipped = () => parse(readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8"));
const present = () => Object.fromEntries(AZURE_SIGNING_ENV.map(key => [key, "fixture-value"]));

it("the shipped builder config resolves to the 1.0.18 Azure signer when the credentials are present", () => {
  const config = shipped();
  expect(assertAzureSigning(config, present())).toEqual({ publisherName: "Ferrox Labs, LLC", endpoint: "https://eus.codesigning.azure.net",
    codeSigningAccountName: "ferrox-labs-signing", certificateProfileName: "ferroxlabs" });
  expect(config.forceCodeSigning).toBe(true);
  expect(config.win.signtoolOptions).toBeUndefined();
  // The controller hook that required a signing session is not wired; the remaining hooks are the ones Option A keeps.
  expect(config.afterExtract).toBeUndefined();
  expect(config.afterPack).toBe("./scripts/after-pack.mjs");
  expect(JSON.stringify(config)).not.toContain("windows-builder-custom-sign");
});

it.each([...AZURE_SIGNING_ENV.flatMap(key => [
  [`${key} absent`, env => { delete env[key]; }, key],
  [`${key} empty`, env => { env[key] = ""; }, key],
  [`${key} blank`, env => { env[key] = "  "; }, key],
  [`${key} not text`, env => { env[key] = 1; }, key],
])])("fails closed with the shipped config when %s", (_name, mutate, key) => {
  const env = present(); mutate(env);
  expect(() => assertAzureSigning(shipped(), env)).toThrow(`WINDOWS_AZURE_SIGNING_ENV_REQUIRED: ${key}`);
  expect(() => assertAzureSigning(shipped(), present())).not.toThrow();
});

it("names every missing credential and never echoes a credential value", () => {
  let message = "";
  try { assertAzureSigningEnv({ AZURE_CLIENT_ID: "fixture-client-value" }); } catch (error) { message = error.message; }
  expect(message).toBe("WINDOWS_AZURE_SIGNING_ENV_REQUIRED: AZURE_TENANT_ID, AZURE_CLIENT_SECRET");
  expect(message).not.toContain("fixture-client-value");
});

it.each([
  ["no Azure signer", config => { delete config.win.azureSignOptions; }],
  ["controller callback signer", config => { config.win.signtoolOptions = { sign: "./scripts/windows-builder-custom-sign.mjs" }; }],
  ["stock signtool beside Azure", config => { config.win.signtoolOptions = { publisherName: "Ferrox Labs, LLC" }; }],
  ["another publisher", config => { config.win.azureSignOptions.publisherName = "Fixture Publisher"; }],
  ["publisher list", config => { config.win.azureSignOptions.publisherName = ["Ferrox Labs, LLC", "Fixture Publisher"]; }],
  ["foreign endpoint", config => { config.win.azureSignOptions.endpoint = "https://signing.fixture.invalid"; }],
  ["plain http endpoint", config => { config.win.azureSignOptions.endpoint = "http://eus.codesigning.azure.net"; }],
  ["missing account", config => { delete config.win.azureSignOptions.codeSigningAccountName; }],
  ["missing profile", config => { config.win.azureSignOptions.certificateProfileName = ""; }],
  ["signing not forced", config => { config.forceCodeSigning = false; }],
  ["forced signing unspecified", config => { delete config.forceCodeSigning; }],
  ["executable signing disabled", config => { config.win.signExecutable = false; }],
  ["sign-and-edit disabled", config => { config.win.signAndEditExecutable = false; }],
  ["update signature check disabled", config => { config.win.verifyUpdateCodeSignature = false; }],
  ["no Windows section", config => { delete config.win; }],
])("refuses a builder config with %s even when every credential is present", (_name, mutate) => {
  const config = shipped(); mutate(config);
  expect(() => assertAzureSigning(config, present())).toThrow("WINDOWS_SIGNING_CONFIG_MISMATCH");
  expect(() => assertAzureSigningConfig(shipped())).not.toThrow();
});
