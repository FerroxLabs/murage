import { describe, expect, it } from "vitest";

import {
  awaitRequiredMcp,
  isUnsupportedAnswer,
  McpBackoff,
  McpStatusSupport,
  mcpFirstAnswerMs,
  MCP_STATUS_ANSWER_MS,
  NOT_DONE_PREFIX,
  parseMcpStatus,
  splitMcpServers,
  startsWithNotDone,
  toolsMayBeLoadingNotice,
  toolsUnavailableNotice,
  toolsUnavailableRunError,
  unavailableLabels,
  type McpServerState,
} from "./mcp-readiness.ts";

/** A fake engine clock: status answers follow a script keyed on elapsed time.
 * A reconnect resolves at once to `reconnectTo[name]`, or never ("hang"). */
function fakeIo(script: (elapsed: number) => Record<string, McpServerState>, reconnectTo: Record<string, McpServerState | "hang"> = {}) {
  let now = 0;
  const reconnected: Array<{ name: string; at: number; timeoutMs: number }> = [];
  const forced = new Map<string, McpServerState>();
  return {
    reconnected,
    clock: () => now,
    io: {
      now: () => now,
      // Yields a turn first, as a real timer does, so a settled reconnect wins its race.
      sleep: async (ms: number) => { await new Promise((resolve) => setImmediate(resolve)); now += ms; },
      stopped: () => false,
      status: async () => new Map(Object.entries({ ...script(now), ...Object.fromEntries(forced) })) as Map<string, McpServerState>,
      reconnect: (name: string, timeoutMs: number) => {
        reconnected.push({ name, at: now, timeoutMs });
        const to = reconnectTo[name];
        if (to === "hang") return new Promise<void>(() => {});
        if (to) forced.set(name, to);
        return Promise.resolve();
      },
    },
  };
}

const budgets = { requiredMs: 15_000, optionalMs: 3_000, recoveryMs: 20_000 };

