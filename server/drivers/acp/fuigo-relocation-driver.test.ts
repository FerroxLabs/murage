import fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR, ensureDirs } from "../../config.ts";
import type { ProviderDriver, SendTurnInput } from "../../contracts.ts";
import { recordEvents } from "../../testing/events.ts";
import { removeTempDirSync } from "../../testing/cleanup.ts";
import { FuigoAgentDriver } from "./fuigo.ts";
import type { AcpConfig } from "./core.ts";
import { FUIGO_POLICY_SHA256, fuigoPolicyPath } from "./fuigo-policy.ts";
const cli = join(dirname(fileURLToPath(import.meta.url)), "../../testing/fake-acp-cli.ts");
const previous = join(DATA_DIR, "previous");
const policy = { root: previous, sha256: FUIGO_POLICY_SHA256 };
const relocation = { previous, copied: false };
const error = (root = previous) => ({ code: -32602, message: "Invalid params", data: {
  policy_error: "session_policy_conflict", path: fuigoPolicyPath(),
  message: `this session is governed by ${fuigoPolicyPath(root)} with a different policy`,
} });
const dirs: string[] = [];
beforeEach(() => { ensureDirs(); removeTempDirSync(previous);
  for (const key of Object.keys(process.env)) if (/KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL|MODEL_REFRESH|FUIGO_POLICY/i.test(key)) vi.stubEnv(key, "");
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const dir of dirs.splice(0)) removeTempDirSync(dir); });
async function run(options: { mode?: string; context?: { policy?: { root: string; sha256: string }; relocation?: { previous: string; copied: boolean }; pending?: { cursor: string }; delivered?: (cursor: string) => void }; loadError?: unknown; newError?: unknown; model?: string; cursor?: string; script?: unknown[]; transcript?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "site26-driver-")); dirs.push(home);
  const log = join(home, "rpc.jsonl");
  const driver = FuigoAgentDriver as unknown as ProviderDriver<AcpConfig>;
  const instance = await driver.create({ instanceId: "site26", displayName: "Fuigo", enabled: true,
    config: driver.decodeConfig({ cli: `${process.execPath} --experimental-strip-types ${cli}`, fullAuto: false }),
    environment: { HOME: home, USERPROFILE: home, FUIGO_HOME: home, FUIGO_API_KEY: "sk-flux-fixture-only",
      FAKE_ACP_MODE: options.script ? "fuigo-script" : (options.mode ?? "happy"), FAKE_ACP_SCRIPT: JSON.stringify(options.script ?? []),
      FAKE_ACP_DUMP: join(home, "spawn.json"), FAKE_ACP_RPC_FULL_LOG: log, FAKE_ACP_MCP_READY: "1", FAKE_ACP_MODELS: "fixture-model",
      ...(options.newError ? { FAKE_ACP_NEW_ERROR: JSON.stringify(options.newError) } : {}),
      ...(options.loadError ? { FAKE_ACP_LOAD_ERROR: JSON.stringify(options.loadError) } : {}) } });
  const rec = recordEvents(instance.adapter);
  try {
    await instance.adapter.sendTurn({ threadId: "site26-thread", text: "continue", cwd: home,
      model: options.model, resumeCursor: options.cursor ?? "old", fuigoResume: options.context,
      transcript: options.transcript === false ? [] : [{ role: "user", text: "AUTHORIZED_HISTORY" }] } as SendTurnInput);
    await rec.until(e => e.type === "turn.completed", 15000);
  } finally { rec.stop(); await instance.dispose(); }
  if (!existsSync(log)) throw new Error(JSON.stringify({ events: rec.events.filter(e => e.type === "runtime.error"), argv: existsSync(join(home, "spawn.json")) ? JSON.parse(readFileSync(join(home, "spawn.json"), "utf8")).argv : [] }));
  const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  return { calls, events: rec.events, text: JSON.stringify(calls.filter(c => c.method === "session/prompt")) };
}
it("T26a moved raw error crosses wrapper, renews, replays and marks pending", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const got = await run({ context: { policy, relocation }, loadError: error() });
  expect(got.calls.filter(c => /session\/(load|new)$/.test(c.method)).map(c => c.method)).toEqual(["session/load", "session/new"]);
  expect(got.text).toContain("Your previous session could not be restored"); expect(got.text).toContain("AUTHORIZED_HISTORY");
  expect(got.events.some(e => e.type === "item.started" && e.title === "Picked up this conversation in a fresh session")).toBe(true);
  expect(got.events.some(e => e.type === "session.started" && (e as typeof e & { replayPending?: boolean }).replayPending === true)).toBe(true);
  expect(warn).toHaveBeenCalledWith("fuigo-session-renewed reason=data-root-moved thread=site26-thread");
});
it.each([false, true])("T26b/T26m copied root, recorded=%s: fresh without load", async recorded => {
  mkdirSync(previous, { recursive: true });
  const probes = [vi.spyOn(fs, "readFileSync"), vi.spyOn(fs, "writeFileSync"), vi.spyOn(fs, "appendFileSync"),
    vi.spyOn(fs, "readdirSync"), vi.spyOn(fs, "statSync"), vi.spyOn(fs, "lstatSync"),
    vi.spyOn(fs, "mkdirSync"), vi.spyOn(fs, "rmSync"), vi.spyOn(fs, "renameSync"), vi.spyOn(fs, "unlinkSync")];
  const got = await run({ context: { policy: recorded ? policy : undefined, relocation: { ...relocation, copied: true } } });
  expect(got.calls.some(c => c.method === "session/load")).toBe(false);
  expect(got.calls.some(c => c.method === "session/new")).toBe(true); expect(got.text).toContain("AUTHORIZED_HISTORY");
  for (const probe of probes) for (const args of probe.mock.calls) {
    const path = String(args[0]);
    expect(path === previous || path.startsWith(previous + "/") || path.startsWith(previous + "\\")).toBe(false);
  }
});
it("T26c moved conflicting marker without provenance keeps calm line", async () => {
  const got = await run({ context: { relocation }, loadError: error() });
  expect(got.text).toBe("[]"); expect(JSON.stringify(got.events)).toContain("Nothing ran. Start a new conversation");
});
it("T26l legacy moved cursor loads normally without notice or replay", async () => {
  const got = await run({ context: { relocation } });
  expect(got.calls.some(c => c.method === "session/load")).toBe(true);
  expect(got.text).not.toContain("AUTHORIZED_HISTORY");
  expect(got.events.some(e => e.type === "item.started" && e.title?.includes("fresh session"))).toBe(false);
});
it("T26n current-root copy cursor loads normally", async () => {
  const got = await run({ context: { policy: { ...policy, root: DATA_DIR }, relocation: { ...relocation, copied: true } } });
  expect(got.calls.some(c => c.method === "session/load")).toBe(true); expect(got.text).not.toContain("AUTHORIZED_HISTORY");
});
it("T26k refusal keywords in old root still renew (regression, equivalent mutant)", async () => {
  const root = join(previous, "invalid model unauthorized");
  const got = await run({ context: { policy: { ...policy, root }, relocation: { previous: root, copied: false } }, loadError: error(root) });
  expect(got.text).toContain("AUTHORIZED_HISTORY");
});
it.each([
  ["T26o child exits", [{ exit: 2 }]],
  ["T26p prompt rejects", [{ error: { code: -32603, message: "fixture rejection" } }]],
  ["resolve-then-cancel", [{ result: { stopReason: "cancelled" } }]],
  ["other resolved stop", [{ result: { stopReason: "max_tokens" } }]],
] as const)("%s keeps replay for a retry", async (_name, script) => {
  const delivered = vi.fn();
  const context = { pending: { cursor: "replacement" }, delivered };
  const first = await run({ cursor: "replacement", context, script: [...script] });
  expect(first.text).toContain("AUTHORIZED_HISTORY"); expect(delivered).not.toHaveBeenCalled();
  const retry = await run({ cursor: "replacement", context });
  expect(retry.text).toContain("AUTHORIZED_HISTORY"); expect(delivered).toHaveBeenCalledWith("replacement");
});
it("T26q pending X is ignored by Y and not consumed", async () => {
  const delivered = vi.fn(); const pending = { cursor: "X" };
  const got = await run({ cursor: "Y", context: { pending, delivered } });
  expect(got.text).not.toContain("AUTHORIZED_HISTORY"); expect(delivered).not.toHaveBeenCalled(); expect(pending).toEqual({ cursor: "X" });
});

