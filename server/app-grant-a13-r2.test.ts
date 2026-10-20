// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Astra a13 r2, fixed as classes (lanes/release103/A13-FIX-DESIGN.md):
//   - C1 (r2 #1, #2): a durable grant is written only through the one choke
//     point, with its approving answer, in one atomic write, taken back when
//     the answer does not land; settings may only narrow.
//   - C2 (r2 #3): recipient keys are always per recipient.
//   - C3 (r2 #4): any parse failure of the grant reader is unread.
//   - C4 (r2 #5): room routines resolve through the room's real members.
//
// Pure tests over the real readers, the real store and routine manager on
// isolated temp data, and the server source; nothing reaches ~/.murage.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { actionGrantRead, actionGrantSet, type GrantCall } from "../shared/app-action-grant.ts";
import type { McpMountRecord } from "../shared/mount-identity.ts";
import { grantRequestFor } from "./approval-grant-request.ts";
import { autoVerdict, type AutoContext } from "./auto-approve.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { routineCardThreadOf } from "./routine-permissions.ts";
import { RoutineManager, type RoutineManagerOptions } from "./routines.ts";
import { chatAllowance } from "./stop-line-state.ts";
import { classifyAsk, classifyAskRows, stopFindings, stopLineKey, stopLineKeyCovers, stopLineKeys, type StopHit, type StopLinePlace } from "./stop-line.ts";
import { Store } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

type Ask = GrantCall & { tool: string; summary: string };
const OWN: McpMountRecord = { engineName: "murage_connectors", mountId: "own:connector", provenance: "own" };
const EXECUTE = "murage_connectors__APPS_MULTI_EXECUTE_TOOL";
const row = (tool_slug: string, args: Record<string, unknown> = {}) => ({ tool_slug, arguments: args });
const batch = (...rows: unknown[]) => ({ tools: rows });
const fuigo = (input: unknown): Ask => ({
  tool: "other", summary: "Run app tools", toolKind: "other", engine: "acp",
  toolIdentity: { namespace: "mcp", name: EXECUTE }, toolCall: { name: "Run app tools", input }, mcpMounts: [OWN],
});
const place: StopLinePlace = { home: "/Users/ada", cwd: "/Users/ada/work", roots: ["/Users/ada/work"], knownRecipients: new Set(["ada@example.com"]), realpath: (p: string) => p };
const ctx = (ask: Ask, extra: AutoContext = {}): AutoContext => ({ call: ask, stopLine: classifyAsk(ask, place), stopRows: classifyAskRows(ask, place), ...extra });
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const TWO = fuigo(batch(row("GMAIL_SEND_EMAIL", { recipient_email: "bob@example.com", cc: "eve@example.com" })));
const BOB = "stop:message:bob@example.com";
const EVE = "stop:message:eve@example.com";

describe("C2 (r2 #3): a one-row call with two recipients is judged per recipient", () => {
  it("needs both recipient keys, and one key leaves it held", () => {
    for (const via of ["alwaysAllow", "taskAllowanceKeys"] as const) {
      const judge = (keys: string[]) => via === "alwaysAllow"
        ? autoVerdict({ alwaysAllow: keys }, TWO.tool, TWO.summary, ctx(TWO))
        : autoVerdict({}, TWO.tool, TWO.summary, ctx(TWO, { taskAllowanceKeys: keys }));
      expect(judge([BOB]).source, via).toBe("stop-line");
      expect(judge([EVE]).source, via).toBe("stop-line");
      expect(judge([BOB, EVE]).approve, via).not.toBeNull();
    }
  });

  it("a legacy combined key covers nobody, on a one-row call or any tool", () => {
    const legacy = "stop:message:bob@example.com,eve@example.com";
    expect(autoVerdict({ alwaysAllow: [legacy] }, TWO.tool, TWO.summary, ctx(TWO)).approve).toBeNull();
    const combined: StopHit = { kind: "message", place: "bob@example.com,eve@example.com", what: "Message someone it has not written to before: bob@example.com, eve@example.com" };
    expect(autoVerdict({ alwaysAllow: [legacy] }, "Bash", "send", { stopLine: combined }).approve).toBeNull();
    expect(autoVerdict({ alwaysAllow: [BOB, EVE] }, "Bash", "send", { stopLine: combined }).approve).not.toBeNull();
    for (const hit of stopFindings(combined)) expect(stopLineKeyCovers(legacy, hit)).toBe(false);
    expect(stopLineKeyCovers(BOB, combined)).toBe(false);
  });

  it("class: no key builder ever names two recipients at once", () => {
    const combined: StopHit = { kind: "message", place: "bob@example.com,eve@example.com", what: "x" };
    expect(stopLineKey(combined)).toBeUndefined();
    expect(stopLineKeys(combined)).toEqual([BOB, EVE]);
    expect(stopFindings(combined).map((hit) => hit.place)).toEqual(["bob@example.com", "eve@example.com"]);
    // the call-level hit of a real one-row call, the card's routine offer and a chat allowance
    const hit = classifyAsk(TWO, place)!;
    for (const key of stopLineKeys(hit)) expect(key.includes(",")).toBe(false);
    const request = grantRequestFor({ ask: TWO, stopHit: hit, stopRows: classifyAskRows(TWO, place), inputCut: false, routine: { routineId: "r1", routineName: "Training" } })!;
    expect(request.routine?.stopKeys.map((stop) => stop.key)).toEqual([BOB, EVE]);
    expect(request.routine?.stopKeys.map((stop) => stop.recipient)).toEqual(["bob@example.com", "eve@example.com"]);
    const said = chatAllowance({ kind: "message", place: "bob@example.com,eve@example.com" }, "you can message bob@example.com,eve@example.com", "/Users/ada", (p: string) => p);
    expect(said.ok).toBe(false);
  });
});