describe("required MCP servers", () => {
  it("splits Murage's required servers from optional ones", () => {
    expect(splitMcpServers(["composio", "murage-memory", "agents", "computer", "browser", "muragebox", "memory"])).toEqual({
      required: ["composio", "murage-memory", "agents", "muragebox"],
      optional: ["computer", "browser", "memory"],
    });
    expect(unavailableLabels(["composio", "murage-memory"])).toEqual(["connected apps", "memory"]);
  });

  // 1.0.3.1: Claude Code ends the turn (exit 1, "mcp__muragebox__approve ... not found") at the first approval when the
  // permission broker has not connected, so it is waited for and reconnected like the other required servers.
  it("waits for the permission broker past the optional budget and reconnects it when it failed", async () => {
    expect(unavailableLabels(["muragebox"])).toEqual(["approvals"]);
    const slow = fakeIo((t) => ({ muragebox: t < 6_000 ? "pending" : "connected", computer: "pending" }));
    const waited = await awaitRequiredMcp(splitMcpServers(["muragebox", "computer"]), slow.io, budgets);
    expect(waited.missing).toEqual([]);
    expect(waited.waitedMs).toBeGreaterThanOrEqual(6_000);
    expect(waited.notConnected).toEqual([{ name: "computer", state: "pending" }]);
    const failed = fakeIo(() => ({ muragebox: "failed" }), { muragebox: "connected" });
    const healed = await awaitRequiredMcp(splitMcpServers(["muragebox"]), failed.io, budgets);
    expect(failed.reconnected.map((r) => r.name)).toEqual(["muragebox"]);
    expect(healed).toMatchObject({ missing: [], readiness: "ready", reconnected: ["muragebox"], notConnected: [] });
  });

  it("reports every server that did not connect with its last state, an unlisted one as absent", async () => {
    const { io } = fakeIo(() => ({ muragebox: "failed", "murage-memory": "connected", computer: "failed" }));
    const result = await awaitRequiredMcp({ required: ["muragebox", "murage-memory", "agents"], optional: ["computer"] }, io, budgets);
    expect(result.missing).toEqual(["muragebox", "agents"]);
    expect(result.notConnected).toEqual([{ name: "muragebox", state: "failed" }, { name: "agents", state: "absent" }, { name: "computer", state: "failed" }]);
  });

  it("returns at once, with one status read, when everything is connected", async () => {
    let reads = 0;
    const { io } = fakeIo(() => { reads++; return { composio: "connected", "murage-memory": "connected" }; });
    const result = await awaitRequiredMcp({ required: ["composio", "murage-memory"], optional: [] }, io, budgets);
    expect(result).toMatchObject({ missing: [], readiness: "ready", waitedMs: 0 });
    expect(reads).toBe(1);
  });

  it("waits for a required server and stops as soon as it connects", async () => {
    const { io, reconnected } = fakeIo((t) => ({ composio: t >= 8_000 ? "connected" : "pending", computer: "connected" }));
    const result = await awaitRequiredMcp({ required: ["composio"], optional: ["computer"] }, io, budgets);
    expect(result).toMatchObject({ missing: [], reconnected: [], unchecked: false, readiness: "ready" });
    expect(result.waitedMs).toBeGreaterThanOrEqual(8_000);
    expect(result.waitedMs).toBeLessThan(8_500);
    expect(reconnected).toEqual([]);
  });

  it("does not restart a server still connecting: it is reported missing at the wait bound", async () => {
    const { io, reconnected } = fakeIo(() => ({ composio: "pending" }));
    const result = await awaitRequiredMcp({ required: ["composio"], optional: [] }, io, budgets);
    expect(reconnected).toEqual([]);
    expect(result).toMatchObject({ missing: ["composio"], readiness: "degraded" });
    expect(result.waitedMs).toBeLessThanOrEqual(15_250);
  });

  it("reconnects every failed server at once, under ONE deadline for the turn", async () => {
    const { io, reconnected } = fakeIo(() => ({ composio: "failed", "murage-memory": "failed", agents: "failed" }),
      { composio: "hang", "murage-memory": "hang", agents: "hang" });
    const result = await awaitRequiredMcp({ required: ["composio", "murage-memory", "agents"], optional: [] }, io, budgets);
    // All three sent together at the first read, none after another.
    expect(reconnected.map((r) => r.name).sort()).toEqual(["agents", "composio", "murage-memory"]);
    expect(new Set(reconnected.map((r) => r.at))).toEqual(new Set([0]));
    // Three hanging reconnects cost what one does: the turn's deadline.
    expect(result.waitedMs).toBeLessThanOrEqual(20_000);
    expect(result.missing.sort()).toEqual(["agents", "composio", "murage-memory"]);
  });

  it("counts a reconnect that brings the server up", async () => {
    const { io } = fakeIo(() => ({ composio: "failed" }), { composio: "connected" });
    const result = await awaitRequiredMcp({ required: ["composio"], optional: [] }, io, budgets);
    expect(result).toMatchObject({ missing: [], reconnected: ["composio"], readiness: "ready" });
  });

  it("backs off a server that keeps failing, so the next turns do not pay for it again", async () => {
    const store = new McpBackoff(() => clock());
    const backoff = { store, key: (name: string) => `t1\0${name}` };
    const first = fakeIo(() => ({ composio: "failed", "murage-memory": "connected" }), { composio: "hang" });
    const clock = first.clock;
    const r1 = await awaitRequiredMcp({ required: ["composio", "murage-memory"], optional: [] }, { ...first.io, backoff }, budgets);
    expect(r1.missing).toEqual(["composio"]);
    expect(r1.waitedMs).toBe(20_000);
    // The next turn, a moment later: composio is skipped (still reported), nothing waits.
    const second = fakeIo(() => ({ composio: "failed", "murage-memory": "connected" }), { composio: "hang" });
    const r2 = await awaitRequiredMcp({ required: ["composio", "murage-memory"], optional: [] }, { ...second.io, backoff }, budgets);
    expect(second.reconnected).toEqual([]);
    expect(r2).toMatchObject({ missing: ["composio"], backedOff: ["composio"], waitedMs: 0 });
    // Once it reports connected the backoff is gone.
    const third = fakeIo(() => ({ composio: "connected", "murage-memory": "connected" }));
    const r3 = await awaitRequiredMcp({ required: ["composio", "murage-memory"], optional: [] }, { ...third.io, backoff }, budgets);
    expect(r3.missing).toEqual([]);
    expect(store.blocked("t1\0composio")).toBe(false);
  });

  it("a backed-off server still gets one background reconnect per backoff window, and a recovery clears the backoff", async () => {
    let at = 0;
    const store = new McpBackoff(() => at);
    const backoff = { store, key: (name: string) => `t1\0${name}` };
    store.failed(backoff.key("composio"));
    // Inside the first window: skipped, no probe yet.
    at = 30_000;
    const early = fakeIo(() => ({ composio: "failed" }), { composio: "connected" });
    await awaitRequiredMcp({ required: ["composio"], optional: [] }, { ...early.io, backoff }, budgets);
    expect(early.reconnected).toEqual([]);
    expect(store.blocked(backoff.key("composio"))).toBe(true);
    // A backoff grown to several minutes: one probe per base window, not one per 15 minutes.
    store.failed(backoff.key("composio"));
    store.failed(backoff.key("composio"));
    at = 30_000 + 61_000;
    const probe = fakeIo(() => ({ composio: "failed" }), { composio: "connected" });
    const result = await awaitRequiredMcp({ required: ["composio"], optional: [] }, { ...probe.io, backoff }, budgets);
    // The turn itself is not held and still hears the server is missing.
    expect(result).toMatchObject({ missing: ["composio"], backedOff: ["composio"], waitedMs: 0 });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(probe.reconnected.map((r) => r.name)).toEqual(["composio"]);
    // The probe found it connected: no longer hidden.
    expect(store.blocked(backoff.key("composio"))).toBe(false);
    // Once per window.
    store.failed(backoff.key("composio"));
    const again = fakeIo(() => ({ composio: "failed" }), { composio: "hang" });
    await awaitRequiredMcp({ required: ["composio"], optional: [] }, { ...again.io, backoff }, budgets);
    expect(again.reconnected).toEqual([]);
  });

  it("recognises 'Not done:' through markdown emphasis, leading space and case", () => {
    for (const reply of ["Not done: x", "  not done: x", "**Not done:** x", "**Not done**: x", "> _NOT DONE_: x", "## Not done: x"]) expect(startsWithNotDone(reply)).toBe(true);
    for (const reply of ["Done.", "I have not done that: x", "Nothing was not done", ""]) expect(startsWithNotDone(reply)).toBe(false);
  });

  it("never holds a turn past the optional budget for an optional server", async () => {
    const { io, reconnected } = fakeIo(() => ({ composio: "connected", browser: "pending" }));
    const result = await awaitRequiredMcp({ required: ["composio"], optional: ["browser"] }, io, budgets);
    expect(result.missing).toEqual([]);
    expect(result.waitedMs).toBeLessThanOrEqual(3_250);
    expect(reconnected).toEqual([]);
  });

  it("tells an engine that cannot say apart from one that said", async () => {
    const silent = await awaitRequiredMcp({ required: ["composio"], optional: [] }, { status: async () => null, reconnect: async () => {}, stopped: () => false });
    expect(silent).toMatchObject({ unchecked: true, uncheckedReason: "no-answer", readiness: "unknown", missing: [] });
    const refused = await awaitRequiredMcp({ required: ["composio"], optional: [] }, { status: async () => "unsupported", reconnect: async () => {}, stopped: () => false });
    expect(refused).toMatchObject({ unchecked: true, uncheckedReason: "unsupported", readiness: "unknown" });
  });

  it("remembers per CLI build whether it answers the status request", () => {
    const support = new McpStatusSupport();
    support.observe("cli@2.1.296", "unsupported");
    expect(support.get("cli@2.1.296")).toBe("unsupported");
    // A silent build is unsupported after two silent turns; one that answered stays supported.
    support.observe("cli@silent", "no-answer");
    expect(support.get("cli@silent")).toBe("probing");
    support.observe("cli@silent", "no-answer");
    expect(support.get("cli@silent")).toBe("unsupported");
    support.observe("cli@ok", "answered");
    support.observe("cli@ok", "no-answer");
    support.observe("cli@ok", "no-answer");
    expect(support.get("cli@ok")).toBe("supported");
    expect(isUnsupportedAnswer("Unsupported control request subtype: mcp_status")).toBe(true);
    expect(isUnsupportedAnswer("MCP server busy")).toBe(false);
  });

  it("reads the CLI's mcp_status answer", () => {
    expect(parseMcpStatus({ mcpServers: [{ name: "composio", status: "pending" }, { name: "computer", status: "connected" }, { name: "x", status: "odd" }] }))
      .toEqual(new Map([["composio", "pending"], ["computer", "connected"], ["x", "unknown"]]));
    expect(parseMcpStatus({})).toBeNull();
  });

  it("words the notices plainly, by whether the task needs the tools, within the copy rules", () => {
    const texts = [
      toolsUnavailableNotice(["connected apps"]),
      toolsUnavailableNotice(["connected apps", "memory"]),
      toolsMayBeLoadingNotice(["connected apps"]),
      toolsUnavailableRunError(["connected apps"]),
      toolsUnavailableRunError(["memory"]),
      toolsUnavailableRunError([]),
    ];
    for (const text of texts) expect(text).not.toMatch(/composio|—|–|\bsafe|safety|unsafe/i);
    const notice = toolsUnavailableNotice(["messaging other bots"]);
    expect(notice).toContain("If this task does not need messaging other bots, do it as usual and report it as you normally would.");
    expect(notice).toContain(`start your reply with "${NOT_DONE_PREFIX}"`);
    expect(notice).not.toContain("do not report the task as done");
    expect(toolsUnavailableRunError(["connected apps"])).toBe("Connected apps were not ready when this run started, and the run needed them.");
    expect(toolsUnavailableRunError(["memory"])).toBe("Memory was not ready when this run started, and the run needed it.");
    expect(toolsUnavailableNotice(["connected apps", "memory"])).toContain("connected apps and memory were not ready");
    // Every label reads as a sentence: no "was may", and approvals is plural.
    expect(toolsMayBeLoadingNotice(["approvals"])).toBe(`[Murage: the tools for approvals may still have been loading when this turn started. If they are there, use them as usual. If this task does not need approvals, do it as usual and report it as you normally would. If it does, do not guess or search for those tools again: start your reply with "Not done:", tell the user plainly that approvals were not ready, and do the parts of the task you can without them.]`);
    expect(toolsMayBeLoadingNotice(["memory"])).toContain("tell the user plainly that memory was not ready");
    for (const labels of [["memory"], ["connected apps"], ["approvals"], ["messaging other bots"], ["memory", "approvals"]]) expect(toolsMayBeLoadingNotice(labels)).not.toMatch(/\b(was|were) may\b/);
  });
});

