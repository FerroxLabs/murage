import {driverOwnerDecisionFixture} from '../../testing/driver-decision-fixture.ts';
import { chmodSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderInstance, SendTurnInput } from "../../contracts.ts";
import { ensureDirs } from "../../config.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents } from "../../testing/events.ts";
import { useOutsideStoreFixture } from "../../testing/outside-store-fixture.ts";
import { createAcpDriver } from "./core.ts";
import { createOpenclawPrePromptGuard, openclawPromptText, openclawSupport, type OpenclawGatewayCall } from "./openclaw.ts";

let instance: ProviderInstance | undefined;
let root: string | undefined;
afterEach(async () => { await instance?.dispose(); instance = undefined; if (root) await removeTempDir(root); root = undefined; });

it("E1 No limits opens the exact OpenClaw session and submits with full exec, including after Ask", async () => {
  ensureDirs();
  root = mkdtempSync(join(tmpdir(), "murage-e1-"));
  const cli = join(process.cwd(), "server/testing/fake-acp-cli.ts");
  chmodSync(cli, 0o755);
  const dump = join(root, "prompt.json");
  const calls: Array<Record<string, unknown>> = [];
  const gateway: OpenclawGatewayCall = async (_cli, method, params) => {
    expect(method).toBe("sessions.patch"); calls.push(params);
    return { ok: true, key: params.key, entry: { permissionMode: params.permissionMode } };
  };
  const guard = createOpenclawPrePromptGuard({ call: gateway, probeVersion: async () => "2026.10.5" });
  const driver = createAcpDriver({ ...openclawSupport, prePrompt: guard });
  instance = await driver.create({ instanceId: "e1", displayName: "OpenClaw", environment: { FAKE_ACP_PROMPT_DUMP: dump }, enabled: true, config: { cli, fullAuto: false } });
  const events = recordEvents(instance.adapter);
  const base: SendTurnInput = { threadId: "e1-owner", text: "write and run the fixture", cwd: root,
    warmIdentity: { botId: "owner-bot", audience: "owner" } };
  try {
    // An earlier Ask left the same gateway key read-only. No limits replaces it.
    await guard.apply({ config: { cli, fullAuto: false }, env: {}, turn: { ...base, askLevel: true }, askLevel: true }).catch(() => {});
    const sent = await instance.adapter.sendTurn({ ...base, stopLine: true, noLimits: true });
    const done = await events.until(e => e.type === "turn.completed" && e.turnId === sent.turnId);
    expect(done).toMatchObject({ ok: true });
    expect(calls.map(c => c.permissionMode)).toEqual(["read-only", "full"]);
    expect(calls[0]!.key).toBe(calls[1]!.key);
    const prompt = readFileSync(dump, "utf8");
    expect(prompt).toContain("/exec security=full ask=always");
    expect(prompt).not.toContain("security=deny");
    expect(events.events.filter(e => e.type === "item.started" && e.title?.includes("read-only"))).toEqual([]);
  } finally { events.stop(); }
});

it("E1 lowering No limits stops an active full-access OpenClaw turn", async () => {
  ensureDirs(); root = mkdtempSync(join(tmpdir(), "murage-e1-lower-"));
  const cli = join(process.cwd(), "server/testing/fake-acp-cli.ts"); chmodSync(cli, 0o755);
  const dump = join(root, "prompt.json");
  const modes: unknown[] = [];
  const gateway: OpenclawGatewayCall = async (_cli, _method, params) => {
    modes.push(params.permissionMode);
    return { ok: true, key: params.key, entry: { permissionMode: params.permissionMode } };
  };
  const driver = createAcpDriver({ ...openclawSupport, prePrompt: createOpenclawPrePromptGuard({ call: gateway, probeVersion: async () => "2026.10.5" }) });
  instance = await driver.create({ instanceId: "e1-lower", displayName: "OpenClaw", enabled: true, config: { cli, fullAuto: false },
    environment: { FAKE_ACP_MODE: "hang", FAKE_ACP_PROMPT_DUMP: dump } });
  const events = recordEvents(instance.adapter);
  let unlimited = true;
  const turn: SendTurnInput = { threadId: "e1-lower", text: "fixture", cwd: root, noLimits: true, stopLine: true,
    warmIdentity: { botId: "owner-bot", audience: "owner" },
    permissionNow: () => unlimited ? { stopLine: true, noLimits: true } : { routeAsks: true } };
  try {
    const sent = await instance.adapter.sendTurn(turn);
    await vi.waitFor(() => expect(existsSync(dump)).toBe(true));
    expect(modes).toEqual(["full"]);
    unlimited = false;
    await instance.adapter.onPostureChange?.(turn.threadId);
    expect(await events.until(e => e.type === "turn.completed" && e.turnId === sent.turnId, 5000)).toMatchObject({ ok: true, stopReason: "cancelled" });
    const lower = await instance.adapter.sendTurn(turn);
    expect(await events.until(e => e.type === "turn.completed" && e.turnId === lower.turnId)).toMatchObject({ ok: false, stopReason: "submission_refused" });
    expect(modes).toEqual(["full", "read-only"]);
  } finally { events.stop(); }
});