describe("C3 (r2 #4): any parse failure of the grant reader is unread", () => {
  const rejects: Array<[string, unknown]> = [
    ["an extra field on a read row", batch({ ...row("GMAIL_FETCH_EMAILS"), sync_response_to_workbench: true })],
    ["a slug Murage cannot identify", batch(row("not a slug"))],
    ["arguments that are not an object", batch({ tool_slug: "GMAIL_FETCH_EMAILS", arguments: "x" })],
    ["an account Murage cannot read", batch({ ...row("GMAIL_FETCH_EMAILS"), account: 5 })],
    ["an empty list", batch()],
  ];
  it("every reject branch carries its reason and no set", () => {
    for (const [what, input] of rejects) {
      const result = actionGrantRead(fuigo(input).tool, fuigo(input));
      expect(result.set, what).toBeNull();
      expect(result.unread, what).toBeTruthy();
      expect(actionGrantSet(fuigo(input).tool, fuigo(input)), what).toBeNull();
    }
    expect(actionGrantRead(fuigo(batch(row("GMAIL_FETCH_EMAILS"))).tool, fuigo(batch(row("GMAIL_FETCH_EMAILS")))).unread).toBeUndefined();
  });

  it("holds a read row with an extra field as unread, under Auto and under Full access", () => {
    const ask = fuigo(rejects[0]![1]);
    for (const bot of [{ autoApprove: true }, { autoApprove: true, fullAccess: true }, { autoApprove: true, fullAccess: true, noLimits: true }]) {
      const verdict = autoVerdict(bot, ask.tool, ask.summary, ctx(ask));
      expect(verdict.approve, JSON.stringify(bot)).toBeNull();
      expect(verdict.source, JSON.stringify(bot)).toBe("unread-call");
    }
  });
});

describe("C4 (r2 #5): a room routine resolves through the room's real members", () => {
  const room = { id: "room-1", memberIds: ["lead", "helper"] };
  const lookup = {
    taskByThread: (botId: string, threadId: string) => (botId === "dax" && threadId === "dax-task" ? {} : undefined),
    groupByThread: (threadId: string) => (threadId === "room-goal-thread" ? room : threadId === "other-room" ? { id: "room-2", memberIds: ["lead"] } : undefined),
  };
  it("accepts the room's own thread when the routine's bot is a member", () => {
    expect(routineCardThreadOf({ botId: "lead", target: "room-goal", groupId: "room-1" }, "room-goal-thread", lookup)).toBe(true);
  });
  it("refuses another room, a non-member and a bot's task list for a room goal", () => {
    expect(routineCardThreadOf({ botId: "lead", target: "room-goal", groupId: "room-1" }, "other-room", lookup)).toBe(false);
    expect(routineCardThreadOf({ botId: "stranger", target: "room-goal", groupId: "room-1" }, "room-goal-thread", lookup)).toBe(false);
    expect(routineCardThreadOf({ botId: "dax", target: "room-goal", groupId: "room-1" }, "dax-task", lookup)).toBe(false);
  });
  it("keeps a bot routine on that bot's own task threads", () => {
    expect(routineCardThreadOf({ botId: "dax", target: "bot" }, "dax-task", lookup)).toBe(true);
    expect(routineCardThreadOf({ botId: "dax", target: "bot" }, "room-goal-thread", lookup)).toBe(false);
  });
  it("the routine grant route uses it, not the bot's task list", () => {
    const index = read("./index.ts");
    const route = index.slice(index.indexOf("let routineMatch = path.match(/^\\/api\\/routines\\/([\\w-]+)\\/always-allow"), index.indexOf("routineMatch = path.match(/^\\/api\\/routines\\/([\\w-]+)\\/run$/);"));
    expect(route).toContain("routineCardThread(routine, threadId)");
    expect(route).not.toContain("store.taskByThread(routine.botId, threadId)");
  });
});

