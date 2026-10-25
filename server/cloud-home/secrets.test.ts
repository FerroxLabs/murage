import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { decodeCloudBootEnvelope, SealedSecretStore } from "./secrets.ts";
import { parseServerSecrets, readSecretPipe } from "./server-secrets.ts";
import { CLOUD_CREDENTIAL_FIELDS, withoutCloudCredentials } from "./credentials.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const directories: string[] = [];
function directory() { const path = mkdtempSync(join(tmpdir(), "murage-cloud-secrets-")); directories.push(path); return path; }
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); for (const path of directories.splice(0)) removeTempDirSync(path); });

describe("cloud sealed credential store", () => {
  it("accepts only a home-bound v2 unwrapped key and rejects every KEK or wrapped key field", () => {
    const dataKey = randomBytes(32);
    const envelope = { version: 2, machineId: "home-1", bootstrapSecret: "b".repeat(64), dataKey: dataKey.toString("base64") };
    const raw = JSON.stringify(envelope);
    expect(decodeCloudBootEnvelope(raw, "home-1").dataKey).toEqual(dataKey);
    expect(() => decodeCloudBootEnvelope(raw, "home-2")).toThrow("invalid");
    for (const patch of [{ version: 1 }, { keyEncryptionKey: dataKey.toString("base64") }, { wrappedDataKey: {} }, { dataKey: "bad" }]) expect(() => decodeCloudBootEnvelope(JSON.stringify({ ...envelope, ...patch }), "home-1")).toThrow("invalid");
  });
  it("stores ciphertext, reloads it, refuses tampering and another home, and keeps modes private", () => {
    const dir = directory(), key = randomBytes(32), token = "fixture-token-never-plaintext";
    const store = new SealedSecretStore(dir, "home-1", key);
    store.patch({ fluxApiKey: token });
    const file = join(dir, "credentials.enc"), raw = readFileSync(file, "utf8");
    expect(raw).not.toContain(token);
    expect(statSync(dir).mode & 0o077).toBe(0); expect(statSync(file).mode & 0o077).toBe(0);
    expect(new SealedSecretStore(dir, "home-1", key).getAll()).toEqual({ fluxApiKey: token });
    expect(() => new SealedSecretStore(dir, "home-2", key)).toThrow("could not be opened");
    const bad = JSON.parse(raw); bad.tag = Buffer.alloc(16).toString("base64"); writeFileSync(file, JSON.stringify(bad));
    expect(() => new SealedSecretStore(dir, "home-1", key)).toThrow("could not be opened");
  });
  it("refuses group-readable credential storage", () => {
    const dir = directory(); chmodSync(dir, 0o750);
    expect(() => new SealedSecretStore(dir, "home", randomBytes(32))).toThrow("permissions");
  });
  it("reads and closes the boot descriptor, and redacts malformed payload errors", () => {
    const path = join(directory(), "fake-pipe"), raw = JSON.stringify({ version: 1, bootstrapSecret: "b".repeat(64), credentials: { fluxApiKey: "fixture" } });
    writeFileSync(path, raw, { mode: 0o600 }); const fd = openSync(path, "r");
    expect(parseServerSecrets(readSecretPipe(fd)).credentials.fluxApiKey).toBe("fixture");
    expect(() => readFileSync(fd)).toThrow();
    expect(() => parseServerSecrets('{"secret":"never-show-this"')).toThrow("invalid envelope");
    expect(() => readSecretPipe(0)).toThrow("required");
  });
  it("rejects every plaintext config credential on a home and overlays only pipe-held credentials", async () => {
    const dir = directory(), path = join(dir, "boot-pipe");
    writeFileSync(path, JSON.stringify({ version: 1, bootstrapSecret: "b".repeat(64), credentials: { fluxApiKey: "fixture-sealed-key" } }), { mode: 0o600 });
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home"); vi.stubEnv("MURAGE_DATA_DIR", dir); vi.stubEnv("MURAGE_CLOUD_SECRETS_FD", String(openSync(path, "r")));
    const { saveConfig, loadConfig, syncCredentialEnv } = await import("../config.ts");
    for (const row of CLOUD_CREDENTIAL_FIELDS) {
      const patch = { [row.section]: { [row.field]: "fixture-secret" } };
      expect(() => saveConfig(patch)).toThrow("encrypted supervisor store");
    }
    saveConfig(withoutCloudCredentials({ flux: { apiKey: "fixture-sealed-key" } }));
    expect(readFileSync(join(dir, "config.json"), "utf8")).not.toContain("fixture-sealed-key");
    expect(loadConfig().flux?.apiKey).toBe("fixture-sealed-key");
    const priorEnv = process.env.FLUX_API_KEY;
    syncCredentialEnv({ flux: { apiKey: "next-fixture-key" } });
    expect(process.env.FLUX_API_KEY).toBe(priorEnv);
    expect(loadConfig().flux?.apiKey).toBe("next-fixture-key");
  });
  it("keeps Flux memory off across a cloud home restart (1.0.4 audit 11-3)", async () => {
    const dir = directory(), path = join(dir, "boot-pipe");
    writeFileSync(path, JSON.stringify({ version: 1, bootstrapSecret: "b".repeat(64), credentials: { fluxApiKey: "fixture-sealed-key" } }), { mode: 0o600 });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ flux: { memory: { external: false, inject: false } } }), { mode: 0o600 });
    for (const name of ["MURAGE_FLUX_MEMORY", "MURAGE_FLUX_MEMORY_INJECT", "MURAGE_FLUX_MEMORY_OWNER", "MURAGE_FLUX_MEMORY_SPACES"]) vi.stubEnv(name, "");
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home"); vi.stubEnv("MURAGE_DATA_DIR", dir); vi.stubEnv("MURAGE_CLOUD_SECRETS_FD", String(openSync(path, "r")));
    const { loadConfig } = await import("../config.ts");
    const { fluxMemoryDecision, fluxMemorySettings } = await import("../flux-memory-headers.ts");
    expect(loadConfig().flux?.memory?.external).toBe(false);
    expect(fluxMemorySettings().external).toBe(false);
    expect(fluxMemorySettings().inject).toBe("off");
    // The next owner turn after the restart sends memory off.
    const decision = fluxMemoryDecision({ audience: "owner" });
    expect(decision.reason).toBe("external-off");
    expect(decision.capture).toBe("off");
    expect(decision.inject).toBe("off");
  });
  it("leaves the desktop config path unchanged when the home flag is absent", async () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", ""); vi.stubEnv("MURAGE_DATA_DIR", directory());
    const { saveConfig, loadConfig } = await import("../config.ts");
    saveConfig({ flux: { apiKey: "desktop-fixture" } });
    expect(loadConfig().flux?.apiKey).toBe(process.env.FLUX_API_KEY ?? "desktop-fixture");
  });
});
