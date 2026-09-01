// The Flux credential has two jobs and they pull in opposite directions: the
// server process must be able to find it, and no spawned agent may. These
// tests pin both — resolution order in fluxKey(), and the two mechanisms that
// keep the value out of a child env and out of the native protocol log.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DATA_DIR,
  loadConfig,
  parseConfigPatch,
  saveConfig,
  stripWorkspaceCredentialEnv,
  syncCredentialEnv,
  WORKSPACE_CREDENTIAL_ENV,
} from "./config.ts";
import { fluxConfigured, fluxKey } from "./flux-config.ts";
import { redactSecrets, redactSecretsInText } from "./redact.ts";

/** Shape only — never a live credential. Long enough to trip the sk- prefix
 *  rule in redact.ts, which is what a leaked key would look like in a log. */
const FLUX_KEY = "sk-flux-Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const CONFIG_PATH = join(DATA_DIR, "config.json");
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env.FLUX_API_KEY;
  delete process.env.FLUX_API_KEY;
  mkdirSync(DATA_DIR, { recursive: true });
  rmSync(CONFIG_PATH, { force: true });
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.FLUX_API_KEY;
  else process.env.FLUX_API_KEY = savedEnv;
  rmSync(CONFIG_PATH, { force: true });
});

describe("fluxKey", () => {
  it("returns null when neither config nor env carries a key", () => {
    expect(fluxKey({})).toBeNull();
    expect(fluxConfigured({})).toBe(false);
  });

  it("reads the key out of config.json", () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({ flux: { apiKey: FLUX_KEY } }));
    expect(fluxKey({})).toBe(FLUX_KEY);
    expect(fluxConfigured({})).toBe(true);
  });

  it("prefers config over the passed env — config first, then env fallback", () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({ flux: { apiKey: "from-config" } }));
    expect(fluxKey({ FLUX_API_KEY: "from-env" })).toBe("from-config");
  });

  it("falls back to FLUX_API_KEY from the env when config has none", () => {
    expect(fluxKey({ FLUX_API_KEY: FLUX_KEY })).toBe(FLUX_KEY);
  });

  it("defaults to process.env, which loadConfig also lets win over the file", () => {
    // the desktop shell hands secrets in as env from its OS-encrypted store,
    // leaving the file without them — env must beat a leftover plaintext value
    writeFileSync(CONFIG_PATH, JSON.stringify({ flux: { apiKey: "file-flux" } }));
    process.env.FLUX_API_KEY = "env-flux";
    expect(loadConfig().flux).toEqual({ apiKey: "env-flux" });
    expect(fluxKey()).toBe("env-flux");
  });

  it("treats a blank or whitespace-only value as absent, and trims a real one", () => {
    expect(fluxKey({ FLUX_API_KEY: "" })).toBeNull();
    expect(fluxKey({ FLUX_API_KEY: "   " })).toBeNull();
    expect(fluxKey({ FLUX_API_KEY: `  ${FLUX_KEY}\n` })).toBe(FLUX_KEY);
  });

  it("never throws on a malformed config.json — it degrades to the env", () => {
    writeFileSync(CONFIG_PATH, "{ this is not json");
    expect(() => fluxKey({})).not.toThrow();
    expect(fluxKey({})).toBeNull();
    expect(fluxKey({ FLUX_API_KEY: FLUX_KEY })).toBe(FLUX_KEY);
  });

  it("never throws when the stored flux section is the wrong shape", () => {
    // parseStoredConfig drops a section it cannot parse; the lookup must
    // survive that rather than take the caller down with it
    writeFileSync(CONFIG_PATH, JSON.stringify({ flux: { apiKey: 42 } }));
    expect(() => fluxKey({})).not.toThrow();
    expect(fluxKey({ FLUX_API_KEY: FLUX_KEY })).toBe(FLUX_KEY);
  });
});