it("E1 live permission changes replace stale OpenClaw prompt flags", () => {
  const turn: SendTurnInput = { threadId: "e1-live", text: "fixture", noLimits: true,
    permissionNow: () => ({ routeAsks: true, askLevel: true }) };
  expect(openclawPromptText(turn)).toContain("/exec security=deny");
  turn.permissionNow = () => ({ stopLine: true, noLimits: true });
  expect(openclawPromptText(turn)).toContain("/exec security=full ask=always");
});

it.each([["echo fixture", "allow"], ["rm -rf /", "deny"]] as const)("N2 OpenClaw No limits relays exec %s to Murage's broker", async (command, behavior) => {
  ensureDirs(); root = mkdtempSync(join(tmpdir(), "murage-openclaw-relay-"));
  const cli = join(process.cwd(), "server/testing/fake-acp-cli.ts"); chmodSync(cli, 0o755);
  const log = join(root, "rpc.jsonl");
  // OpenClaw 2026.10.5 buildAcpPermissionRequest's native wire shape.
  const params = { sessionId: "current", toolCall: { toolCallId: "exec:fixture", title: "Command approval requested", kind: "execute", status: "pending",
    rawInput: { name: "exec", approvalId: "fixture", command }, _meta: { toolName: "exec", approvalId: "fixture" } },
    options: [{ optionId: "allow-once", kind: "allow_once" }, { optionId: "deny", kind: "reject_once" }] };
  const driver = createAcpDriver({ ...openclawSupport, prePrompt: createOpenclawPrePromptGuard({ probeVersion: async () => "2026.10.5",
    call: async (_cli, _method, p) => ({ ok: true, key: p.key, entry: { permissionMode: p.permissionMode } }) }) });
  instance = await driver.create({ instanceId: "openclaw-relay", displayName: "OpenClaw", enabled: true, config: { cli, fullAuto: false },
    environment: { FAKE_ACP_MODE: "vendor-question", FAKE_ACP_ASK_METHOD: "session/request_permission", FAKE_ACP_ASK_PARAMS: JSON.stringify(params), FAKE_ACP_RPC_FULL_LOG: log } });
  const events = recordEvents(instance.adapter),release=driverOwnerDecisionFixture(instance.adapter,root);
  try {
    const sent = await instance.adapter.sendTurn({ threadId: "openclaw-relay", text: "fixture", cwd: root, stopLine: true, noLimits: true });
    const ask = await events.until(e => e.type === "request.opened");
    expect(ask).toMatchObject({ tool: "shell", toolCall: { input: { command } } });
    if (ask.type !== "request.opened") throw new Error("missing native request");
    expect(await instance.adapter.respondToRequest(ask.threadId, ask.requestId!, { behavior })).toBe(behavior === "allow" ? "allowed-once" : "rejected");
    expect(await events.until(e => e.type === "turn.completed" && e.turnId === sent.turnId)).toMatchObject({ ok: true });
    expect(events.events.find(e => e.type === "request.resolved" && e.requestId === ask.requestId)).toMatchObject({ behavior });
  } finally { events.stop();release(); }
});
useOutsideStoreFixture();