// 1.0.3 gate, Windows (CLI 2.1.307): no first mcp_status answer within 3 s on any new
// process, so every turn went ahead unchecked with the CLI's own start-up hold off.
describe("a fresh engine's first status answer", () => {
  /** An engine that reads its control requests only from `readyAt` on: a request
   * that times out before then gets nothing, one still open then is answered. */
  function slowStart(readyAt: number) {
    let now = 0;
    const asked: number[] = [];
    const slow: string[][] = [];
    return {
      asked, slow, clock: () => now,
      io: {
        now: () => now,
        sleep: async (ms: number) => { await new Promise((resolve) => setImmediate(resolve)); now += ms; },
        stopped: () => false,
        status: async (ms: number) => {
          asked.push(ms);
          // The answer takes real time to come back, as a pipe read does.
          await new Promise((resolve) => setTimeout(resolve, 5));
          if (now + ms < readyAt) { now += ms; return null; }
          now = Math.max(now, readyAt);
          return new Map<string, McpServerState>([["composio", "connected"], ["muragebox", "connected"]]);
        },
        reconnect: async () => {},
        onSlow: (names: string[]) => { slow.push(names); },
      },
    };
  }

  it("Windows gives the first answer the required-server wait; Linux and macOS keep 3 s", () => {
    expect(mcpFirstAnswerMs("win32")).toBe(15_000);
    expect(mcpFirstAnswerMs("linux")).toBe(MCP_STATUS_ANSWER_MS);
    expect(mcpFirstAnswerMs("darwin")).toBe(MCP_STATUS_ANSWER_MS);
  });

  it("an engine that first answers at 5 s is checked, not waved through as unknown, on Windows", async () => {
    const engine = slowStart(5_000);
    const result = await awaitRequiredMcp({ required: ["composio"], optional: ["muragebox"] }, engine.io, { ...budgets, firstAnswerMs: mcpFirstAnswerMs("win32") });
    expect(result).toMatchObject({ unchecked: false, readiness: "ready", missing: [] });
    expect(engine.asked[0]).toBe(15_000);
    // The wait is long enough to notice, so it says what it is waiting for.
    expect(engine.slow).toEqual([["composio", "muragebox"]]);
  });

  it("the default stays one 3 s ask, and a build that never answers still costs only the first-answer window", async () => {
    const quick = slowStart(5_000);
    expect(await awaitRequiredMcp({ required: ["composio"], optional: [] }, quick.io, budgets)).toMatchObject({ unchecked: true, uncheckedReason: "no-answer" });
    expect(quick.asked).toEqual([MCP_STATUS_ANSWER_MS]);
    expect(quick.slow).toEqual([]);
    const silent = slowStart(Number.POSITIVE_INFINITY);
    const result = await awaitRequiredMcp({ required: ["composio"], optional: [] }, silent.io, { ...budgets, firstAnswerMs: 15_000 });
    expect(result).toMatchObject({ unchecked: true, uncheckedReason: "no-answer" });
    expect(silent.asked).toEqual([15_000]);
  });
});
