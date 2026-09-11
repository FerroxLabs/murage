// Qwen × Flux Router — the OpenAI chat-completions surface (spec §4.3).
//
// Two things are pinned here and they are the whole point of the surface:
//
//  1. THE KEY REACHES THE CHILD ONLY THROUGH ITS ENV. `ensureQwenInjectModel`
//     writes provider credentials in plaintext into ~/.qwen/settings.json
//     (qwen.ts:60, :85) and never removes them — turning Flux off does not
//     clean it up. That is Kimi finding B, so every Flux assertion below also
//     asserts settings.json is untouched, byte for byte.
//  2. WHAT THE SPAWN ACTUALLY CARRIES. These read the real child env off
//     FAKE_ACP_DUMP rather than calling `applyFluxSurface` directly, because
//     the interesting failures are ordering ones: the credential strip runs
//     between the driver and the spawn (core.ts:204-212), and `applyTurnEnv`
//     (core.ts:323) is the only hook that lands after it.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs, NATIVE_DIR } from "../../config.ts";
import { newId, type ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { QwenAgentDriver } from "./qwen.ts";

const FAKE_ACP = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

/** Shape only, never a live credential. */
const FLUX_KEY = "sk-flux-Bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

let home: string;
let instance: ProviderInstance | undefined;
let recorder: EventRecorder | undefined;

const settingsPath = () => join(home, ".qwen", "settings.json");

/** Run one turn and hand back exactly what the CLI was spawned with. */
async function spawnFor(model: string | undefined): Promise<{ argv: string[]; env: Record<string, string> }> {
  const dump = join(home, "dump.json");
  instance = await QwenAgentDriver.create({
    instanceId: "qwen-flux",
    displayName: "Qwen",
    environment: { HOME: home, FAKE_ACP_DUMP: dump },
    enabled: true,
    config: { cli: FAKE_ACP, fullAuto: true },
  });
  recorder = recordEvents(instance.adapter);
  await instance.adapter.sendTurn({ threadId: "t-flux", text: "hi", model });
  await recorder.until((e) => e.type === "turn.completed");
  return JSON.parse(readFileSync(dump, "utf8")) as { argv: string[]; env: Record<string, string> };
}

beforeEach(() => {
  ensureDirs();
  home = mkdtempSync(join(tmpdir(), "murage-qwen-flux-"));
  process.env.FLUX_API_KEY = FLUX_KEY;
});

afterEach(async () => {
  delete process.env.FLUX_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_MODEL;
  recorder?.stop();
  await instance?.dispose();
  instance = undefined;
  recorder = undefined;
  await removeTempDir(home);
});

describe("qwen Flux routing — the spawn env", () => {
  it("points the child at Flux with all three OPENAI_* vars", async () => {
    const { env } = await spawnFor("flux-auto");
    expect(env.OPENAI_BASE_URL).toBe("https://api.fluxrouter.ai/v1");
    expect(env.OPENAI_API_KEY).toBe(FLUX_KEY);
    // Not cosmetic: qwen only infers its OpenAI auth type when API_KEY, MODEL
    // and BASE_URL are ALL set (qwen-code 0.15.6 getAuthTypeFromEnv). Dropping
    // OPENAI_MODEL fails the turn with "No auth type is selected".
    expect(env.OPENAI_MODEL).toBe("flux-auto");
  });

  it("never lets the raw workspace key ride under its own name", async () => {
    const { env } = await spawnFor("flux-auto");
    // FLUX_API_KEY is a workspace credential: the core deletes it from every
    // child env (core.ts:204-205) and qwen deliberately does not allowlist it
    // in `credentialEnv`. The child sees the value only as OPENAI_API_KEY.
    expect(env.FLUX_API_KEY).toBeUndefined();
    expect(Object.keys(env).filter((k) => env[k] === FLUX_KEY)).toEqual(["OPENAI_API_KEY"]);
  });

  it("selects the openai auth type on argv, ahead of the model", async () => {
    // A saved `security.auth.selectedType` in ~/.qwen/settings.json outranks
    // the OPENAI_* env we just wrote, so without this flag a Qwen-OAuth
    // install never reaches Flux at all.
    const { argv } = await spawnFor("flux-auto");
    expect(argv).toEqual(["--acp", "--auth-type", "openai", "-m", "flux-auto"]);
  });

  it("passes the bare alias through to -m — no picker id, no rewrite", async () => {
    const { argv } = await spawnFor("flux-reasoning");
    expect(argv[argv.indexOf("-m") + 1]).toBe("flux-reasoning");
  });
});

describe("qwen Flux routing — Kimi finding B: nothing is written to disk", () => {
  it("creates no ~/.qwen/settings.json for a Flux turn", async () => {
    await spawnFor("flux-auto");
    expect(existsSync(settingsPath())).toBe(false);
  });

  it("leaves an existing settings.json byte-identical", async () => {
    mkdirSync(join(home, ".qwen"), { recursive: true });
    const before = JSON.stringify({ security: { auth: { selectedType: "qwen-oauth" } } }, null, 2);
    writeFileSync(settingsPath(), before);
    await spawnFor("flux-auto");
    expect(readFileSync(settingsPath(), "utf8")).toBe(before);
  });
});

describe("qwen Flux routing — the gate", () => {
  it("writes nothing when no Flux key is configured", async () => {
    delete process.env.FLUX_API_KEY;
    const { argv, env } = await spawnFor("flux-auto");
    // Degrade to the native path rather than half-write an env that 401s.
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENAI_MODEL).toBeUndefined();
    expect(argv).toEqual(["--acp", "-m", "flux-auto"]);
    expect(existsSync(settingsPath())).toBe(false);
  });

  it("routes a local-inject turn at its own server, with the openai auth type selected", async () => {
    // 0.1.52 LOCAL-MODELS E2. This used to assert the local turn got NO
    // OPENAI_* env and no --auth-type, on the belief the modelProviders row
    // alone was enough. The live proof (docs/plans/0152-LOCAL-MODELS-PROOF.md)
    // showed qwen 0.15.6 refusing session/new with "Authentication required:
    // Use Qwen Code CLI to authenticate first." on exactly that spawn: its
    // ensureAuthenticated wants a selected auth type, and a fresh install has
    // none. So a local turn now carries what a Flux turn carries, pointed at
    // the local host — never the Flux key, never a Flux URL.
    const { argv, env } = await spawnFor("omlx::GLM-5.2-fp8");
    expect(argv).toEqual(["--acp", "--auth-type", "openai", "-m", "GLM-5.2-fp8"]);
    expect(env.OPENAI_BASE_URL).toBe("http://127.0.0.1:8080/v1");
    expect(env.OPENAI_API_KEY).toBe("omlx"); // the host's own placeholder key, from LOCAL_HOSTS
    expect(env.OPENAI_MODEL).toBe("GLM-5.2-fp8");
    expect(Object.values(env)).not.toContain(FLUX_KEY);
    // the local-host path is the one that DOES write settings.json — proving
    // the writer still runs is what makes the Flux assertions above mean
    // something, rather than passing because nothing writes at all.
    expect(JSON.parse(readFileSync(settingsPath(), "utf8")).modelProviders.openai[0].id).toBe("GLM-5.2-fp8");
  });

  it("leaves a native turn alone: no auth flag, no OPENAI_* env", async () => {
    const { argv, env } = await spawnFor(undefined);
    expect(argv).toEqual(["--acp"]);
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENAI_MODEL).toBeUndefined();
    expect(existsSync(settingsPath())).toBe(false);
  });

  it("fails a local-inject turn before spawning when settings.json cannot be merged, leaving it byte-identical", async () => {
    // 0.1.52 A8: the writer used to replace an unparseable settings.json.
    mkdirSync(join(home, ".qwen"), { recursive: true });
    const before = '{\n  "model": { "name": "qwen3" },\n  broken\n}\n';
    writeFileSync(settingsPath(), before);
    instance = await QwenAgentDriver.create({
      instanceId: "qwen-bad-settings",
      displayName: "Qwen",
      environment: { HOME: home },
      enabled: true,
      config: { cli: FAKE_ACP, fullAuto: true },
    });
    recorder = recordEvents(instance.adapter);
    const threadId = `t-bad-settings-${newId()}`;
    await expect(instance.adapter.sendTurn({ threadId, text: "hi", model: "omlx::GLM-5.2-fp8" })).rejects.toThrow(
      `${join("~", ".qwen", "settings.json")} is not valid JSON, so Murage left it unchanged.`,
    );
    expect(readFileSync(settingsPath(), "utf8")).toBe(before);
    // no child and no prompt: nothing was emitted and no RPC was written
    expect(recorder.events).toEqual([]);
    expect(existsSync(join(NATIVE_DIR, `${threadId}.ndjson`))).toBe(false);
    expect(instance.adapter.hasSession(threadId)).toBe(false);
  });

  it("strips an ambient OPENAI_BASE_URL from a native turn", async () => {
    process.env.OPENAI_BASE_URL = "http://evil.example/v1";
    process.env.OPENAI_MODEL = "stolen";
    const { env } = await spawnFor(undefined);
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    expect(env.OPENAI_MODEL).toBeUndefined();
  });

  it("lets a local pick outrank an ambient OPENAI_BASE_URL rather than inherit it", async () => {
    process.env.OPENAI_BASE_URL = "http://evil.example/v1";
    process.env.OPENAI_MODEL = "stolen";
    process.env.OPENAI_API_KEY = "sk-ambient";
    const { env } = await spawnFor("omlx::GLM-5.2-fp8");
    expect(env.OPENAI_BASE_URL).toBe("http://127.0.0.1:8080/v1");
    expect(env.OPENAI_MODEL).toBe("GLM-5.2-fp8");
    expect(env.OPENAI_API_KEY).toBe("omlx"); // the host's own placeholder key, from LOCAL_HOSTS
  });
});