describe("flux config plumbing", () => {
  it("accepts a flux patch and rejects a non-string key", () => {
    expect(parseConfigPatch({ flux: { apiKey: FLUX_KEY } })).toEqual({ flux: { apiKey: FLUX_KEY } });
    expect(() => parseConfigPatch({ flux: { apiKey: 42 } })).toThrow("flux.apiKey");
  });

  it("persists a saved key and finds it again through fluxKey", () => {
    saveConfig({ flux: { apiKey: FLUX_KEY } });
    expect(fluxKey({})).toBe(FLUX_KEY);
  });

  it("keeps process.env in step with a save, and drops it when cleared", () => {
    syncCredentialEnv({ flux: { apiKey: FLUX_KEY } });
    expect(process.env.FLUX_API_KEY).toBe(FLUX_KEY);
    syncCredentialEnv({ flux: { apiKey: "" } });
    expect(process.env.FLUX_API_KEY).toBeUndefined();
  });
});

describe("keeping the flux key away from spawned agents", () => {
  it("lists FLUX_API_KEY as a workspace credential", () => {
    expect(WORKSPACE_CREDENTIAL_ENV).toContain("FLUX_API_KEY");
  });

  it("strips FLUX_API_KEY out of a child env while leaving ordinary vars", () => {
    const childEnv: Record<string, string | undefined> = {
      PATH: "/usr/bin",
      FLUX_API_KEY: FLUX_KEY,
      MURAGE_BOT_ID: "bot-1",
    };
    stripWorkspaceCredentialEnv(childEnv);
    expect(childEnv.FLUX_API_KEY).toBeUndefined();
    expect("FLUX_API_KEY" in childEnv).toBe(false);
    expect(childEnv.PATH).toBe("/usr/bin");
    expect(childEnv.MURAGE_BOT_ID).toBe("bot-1");
  });

  it("leaves the server's own process.env untouched when stripping a copy", () => {
    // the injectors must read the key from config/process.env, never from the
    // env object they are mutating — that copy has already been emptied
    process.env.FLUX_API_KEY = FLUX_KEY;
    const childEnv = { ...process.env };
    stripWorkspaceCredentialEnv(childEnv);
    expect(childEnv.FLUX_API_KEY).toBeUndefined();
    expect(fluxKey()).toBe(FLUX_KEY);
  });
});

describe("flux key redaction in the native log", () => {
  it("masks the value under the FLUX_API_KEY name (redact.ts:16, api_key)", () => {
    const masked = redactSecrets({ FLUX_API_KEY: FLUX_KEY }) as Record<string, string>;
    expect(masked.FLUX_API_KEY).toBe(`«redacted ${FLUX_KEY.length} chars»`);
    expect(JSON.stringify(masked)).not.toContain(FLUX_KEY);
  });

  it("masks it in the ACP env wire shape a spawn message carries", () => {
    const sessionNew = {
      method: "session/new",
      params: { env: [{ name: "FLUX_API_KEY", value: FLUX_KEY }, { name: "MURAGE_BOT_ID", value: "bot-1" }] },
    };
    const masked = JSON.stringify(redactSecrets(sessionNew));
    expect(masked).not.toContain(FLUX_KEY);
    expect(masked).toContain("FLUX_API_KEY");
    expect(masked).toContain("bot-1");
  });

  it("masks a config PATCH body's flux.apiKey", () => {
    const masked = JSON.stringify(redactSecrets({ flux: { apiKey: FLUX_KEY } }));
    expect(masked).not.toContain(FLUX_KEY);
    expect(masked).toContain("apiKey");
  });

  it("masks a bare sk-flux- key sitting in prose or an argv string", () => {
    const line = `env FLUX_API_KEY=${FLUX_KEY} codex exec`;
    expect(redactSecretsInText(line)).not.toContain(FLUX_KEY);
    expect(redactSecretsInText(`the key is ${FLUX_KEY} ok`)).not.toContain(FLUX_KEY);
    expect(redactSecretsInText(`Authorization: Bearer ${FLUX_KEY}`)).not.toContain(FLUX_KEY);
  });
});
