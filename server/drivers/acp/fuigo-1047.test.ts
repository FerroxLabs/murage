// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Murage side of Fuigo 1.0.47, over fake ACP frames (server/testing/fake-acp-cli.ts):
//  (1) initialize carries `fuigo/permissionPrompts`; an engine told so asks (S1), one not told denies silently.
//  (2) that ask reaches the existing decision path: witnessed through the booted server in server/fuigo-1047-s1-route-api.test.ts.
//  (3) a held server from mcp/list is its own owner card ("<server> changed: Approve"), not a readiness failure; Approve sends
//      `_fuigo/mcp/toggle` with snake_case params and the shown heldDigest as `digest`; a toggle error shows the engine's text and
//      is never retried; "changed again since it was shown" re-reads the list and shows the new definition as a new card.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.MURAGE_ACP_MCP_READY_MS ??= "300";
process.env.MURAGE_ACP_MCP_OWN_READY_MS ??= "200";
process.env.MURAGE_ACP_MCP_LISTED_MS ??= "200";

import { ensureDirs } from "../../config.ts";
import type { ProviderDriver, ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { removeTempDirSync } from "../../testing/cleanup.ts";
import { noteHumanWait, humanWaitOpen } from "../../harness/human-wait.ts";
import { requestHoldsHumanWait } from "../../request-wait.ts";
import { bindFixtureAdapter } from "../../testing/mcp-admission-fixture.ts";
import { SPAWNED_PROXIES } from "../../proxy-paths.ts";
import type { AcpConfig } from "./core.ts";
import { FuigoAgentDriver } from "./fuigo.ts";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");
const homes: string[] = [];
let instance: ProviderInstance | undefined;
let recorder: EventRecorder | undefined;
beforeEach(() => {
  ensureDirs();
  for (const key of Object.keys(process.env)) if (/KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL|MODEL_REFRESH/i.test(key)) vi.stubEnv(key, "");
});
afterEach(async () => {
  recorder?.stop(); recorder = undefined;
  await instance?.dispose(); instance = undefined;
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) removeTempDirSync(home);
});

type Rpc = { method: string; params: Record<string, any> | null };
async function start(env: Record<string, string>) {
  const home = mkdtempSync(join(tmpdir(), "murage-fuigo-1047-"));
  homes.push(home);
  const log = join(home, "rpc.jsonl");
  writeFileSync(log, "");
  const driver = FuigoAgentDriver as unknown as ProviderDriver<AcpConfig>;
  instance = await driver.create({ instanceId: "fuigo-1047", displayName: "Fuigo", enabled: true, config: driver.decodeConfig({ cli, fullAuto: false }),
    environment: { HOME: home, USERPROFILE: home, FAKE_ACP_MODE: "happy", FAKE_ACP_RPC_FULL_LOG: log, FAKE_ACP_MCP_READY: "1", FAKE_ACP_MODELS: "fixture-model", FUIGO_API_KEY: "sk-flux-fixture-only", ...env } });
  recorder = recordEvents(instance.adapter);
  const rpc = (): Rpc[] => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Rpc);
  return { home, rpc };
}

describe("1.0.47 (1) initialize advertises permission prompts", () => {
  it("sends _meta fuigo/permissionPrompts: true and the engine then asks for an outside-workspace rm", async () => {
    const outside = "/srv/elsewhere/old-build";
    const toolCall = { toolCallId: "rm-1", kind: "execute", title: `rm -rf ${outside}`, rawInput: { command: `rm -rf ${outside}` } };
    const { home, rpc } = await start({ FAKE_ACP_MODE: "permission", FAKE_ACP_REQUIRE_PERMISSION_PROMPTS: "1", FAKE_ACP_PERMISSION_TOOLCALL: JSON.stringify(toolCall) });
    const work = join(home, "work"); mkdirSync(work);
    await instance!.adapter.sendTurn({ threadId: "f1047-s1", text: "clean up", cwd: work } as any);
    const opened = await recorder!.until(e => e.type === "request.opened", 15000) as any;
    expect(opened.summary).toContain(outside);
    const init = rpc().find(frame => frame.method === "initialize")!;
    expect(init.params!.clientCapabilities._meta["fuigo/permissionPrompts"]).toBe(true);
    await instance!.adapter.respondToRequest("f1047-s1", opened.requestId, { behavior: "deny" });
    await recorder!.until(e => e.type === "turn.completed", 15000);
  }, 60_000);
});

