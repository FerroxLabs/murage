import { useOutsideStoreFixture } from "../../testing/outside-store-fixture.ts";
// FUIGO-SCOPE (1.0.17): Fuigo runs every turn under Murage's launch policy (FUIGO_POLICY_PATH + FUIGO_POLICY_SHA256,
// the same pair in `_meta` on every session/new and session/load), so its default-mode auto-allow (read_file, grep,
// glob, list_dir, cat, head, touch ...) can no longer run a read with no card. An engine that does not acknowledge the
// policy never gets the prompt.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR, ensureDirs } from "../../config.ts";
import type { ProviderDriver } from "../../contracts.ts";
import { turnPermissionEnforcement } from "../../routine-permissions.ts";
import { recordEvents } from "../../testing/events.ts";
import { removeTempDirSync } from "../../testing/cleanup.ts";
import type { AcpConfig } from "./core.ts";
import { FuigoAgentDriver, scrubFuigoHandedEnv } from "./fuigo.ts";
import {
  FUIGO_POLICY_SHA256,
  FUIGO_POLICY_TEXT,
  FuigoPolicyError,
  checkFuigoPolicyAck,
  ensureFuigoPolicy,
  fuigoPolicyFailure,
  fuigoPolicyErrorText,
  fuigoPolicyPath,
  pinFuigoPolicyEnv,
} from "./fuigo-policy.ts";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");
const temps: string[] = [];
const temp = (tag: string) => { const dir = mkdtempSync(join(tmpdir(), `murage-fuigo-policy-${tag}-`)); temps.push(dir); return dir; };
beforeEach(() => {
  ensureDirs();
  for (const key of Object.keys(process.env)) if (/KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL|MODEL_REFRESH|FUIGO_POLICY/i.test(key)) vi.stubEnv(key, "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of temps.splice(0)) removeTempDirSync(dir);
});

describe("the policy file", () => {
  it("asks for every shell, read, edit, search and MCP tool call, and nothing else", () => {
    // MCPTool: an owner `allow` for an MCP server (a filesystem server reading a key) must not skip the ask
    expect(FUIGO_POLICY_TEXT).toBe('[permission]\nask = ["Bash", "Read", "Edit", "Grep", "MCPTool"]\n');
    expect(FUIGO_POLICY_SHA256).toBe(createHash("sha256").update(FUIGO_POLICY_TEXT).digest("hex"));
  });

  it("is written under the data root, owner-only, and rewritten whole when changed", () => {
    const root = temp("data");
    const policy = ensureFuigoPolicy(root);
    expect(policy).toEqual({ path: fuigoPolicyPath(root), sha256: FUIGO_POLICY_SHA256 });
    expect(policy.path.startsWith(join(root, "native", "fuigo-policy"))).toBe(true);
    expect(readFileSync(policy.path, "utf8")).toBe(FUIGO_POLICY_TEXT);
    if (process.platform !== "win32") expect(lstatSync(policy.path).mode & 0o777).toBe(0o600);
    writeFileSync(policy.path, '[permission]\nallow = ["*"]\n');
    ensureFuigoPolicy(root);
    expect(readFileSync(policy.path, "utf8")).toBe(FUIGO_POLICY_TEXT);
  });

  it.skipIf(process.platform === "win32")("refuses a policy folder that is a link (never writes through it)", () => {
    const root = temp("link");
    const elsewhere = temp("elsewhere");
    mkdirSync(join(root, "native"), { recursive: true });
    symlinkSync(elsewhere, join(root, "native", "fuigo-policy"));
    expect(() => ensureFuigoPolicy(root)).toThrow(/approval settings/);
    expect(existsSync(join(elsewhere, `launch-${FUIGO_POLICY_SHA256.slice(0, 16)}.toml`))).toBe(false);
  });
});

describe("the handed env and the engine's answers", () => {
  it("the owner's captured shell cannot name another policy, in any spelling", () => {
    const child = { FUIGO_POLICY_PATH: "/data/native/fuigo-policy/p.toml", FUIGO_POLICY_SHA256: FUIGO_POLICY_SHA256 };
    const map: Record<string, string | undefined> = { Fuigo_Policy_Path: "/owner/loose.toml", fuigo_policy_sha256: "0".repeat(64), PATH: "/bin" };
    pinFuigoPolicyEnv(map, child, "win32");
    expect(map).toEqual({ PATH: "/bin", ...child });
    const posix: Record<string, string | undefined> = { FUIGO_POLICY_PATH: "/owner/loose.toml", PATH: "/bin" };
    scrubFuigoHandedEnv(posix, child, "linux");
    expect(posix.FUIGO_POLICY_PATH).toBe(child.FUIGO_POLICY_PATH);
    expect(posix.FUIGO_POLICY_SHA256).toBe(FUIGO_POLICY_SHA256);
    const none: Record<string, string | undefined> = { FUIGO_POLICY_PATH: "/owner/loose.toml" };
    pinFuigoPolicyEnv(none, {}, "linux");
    expect(none).toEqual({});
  });

  it("a session answer must acknowledge the same policy", () => {
    const policy = { path: "/p.toml", sha256: FUIGO_POLICY_SHA256 };
    expect(() => checkFuigoPolicyAck({ sessionId: "s" }, policy)).toThrow(/did not confirm your approval settings/);
    expect(() => checkFuigoPolicyAck({ _meta: { "fuigo/permissionPolicy": { sha256: "0".repeat(64) } } }, policy)).toThrow(/different policy/);
    expect(() => checkFuigoPolicyAck({ _meta: { "fuigo/permissionPolicy": { sha256: FUIGO_POLICY_SHA256 } } }, policy)).not.toThrow();
  });

  it("a policy failure is told apart from every other session error, Fuigo's own refusal included", () => {
    const policy = { path: "/p.toml", sha256: FUIGO_POLICY_SHA256 };
    let thrown: unknown;
    try { checkFuigoPolicyAck({}, policy); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(FuigoPolicyError);
    expect(fuigoPolicyFailure(thrown)).toBe(thrown);
    const refused = fuigoPolicyFailure({ code: -32602, message: "Invalid params", data: { policy_error: "session_policy_missing", path: null } });
    expect(refused).toBeInstanceOf(FuigoPolicyError);
    expect(refused?.message).toMatch(/opened without the policy/);
    expect(fuigoPolicyFailure({ code: -32603, message: "busy", data: { error_kind: "session_unavailable" } })).toBeUndefined();
    expect(fuigoPolicyFailure(new Error("session/load timed out"))).toBeUndefined();
  });

  it("Fuigo's exit-78 refusal reads as plain words", () => {
    const text = fuigoPolicyErrorText('starting\n{"policy_error":"hash_mismatch","path":"/p.toml","line":null,"message":"x"}\n');
    expect(text).toMatch(/policy file changed/);
    expect(text).not.toMatch(/—/);
    expect(fuigoPolicyErrorText("panic: something else")).toBeUndefined();
  });
});

async function launch(options: { fullAuto: boolean; enforced?: ReturnType<typeof turnPermissionEnforcement>; env?: Record<string, string> }) {
  const home = temp("home");
  const dump = join(home, "spawn.json");
  const log = join(home, "rpc.jsonl");
  const driver = FuigoAgentDriver as unknown as ProviderDriver<AcpConfig>;
  const instance = await driver.create({ instanceId: "fuigo-policy", displayName: "Fuigo", enabled: true,
    config: driver.decodeConfig({ cli, fullAuto: options.fullAuto }),
    environment: { HOME: home, USERPROFILE: home, FAKE_ACP_MODE: "happy", FAKE_ACP_DUMP: dump, FAKE_ACP_RPC_FULL_LOG: log, FAKE_ACP_MCP_READY: "1", FAKE_ACP_MODELS: "fixture-model", FUIGO_API_KEY: "sk-flux-fixture-only", ...options.env } });
  const recorder = recordEvents(instance.adapter);
  try {
    await instance.adapter.sendTurn({ threadId: "fpol", text: "hello", cwd: home, ...options.enforced });
    await recorder.until((event) => event.threadId === "fpol" && event.type === "turn.completed", 15000);
  } finally { recorder.stop(); await instance.dispose(); }
  const sent = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { method: string; params: { _meta?: Record<string, unknown> } | null });
  const spawn = JSON.parse(readFileSync(dump, "utf8")) as { env: Record<string, string | undefined> };
  return { sent, env: spawn.env, events: recorder.events };
}

const LEVELS = [
  ["Ask", { autoApprove: false }, false],
  ["Auto", { autoApprove: true }, true],
  ["Full access", { autoApprove: true, fullAccess: true }, true],
  ["No limits", { autoApprove: true, fullAccess: true, noLimits: true }, true],
] as const;

describe("every Fuigo turn runs under the policy", () => {
  it.each(LEVELS)("%s: the engine gets the policy at launch and on every session it opens", async (_level, bot, fullAuto) => {
    const run = await launch({ fullAuto, enforced: turnPermissionEnforcement(bot) });
    const path = fuigoPolicyPath(DATA_DIR);
    expect(run.env.FUIGO_POLICY_PATH).toBe(path);
    expect(run.env.FUIGO_POLICY_SHA256).toBe(FUIGO_POLICY_SHA256);
    expect(readFileSync(path, "utf8")).toBe(FUIGO_POLICY_TEXT);
    const sessions = run.sent.filter((message) => message.method === "session/new" || message.method === "session/load");
    expect(sessions.length).toBeGreaterThan(0);
    for (const session of sessions) {
      expect(session.params?._meta?.["fuigo/permissionPolicyPath"]).toBe(path);
      expect(session.params?._meta?.["fuigo/permissionPolicySha256"]).toBe(FUIGO_POLICY_SHA256);
    }
    expect(run.sent.some((message) => message.method === "session/prompt")).toBe(true);
  }, 30000);

  it("an engine that ignores the policy never gets the prompt, and the owner is told why", async () => {
    const run = await launch({ fullAuto: true, enforced: turnPermissionEnforcement({ autoApprove: true, fullAccess: true }), env: { FAKE_ACP_POLICY_ACK: "0" } });
    expect(run.sent.some((message) => message.method === "session/new")).toBe(true);
    expect(run.sent.some((message) => message.method === "session/prompt")).toBe(false);
    expect(JSON.stringify(run.events)).toMatch(/did not confirm your approval settings/);
  }, 30000);
});

// Adapter turns in this suite use an isolated durable store.
useOutsideStoreFixture();