describe("C1 (r2 #1, #2; r3 amendment): one choke point writes every durable grant, after its answer", () => {
  const index = read("./index.ts");
  const choke = read("./grant-choke.ts");
  const routineRoute = index.slice(index.indexOf("let routineMatch = path.match(/^\\/api\\/routines\\/([\\w-]+)\\/always-allow"), index.indexOf("routineMatch = path.match(/^\\/api\\/routines\\/([\\w-]+)\\/run$/);"));
  const botRoute = index.slice(index.indexOf("m = path.match(/^\\/api\\/bots\\/([\\w-]+)\\/always-allow$/);"), index.indexOf("m = path.match(/^\\/api\\/bots\\/([\\w-]+)$/);"));

  it("the choke point requires the answer, rereads, refuses in-flight answers, stages a pending row, and writes only after allowed-once", () => {
    expect(choke).toContain("if (input.answer !== true) return { ok: false, status: 400");
    expect(choke).toContain("if (deps.inFlight(flight))");
    expect(choke).toContain("if (outcome !== \"allowed-once\")");
    const stage = choke.indexOf("deps.pending.stage(flight");
    const answer = choke.indexOf("await deps.answer(");
    const write = choke.indexOf("value = input.write()");
    expect(stage).toBeGreaterThan(choke.indexOf("if (deps.inFlight(flight))"));
    expect(answer).toBeGreaterThan(stage);
    expect(write).toBeGreaterThan(choke.indexOf("if (outcome !== \"allowed-once\")"));
    // no rollback write exists anywhere: nothing can fail to take a grant back
    expect(choke).not.toMatch(/\bundo\b|forget(Bot|AlwaysAllow)/);
    expect(index).not.toMatch(/forgetBotGrants|forgetAlwaysAllowSet|\bundo:/);
    expect(read("./store.ts")).not.toContain("forgetBotGrants(");
    expect(read("./routines.ts")).not.toContain("forgetAlwaysAllowSet(");
  });

  it("the wiring answers a peer holder through the bus, inside the in-flight mark", () => {
    const wiring = index.slice(index.indexOf("const grantChoke: GrantChokeDeps = {"), index.indexOf("async function rememberAndAnswer<T>("));
    expect(wiring).toContain("peerApprovalHolder(requestId)");
    expect(wiring).toContain("peer.threadId === threadId && peer.fromBotId === holderId");
    expect(wiring).toMatch(/inFlightDuring\(`\$\{threadId\}:\$\{requestId\}`, async \(\) => \(resolvePeerComms\(approvalBus, requestId, "allow"\)/);
    expect(index.match(/new PendingGrants\(/g)).toHaveLength(1);
  });

  it("both card routes write only through it, plan before, and never without an answer", () => {
    for (const [name, route] of [["routine", routineRoute], ["bot", botRoute]] as const) {
      expect(route, name).toContain("await rememberAndAnswer({");
      expect(route, name).toContain("plan: () =>");
      expect(route, name).not.toMatch(/if \(!answer\) return/);
      expect(route, name).not.toMatch(/patchBot\(|patchTask\(|grantAlwaysAllowSet\(|undo/);
    }
    expect(routineRoute).toContain("routines!.planAlwaysAllowSet(routineId, keys)");
    expect(botRoute).toContain("store.planBotGrants(grantBotId, taskThread, grantKeys)");
  });

  it("class: index.ts writes a card's grant nowhere else", () => {
    // every writer of a remembered approval, counted across the whole server entry
    expect(index.match(/store\.rememberBotGrants\(/g)).toHaveLength(1);
    expect(index.match(/routines!\.rememberAlwaysAllowSet\(/g)).toHaveLength(1);
    expect(index.match(/grantAlwaysAllowSet\(|grantAlwaysAllow\(/g) ?? []).toHaveLength(0);
    // a patch that sets alwaysAllow may only filter what is held
    const sets = [...index.matchAll(/patch(?:Bot|Task)\([^;]*alwaysAllow\s*:([^;]*)/g)].map((match) => match[1]!);
    expect(sets.length).toBeGreaterThan(0);
    for (const value of sets) expect(value, value.slice(0, 120)).toMatch(/^\s*\(?[\w.]+(?:\.alwaysAllow)?\s*(?:\?\?\s*\[\]\s*\))?\.filter\(/);
    // the one other writer is the owner's desktop settings route, never reachable from a card or the phone
    expect(index.match(/patch\.alwaysAllow = /g)).toHaveLength(1);
    const settings = index.slice(index.lastIndexOf("m = path.match", index.indexOf("patch.alwaysAllow = ")), index.indexOf("patch.alwaysAllow = "));
    expect(settings).toContain("requestSurface(req.headers,url.searchParams)");
    expect(read("./route-policy.ts")).toContain('{ methods: ["PATCH", "DELETE"], path: re(`/api/bots/${ID}`), class: "desktop"');
  });
});

describe("C1 (r2 #2): bot and task are saved in one write, or not at all", () => {
  const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
  beforeEach(() => { removeTempDirSync(DATA_DIR); });

  it("writes the bot default and the task together and survives a reload", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const { added } = store.rememberBotGrants(bot.id, bot.threadId, [BOB, BOB, EVE]);
    expect(added).toEqual({ bot: [BOB, EVE], task: [BOB, EVE] });
    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.alwaysAllow).toEqual([BOB, EVE]);
    expect(reloaded.taskByThread(bot.id, bot.threadId)?.alwaysAllow).toEqual([BOB, EVE]);
  });

  it("the plan names what the write would add, and writes nothing", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.rememberBotGrants(bot.id, undefined, [BOB]);
    const planned = store.planBotGrants(bot.id, bot.threadId, [BOB, EVE, EVE]);
    expect(planned.added).toEqual({ bot: [EVE], task: [BOB, EVE] });
    expect(store.bot(bot.id)?.alwaysAllow).toEqual([BOB]);
    expect(store.taskByThread(bot.id, bot.threadId)?.alwaysAllow ?? []).toEqual([]);
    expect(new Store(selection).bot(bot.id)?.alwaysAllow).toEqual([BOB]);
    expect(() => store.planBotGrants("nobody", undefined, [BOB])).toThrow("no such bot");
    expect(() => store.planBotGrants(bot.id, "no-such-thread", [BOB])).toThrow("No such thread");
  });

  it("a failed write changes neither memory nor disk", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const writer = store as unknown as { saveBots: (...args: unknown[]) => void };
    const real = writer.saveBots.bind(store);
    writer.saveBots = () => { throw new Error("disk full"); };
    expect(() => store.rememberBotGrants(bot.id, bot.threadId, [BOB])).toThrow("disk full");
    writer.saveBots = real;
    expect(store.bot(bot.id)?.alwaysAllow ?? []).toEqual([]);
    expect(store.taskByThread(bot.id, bot.threadId)?.alwaysAllow ?? []).toEqual([]);
    expect(new Store(selection).bot(bot.id)?.alwaysAllow ?? []).toEqual([]);
  });

  it("past the cap nothing is saved", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.rememberBotGrants(bot.id, undefined, Array.from({ length: 200 }, (_, i) => `stop:message:p${i}@example.com`));
    expect(() => store.rememberBotGrants(bot.id, bot.threadId, [BOB])).toThrow(/200/);
    expect(store.bot(bot.id)?.alwaysAllow).toHaveLength(200);
    expect(store.taskByThread(bot.id, bot.threadId)?.alwaysAllow ?? []).toEqual([]);
  });
});

describe("C1: a routine's set is planned before its answer and written only after", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) removeTempDirSync(dir); });
  it("the plan names only what the write would add, and writes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-a13r2-"));
    dirs.push(dir);
    const options: RoutineManagerOptions = {
      file: join(dir, "routines.json"), now: () => new Date(2026, 9, 18, 8).getTime(), botState: () => "ready",
      createTask: () => ({ threadId: "thread-1" }), startTurn: async () => {}, interruptTurn: async () => {},
    };
    const manager = new RoutineManager(options);
    const routine = manager.create({ name: "Training", prompt: "Prepare", botId: "dax", enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() } });
    manager.grantAlwaysAllowSet(routine.id, [BOB]);
    expect(manager.planAlwaysAllowSet(routine.id, [BOB, EVE, EVE])?.added).toEqual([EVE]);
    expect(manager.planAlwaysAllowSet("nobody", [EVE])).toBeNull();
    expect(() => manager.planAlwaysAllowSet(routine.id, ["mcp__anything__tool"])).toThrow(/scoped place/);
    expect(new RoutineManager({ ...options }).listRoutines()[0]?.alwaysAllow).toEqual([BOB]);
    const written = manager.rememberAlwaysAllowSet(routine.id, [BOB, EVE])!;
    expect(written.added).toEqual([EVE]);
    expect(new RoutineManager({ ...options }).listRoutines()[0]?.alwaysAllow).toEqual([BOB, EVE]);
  });
});