it.each([
  ["T26d foreign root", { ...policy, root: "/foreign" }, error()],
  ["T26e full hash mismatch", { ...policy, sha256: FUIGO_POLICY_SHA256.slice(0, 16) + "0".repeat(48) }, error()],
  ["T26f foreign marker", policy, error("/foreign")],
  ["T26g foreign claim", policy, { ...error(), data: { ...error().data, path: "/foreign" } }],
  ["T26h session_policy_missing", policy, { ...error(), data: { ...error().data, policy_error: "session_policy_missing" } }],
] as const)("%s keeps policy refusal without new or prompt", async (_name, policy, loadError) => {
  const got = await run({ context: { policy, relocation }, loadError });
  expect(got.calls.filter(c => /session\/(load|new)$/.test(c.method)).map(c => c.method)).toEqual(["session/load"]);
  expect(got.text).toBe("[]"); expect(JSON.stringify(got.events)).toContain("Nothing ran");
});
it("T26i new also conflicts: load then new, calm line, no prompt", async () => {
  const got = await run({ context: { policy, relocation }, loadError: error(), newError: error() });
  expect(got.calls.filter(c => /session\/(load|new)$/.test(c.method)).map(c => c.method)).toEqual(["session/load", "session/new"]);
  expect(got.text).toBe("[]"); expect(JSON.stringify(got.events)).toContain("Nothing ran. Start a new conversation");
});
it("T26j setup failure after session.started retains replacement replay for next turn", async () => {
  const got = await run({ context: { policy, relocation }, loadError: error(), model: "nonexistent-fixture-model", mode: "set-model-invalid-params" });
  const started = got.events.find(e => e.type === "session.started");
  expect(started).toMatchObject({ replayPending: true }); expect(got.text).toBe("[]");
  if (started?.type !== "session.started" || !started.sessionId) throw new Error("missing replacement cursor");
  const delivered = vi.fn();
  const retry = await run({ cursor: started.sessionId, context: { pending: { cursor: started.sessionId }, delivered } });
  expect(retry.text).toContain("AUTHORIZED_HISTORY"); expect(delivered).toHaveBeenCalledWith(started.sessionId);
});