// (2) the S1 ask through the server's decision path is witnessed on the REAL route in server/fuigo-1047-s1-route-api.test.ts
// (booted server, fuigoAgent driver, engine-side answer): ASTRA High 2 on 6c6d7a5e3c / 027dfb45a2.

describe("1.0.47 (3) a held server is an owner decision", () => {
  const held = [{ name: "notes-sync", heldReason: "changed since you approved it", heldDigest: "d1" }];
  const turn = async (env: Record<string, string>) => {
    // "hang": the engine keeps the turn open, so the card is answered while its turn is live
    const ctx = await start({ FAKE_ACP_MODE: "hang", FAKE_ACP_MCP_LIST: '{}', FAKE_ACP_MCP_LIST_HELD: JSON.stringify(held), ...env });
    const work = join(ctx.home, "work"); mkdirSync(work);
    await instance!.adapter.sendTurn({ threadId: "f1047-held", text: "hello", cwd: work } as any);
    const opened = await recorder!.until(e => e.type === "request.opened", 15000) as any;
    return { ...ctx, opened };
  };
  it("shows '<server> changed: Approve' and does not fail the turn; Approve sends the snake_case toggle", async () => {
    const { opened, rpc } = await turn({});
    expect(opened).toMatchObject({ requestType: "question", summary: "notes-sync changed: Approve", choices: ["Approve"] });
    await instance!.adapter.respondToRequest("f1047-held", opened.requestId, { behavior: "answer", answers: [{ id: "q1", selected: ["Approve"] }] } as any);
    expect(await recorder!.until(e => e.type === "request.resolved", 15000)).toMatchObject({ behavior: "answer" });
    const toggles = rpc().filter(frame => frame.method === "_fuigo/mcp/toggle");
    expect(toggles).toHaveLength(1);
    expect(toggles[0]!.params).toEqual({ session_id: expect.any(String), server_name: "notes-sync", enabled: true, digest: "d1" });
    // the turn goes on past the held server and ends only when stopped; nothing failed it and nothing was sent twice
    await instance!.adapter.stopAll?.();
    await recorder!.until(e => e.type === "turn.completed", 15000);
    expect(recorder!.events.some(e => e.type === "runtime.error")).toBe(false);
    expect(rpc().filter(frame => frame.method === "_fuigo/mcp/toggle")).toHaveLength(1);
  }, 60_000);
  it("an open held card is not the owner deciding: through the server's wait rule a silent engine is still stopped by the idle guard", async () => {
    vi.stubEnv("MURAGE_ACP_PROMPT_IDLE_MS", "1500");
    const threadId = "f1047-held";
    // the server's own rule (server/index.ts presentedRequests.subscribeExecution): a card that holds the human wait takes it
    const ctx = await start({ FAKE_ACP_MODE: "hang", FAKE_ACP_MCP_LIST: '{}', FAKE_ACP_MCP_LIST_HELD: JSON.stringify(held) });
    const work = join(ctx.home, "work"); mkdirSync(work);
    const seen: boolean[] = [];
    const off = instance!.adapter.onEvent((event: any) => {
      if (event.type === "request.opened") { const holds = requestHoldsHumanWait(event); seen.push(holds); if (holds) noteHumanWait(event.threadId, event.requestId, true); }
    });
    try {
      await instance!.adapter.sendTurn({ threadId, text: "hello", cwd: work } as any);
      const opened = await recorder!.until(e => e.type === "request.opened", 15000) as any;
      expect(opened.summary).toBe("notes-sync changed: Approve");
      expect(seen).toEqual([false]);
      expect(humanWaitOpen(threadId)).toBe(false);
      const done = await recorder!.until(e => e.type === "turn.completed", 20000) as any;
      expect(done.ok).toBe(false);
    } finally { off?.(); noteHumanWait(threadId, "x", false); }
  }, 60_000);
  it("server/index.ts consults the rule at BOTH places a card takes the human wait (execution subscriber and approvalAttention.ask)", () => {
    // Structural pin only; the behavioral witness on the booted server is server/fuigo-1047-held-idle-api.test.ts.
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "index.ts"), "utf8");
    expect(source).toContain('if (!requestHoldsHumanWait(event)) return;\n    const scope = eventAttentionScope(event, true);');
    // handleDecisionRequest tests `ambient` inline: the F3 production-fold fixture compiles it with only the fold's imports bound.
    expect(source).toContain("if (displayEvent?.ambient !== true) approvalAttention.ask(scope, key);");
  });
  it("a real ask still holds the human wait (the rule is not 'never')", () => {
    expect(requestHoldsHumanWait({ type: "request.opened", requestType: "permission", tool: "bash", summary: "x" } as any)).toBe(true);
  });
  it("a held Murage mount refuses the turn instead of running without it, and asks no card", async () => {
    const ctx = await start({ FAKE_ACP_MCP_LIST: "{}", FAKE_ACP_MCP_LIST_HELD: JSON.stringify([{ name: "agents", heldReason: "changed", heldDigest: "d2" }]) });
    bindFixtureAdapter(instance!.adapter);
    const work = join(ctx.home, "work"); mkdirSync(work);
    const integrations = {
      agents: { command: process.execPath, args: [SPAWNED_PROXIES.agents], env: { MURAGE_COMMS_TOKEN: "fixture-only" } },
    };
    await instance!.adapter.sendTurn({ threadId: "f1047-mount", text: "hello", cwd: work, integrations } as any);
    const done = await recorder!.until(e => e.type === "turn.completed", 30000) as any;
    expect(done).toMatchObject({ ok: false, stopReason: "memory-refused" });
    expect(recorder!.events.some(e => e.type === "request.opened")).toBe(false);
    expect(ctx.rpc().some(frame => frame.method === "session/prompt")).toBe(false);
  }, 60_000);
  it("changed again since it was shown: the toggle carries the shown digest, approves nothing, and the new definition is a new card", async () => {
    // the owner edits the server after the card was shown: the engine now holds d2, the card showed d1
    const { opened, rpc } = await turn({ FAKE_ACP_MCP_LIST_HELD_AFTER_SHOWN: JSON.stringify([{ name: "notes-sync", heldReason: "changed again", heldDigest: "d2" }]) });
    await instance!.adapter.respondToRequest("f1047-held", opened.requestId, { behavior: "answer", answers: [{ id: "q1", selected: ["Approve"] }] } as any);
    const first = await recorder!.until(e => e.type === "request.resolved" && (e as any).requestId === opened.requestId, 15000) as any;
    expect(rpc().filter(frame => frame.method === "_fuigo/mcp/toggle")[0]!.params!.digest).toBe("d1");
    expect(first.behavior).toBe("deny");
    const opens = () => recorder!.events.filter(e => e.type === "request.opened") as any[];
    await expect.poll(() => opens().length, { timeout: 10_000, interval: 50 }).toBe(2);
    const again = opens()[1]!;
    expect(again.questions[0].options[0].description).toBe("changed again");
    await instance!.adapter.respondToRequest("f1047-held", again.requestId, { behavior: "answer", answers: [{ id: "q1", selected: ["Approve"] }] } as any);
    expect(await recorder!.until(e => e.type === "request.resolved" && (e as any).requestId === again.requestId, 15000)).toMatchObject({ behavior: "answer" });
    expect(rpc().filter(frame => frame.method === "_fuigo/mcp/toggle").map(frame => frame.params!.digest)).toEqual(["d1", "d2"]);
    await instance!.adapter.stopAll?.();
    await recorder!.until(e => e.type === "turn.completed", 15000);
  }, 60_000);
  it("a toggle error (corrupt store) shows the engine's notice text and is not retried", async () => {
    const said = "approvals file unreadable; run: fuigo mcp approvals reset";
    const { opened, rpc } = await turn({ FAKE_ACP_TOGGLE_ERROR: said });
    await instance!.adapter.respondToRequest("f1047-held", opened.requestId, { behavior: "answer", answers: [{ id: "q1", selected: ["Approve"] }] } as any);
    const notice = await recorder!.until(e => e.type === "item.started" && String((e as any).title ?? "").includes("fuigo mcp approvals reset"), 15000);
    expect(notice).toBeTruthy();
    await instance!.adapter.stopAll?.();
    await recorder!.until(e => e.type === "turn.completed", 15000);
    expect(rpc().filter(frame => frame.method === "_fuigo/mcp/toggle")).toHaveLength(1);
  }, 60_000);
});
