// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
// Execute the actual index seams with isolated dependencies, without booting a server.
import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { dispatchProjectUsageTurn } from "./project-usage-dispatch.ts";
import { turnIsBackground } from "./message-automation.ts";
import { createSharedOwnerUsage } from "./shared-owner-usage.ts";
const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
function seam(name: string, deps: Record<string, unknown>) {
  const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  if (!node) throw new Error(`Missing ${name}`);
  const js = ts.transpileModule(node.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(deps), `${js}; return ${name};`)(...Object.values(deps));
}
function usageFixture() {
  const request = { id: "usage-request", groupId: "g", admissionKey: "usage:gen", state: "running", targetThreadId: "thread", dispatchedAt: 100, ownerWaitMs: 20, waitingSince: null };
  const owner = { botId: "lead", generation: "gen", notOwnerAudience: false };
  const pending = new Map(); const turns = new Map(); const bindings = new Map();
  const settle = vi.fn(); const complete = vi.fn(); const insert = vi.fn((_db: unknown, _input: unknown) => ({ request }));
  const deps = { internalTurnOwners: new Map([["thread", owner]]), turnRequestByGeneration: bindings, delegationWatch: new Map(), syncAskRequests: new Map(),
    dispatchProjectUsageTurn,
    sharedOwnerUsageTurn: seam("sharedOwnerUsageTurn", { store: { bot: () => undefined } }),
    abandonSharedOwnerUsageTurn: seam("abandonSharedOwnerUsageTurn", { sharedOwnerUsage: createSharedOwnerUsage(vi.fn()) }),
    roomRequest: () => request, database: () => ({}), projectGroupForThread: () => ({ id: "g", channelProject: true }),
    store: { messagesFor: () => [], group: () => ({ id: "g" }) }, insertRoomRequest: insert, activeRoomGoal: () => "goal",
    roomLineage: () => ({ notOwnerAudience: true }), projectUsagePending: pending, projectUsageTurns: turns,
    settleProjectUsage: settle, completeRequest: complete, projectFrames: { strip: vi.fn() }, projectBudgetGate: { evaluate: vi.fn() },
    // the warm-engine identity the usage turn now carries (mobile lane): no proven human here
    threadHumanPrincipal: () => undefined,
    // background work is told by the dispatch's own request (a routine's): the real classifier
    turnIsBackground,
  };
  return { request, owner, pending, turns, bindings, settle, complete, insert, deps };
}
it("F3 refuses an ask from the lead reply at the project budget line", () => {
  const check = vi.fn(() => ({ ok: false, line: "Budget reached: raise it or stop." }));
  const ask = seam("roomAskRefused", { roomAskParent: () => ({ id: "reply", groupId: "g", projectGoalId: "goal" }), database: () => ({}),
    askWouldDeadlock: () => false, store: { group: () => ({ id: "g", channelProject: true }) },
    roomProjectContext: () => ({ mode: "goal", goalId: "goal", goalState: "working" }), projectBudgetGate: { check }, cfg: { features: {} } });
  expect(ask("lead", "worker", "thread")).toBe("Budget reached: raise it or stop.");
  expect(check).toHaveBeenCalledWith(expect.objectContaining({ groupId: "g", goalId: "goal", kind: "ask" }));
});
it("F4 accounting lineage preserves a non-owner room audience", async () => {
  const f = usageFixture();
  await seam("sendProjectUsageTurn", f.deps)({ driverKind: "fake", adapter: { sendTurn: async () => ({ turnId: "turn" }) } }, { threadId: "thread" });
  expect(f.insert.mock.calls[0]![1]).toMatchObject({ lineage: { notOwnerAudience: true } });
});
it("F5 a send failure finishes the synthetic request without continuation", async () => {
  const f = usageFixture();
  await expect(seam("sendProjectUsageTurn", f.deps)({ driverKind: "fake", adapter: { sendTurn: async () => { throw new Error("send failed"); } } }, { threadId: "thread" })).rejects.toThrow("send failed");
  expect(f.complete).toHaveBeenCalledWith(expect.anything(), "usage-request", expect.objectContaining({ state: "failed" }), expect.anything(), { continuation: false });
  expect(f.pending.size).toBe(0);
});
it.each(["gen", "admission-generation"])("F6 immediate claims (%s) and usage runs count once, excluding owner wait", claimGeneration => {
  const f = usageFixture(); const now = Date.now(); f.request.dispatchedAt = now - 100; f.request.ownerWaitMs = 40;
  f.pending.set("thread", { request: f.request, generation: "gen", botId: "lead" });
  const begin = source.indexOf("  running:()=>{", source.indexOf("const projectBudgetGate ="));
  const end = source.indexOf("\n  line:", begin);
  const js = ts.transpileModule(`const opts={${source.slice(begin,end)}};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const deps = { ...f.deps, workAdmission: { liveTurns: () => [{ groupId: "g", botId: "lead", threadId: "thread", turnGeneration: claimGeneration, startedAt: now - 100 }] } };
  vi.spyOn(Date, "now").mockReturnValue(now);
  try { const running = new Function(...Object.keys(deps), `${js}; return opts.running();`)(...Object.values(deps)); expect(running).toHaveLength(1); expect(running[0].workMs).toBe(60); }
  finally { vi.restoreAllMocks(); }
});
it("F7 revoking a generation settles and removes a dead usage run", () => {
  const f = usageFixture(); const run = { request: f.request, generation: "gen", botId: "lead", engine: "fake" };
  f.pending.set("thread", run); f.turns.set(JSON.stringify(["thread", "turn"]), run);
  const deps: Record<string, unknown> = { ...f.deps, hostComputerThreads: new Map(), projectTurnLeases: { abandon: vi.fn() }, internalCapabilities: { revokeGeneration: vi.fn() } };
  // The cleanup seam is injected only if the implementation uses one.
  if (source.includes("function abandonProjectUsageTurn(")) deps.abandonProjectUsageTurn = seam("abandonProjectUsageTurn", deps);
  seam("revokeInternalGeneration", deps)("thread", "gen");
  expect(f.settle).toHaveBeenCalledOnce(); expect(f.pending.size).toBe(0); expect(f.turns.size).toBe(0);
  expect(f.complete).toHaveBeenCalledWith(expect.anything(), "usage-request", expect.objectContaining({ state: "failed" }), expect.anything(), { continuation: false });
});
it("shared-owner accounting holds asks and settles a failed send", async () => {
  const settleSharedOwner = vi.fn(), sharedOwnerUsage = createSharedOwnerUsage(settleSharedOwner);
  const sendTurn = vi.fn(async () => { throw Error("shared send failed"); });
  const send = seam("sharedOwnerUsageTurn", { sharedOwnerUsage, store: { bot: () => ({ tasks: [{ threadId: "work", sharedWork: { teamId: "sales" } }] }), messagesFor: () => [{ id: "message", role: "user" }] } });
  await expect(send({ driverKind: "fake", adapter: { sendTurn } }, { threadId: "work" }, { botId: "bot", generation: "gen" })).rejects.toThrow("shared send failed");
  expect(sendTurn).toHaveBeenCalledWith({ threadId: "work", holdPermissionAsks: true, holdProjectAsks: true });
  expect(settleSharedOwner).toHaveBeenCalledTimes(1);
  expect(settleSharedOwner).toHaveBeenCalledWith("work", expect.objectContaining({ generation: "gen", teamId: "sales", messageId: "message" }), { ok: false });
  expect(sharedOwnerUsage.has("work")).toBe(false);
});
it("shared-owner abandonment settles only the revoked generation", () => {
  const settleSharedOwner = vi.fn(), sharedOwnerUsage = createSharedOwnerUsage(settleSharedOwner);
  sharedOwnerUsage.begin("work", { generation: "gen", botId: "bot", teamId: "sales", messageId: "message", engine: "fake", startedAt: 1, ownerWaitMs: 0, asks: new Set() });
  const abandon = seam("abandonSharedOwnerUsageTurn", { sharedOwnerUsage });
  abandon("work", "old"); expect(settleSharedOwner).not.toHaveBeenCalled();
  abandon("work", "gen"); expect(settleSharedOwner).toHaveBeenCalledWith("work", expect.objectContaining({ generation: "gen" }), { ok: false });
});
