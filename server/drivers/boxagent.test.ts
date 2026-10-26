// Box agent contract tests against a scripted fake of ascii.dev's box HTTP
// API. The driver polls events + prompt status; the fake advances one poll
// per GET so we can assert message → tool → message order without sleeping.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { BoxAgentDriver } from "./boxagent.ts";
import { IntakeValve, installIntakeValve } from "../harness/intake.ts";
import { _cloudComputerIdle, _cloudComputerTiming, _resetCloudComputerTurns, CLOUD_COMPUTER_TURNS_FILE } from "../cloud-computer-turns.ts";
import { DATA_DIR } from "../config.ts";
import { rmSync } from "node:fs";
import { join } from "node:path";

const BOX = "box-1";
const PROMPT = "p1";

/** JSON Response helper for the in-process Box HTTP fake. */
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type Poll = { events: unknown[]; status?: { promptRun: { status: string; result?: string } } };

/** Stub fetch so each GET /events + /prompts pair advances one poll in `script`. */
function installFakeBox(script: Poll[]) {
  let i = 0;
  let posted = false;
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = String(init?.method ?? "GET").toUpperCase();
    if (url.endsWith("/me")) return json({ ok: true });
    if (method === "POST" && /\/boxes\/[^/]+\/prompt$/.test(url)) { posted = true; return json({ promptRun: { id: PROMPT } }); }
    if (method === "POST" && url.includes("/interrupt")) return json({ ok: true });
    // the box lists nothing before the first prompt (the snapshot a send takes, CLOUD-COMPUTER-BOOT-105 C3)
    if (url.includes("/events") && !posted) return json({ events: [] });
    if (url.includes("/events")) {
      const step = script[Math.min(i, script.length - 1)]!;
      i += 1;
      return json({ events: step.events });
    }
    if (url.includes(`/prompts/${PROMPT}`)) {
      const step = script[Math.min(Math.max(i - 1, 0), script.length - 1)]!;
      return json(step.status ?? { promptRun: { status: "running" } });
    }
    return json({ error: `unexpected ${method} ${url}` }, 404);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = previous;
  };
}

const computer = { boxId: BOX, token: "box-test-token" };

describe("BoxAgentDriver turns (fake API)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let restoreFetch: (() => void) | undefined;

  const create = async () => {
    instance = await BoxAgentDriver.create({
      instanceId: "box-test",
      displayName: "Box Test",
      environment: { BOX_TOKEN: "box-test-token" },
      enabled: true,
      config: { pollMs: 0 },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
    rmSync(join(DATA_DIR, CLOUD_COMPUTER_TURNS_FILE), { force: true });
    _resetCloudComputerTurns();
    _cloudComputerTiming({ pauseMs: 0 });
  });

  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    await _cloudComputerIdle();                                    // a Stop's confirmation reads the fake box, not the real one
    restoreFetch?.();
    restoreFetch = undefined;
  });

  it("two turns report no tokens so the ledger records work time only",async()=>{
    restoreFetch=installFakeBox([{events:[{id:"reply",type:"response",text:"done"}],status:{promptRun:{status:"finished",result:"done"}}}]);
    await create();
    for(let n=0;n<2;n++){const sent=await instance.adapter.sendTurn({threadId:"usage-two",text:"hi",integrations:{computer}});await recorder.until(e=>e.type==="turn.completed"&&e.turnId===sent.turnId);}
    const completed=recorder.events.filter(e=>e.type==="turn.completed");expect(completed).toHaveLength(2);
    for(const event of completed)expect(event).not.toHaveProperty("usage");
  });

  it("r26b: a run that finished with no output shows '(finished)' as Murage's own line, never as the engine's reply", async () => {
    restoreFetch = installFakeBox([{ events: [], status: { promptRun: { status: "finished" } } }]);
    await create();
    const sent = await instance.adapter.sendTurn({ threadId: "t-box-silent", text: "hi", integrations: { computer } });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === sent.turnId);
    const lines = recorder.events.filter((e) => e.type === "item.completed" && e.itemType === "assistant_text");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ text: "(finished)", origin: "murage" });
    expect(recorder.events.some((e) => e.type === "item.completed" && e.itemType === "assistant_text" && e.origin === "engine")).toBe(false);
  });

  it("fences the prompt write: a refused turn posts nothing to the box", async () => {
    restoreFetch = installFakeBox([{ events: [], status: { promptRun: { status: "finished", result: "never" } } }]);
    const fake = globalThis.fetch;
    const posts: string[] = [];
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      if (String(init?.method ?? "GET").toUpperCase() === "POST") posts.push(String(input));
      return fake(input, init);
    }) as typeof fetch;
    await create();
    const refusal = new Error("retired before submit");
    await expect(instance.adapter.sendTurn({
      threadId: "t-box-fenced",
      text: "stale",
      integrations: { computer },
      beforeSubmit: () => { throw refusal; },
    })).rejects.toBe(refusal);
    expect(posts).toEqual([]);
    expect(recorder.events).toEqual([]);
    expect(instance.adapter.hasSession("t-box-fenced")).toBe(false);
  });

  it("flushes prefix-grown text before a tool, then the tail at settle", async () => {
    restoreFetch = installFakeBox([
      {
        events: [{ id: "e1", type: "response", text: "hel" }],
        status: { promptRun: { status: "running" } },
      },
      {
        events: [
          { id: "e1", type: "response", text: "hel" },
          { id: "e2", type: "tool", title: "run" },
        ],
        status: { promptRun: { status: "running" } },
      },
      {
        events: [
          { id: "e1", type: "response", text: "hel" },
          { id: "e2", type: "tool", title: "run" },
          { id: "e3", type: "response", text: "hello there" },
        ],
        status: { promptRun: { status: "finished", result: "hello there" } },
      },
    ]);
    await create();
    await instance.adapter.sendTurn({ threadId: "t-prefix", text: "go", integrations: { computer } });
    await recorder.until((e) => e.type === "turn.completed");

    const texts = recorder.events
      .filter((e) => e.type === "item.completed" && (e as { itemType: string }).itemType === "assistant_text")
      .map((e) => (e as { text: string }).text);
    expect(texts).toEqual(["hel", "lo there"]);
  });

  it("keeps a non-prefix response after a flush instead of slicing it away", async () => {
    restoreFetch = installFakeBox([
      {
        events: [{ id: "e1", type: "response", text: "before" }],
        status: { promptRun: { status: "running" } },
      },
      {
        events: [
          { id: "e1", type: "response", text: "before" },
          { id: "e2", type: "tool", title: "run" },
        ],
        status: { promptRun: { status: "running" } },
      },
      {
        events: [
          { id: "e1", type: "response", text: "before" },
          { id: "e2", type: "tool", title: "run" },
          { id: "e3", type: "response", text: "after" },
        ],
        status: { promptRun: { status: "finished", result: "after" } },
      },
    ]);
    await create();
    await instance.adapter.sendTurn({ threadId: "t-nonprefix", text: "go", integrations: { computer } });
    await recorder.until((e) => e.type === "turn.completed");

    const types = recorder.events.map((e) => e.type);
    expect(types).toEqual([
      "turn.started",
      "session.started",
      "content.delta",
      "item.completed", // before
      "item.started",
      "content.delta",
      "item.completed", // after — must not be sliced to ""
      "turn.completed",
    ]);
    const texts = recorder.events
      .filter((e) => e.type === "item.completed" && (e as { itemType: string }).itemType === "assistant_text")
      .map((e) => (e as { text: string }).text);
    expect(texts).toEqual(["before", "after"]);
  });

  it("ingests a non-prefix prompt result when events already set lastText", async () => {
    restoreFetch = installFakeBox([
      {
        events: [{ id: "e1", type: "response", text: "before" }],
        status: { promptRun: { status: "running" } },
      },
      {
        events: [
          { id: "e1", type: "response", text: "before" },
          { id: "e2", type: "tool", title: "run" },
        ],
        status: { promptRun: { status: "running" } },
      },
      {
        events: [
          { id: "e1", type: "response", text: "before" },
          { id: "e2", type: "tool", title: "run" },
        ],
        status: { promptRun: { status: "finished", result: "done" } },
      },
    ]);
    await create();
    await instance.adapter.sendTurn({ threadId: "t-status", text: "go", integrations: { computer } });
    await recorder.until((e) => e.type === "turn.completed");

    const texts = recorder.events
      .filter((e) => e.type === "item.completed" && (e as { itemType: string }).itemType === "assistant_text")
      .map((e) => (e as { text: string }).text);
    expect(texts).toEqual(["before", "done"]);
  });

  /** Each events poll moves the clock five minutes on. */
  const fiveMinutesPerPoll = () => {
    let clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      if (String(input).includes("/events")) clock += 5 * 60_000;
      return inner(input, init);
    }) as typeof fetch;
    return () => {
      globalThis.fetch = inner;
      vi.restoreAllMocks();
    };
  };

  it("lets a box run that keeps producing events run past 30 minutes and finish", async () => {
    const script: Poll[] = [];
    let text = "";
    for (let i = 1; i <= 9; i++) {
      text += `part ${i} `;
      script.push({ events: [{ id: `e${i}`, type: "response", text }], status: { promptRun: { status: "running" } } });
    }
    script.push({ events: [{ id: "e9", type: "response", text }], status: { promptRun: { status: "finished", result: text } } });
    const restoreBox = installFakeBox(script);
    const restoreClock = fiveMinutesPerPoll();
    restoreFetch = () => { restoreClock(); restoreBox(); };
    await create();
    await instance.adapter.sendTurn({ threadId: "t-long", text: "go", integrations: { computer } });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
    expect(recorder.events.filter((e) => e.type === "runtime.error")).toEqual([]);
  });

  it("never stops a quiet box run on its own clock: the thread's silence watch or the owner's Stop ends it", async () => {
    const restoreBox = installFakeBox([
      { events: [{ id: "e1", type: "response", text: "started" }], status: { promptRun: { status: "running" } } },
    ]);
    let polls = 0;
    const counted = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      if (String(input).includes("/events")) polls += 1;
      return counted(input, init);
    }) as typeof fetch;
    const restoreClock = fiveMinutesPerPoll();
    restoreFetch = () => { restoreClock(); globalThis.fetch = counted; restoreBox(); };
    await create();
    await instance.adapter.sendTurn({ threadId: "t-quiet", text: "go", integrations: { computer } });
    // 36 polls, five simulated minutes each: three hours with nothing new
    await vi.waitFor(() => expect(polls).toBeGreaterThanOrEqual(36), { timeout: 5_000 });
    expect(recorder.events.filter((e) => e.type === "turn.completed" || e.type === "runtime.error")).toEqual([]);
    expect(instance.adapter.hasSession("t-quiet")).toBe(true);
    // the watch (or the owner) stops it through interruptTurn
    await instance.adapter.interruptTurn("t-quiet");
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true, stopReason: "cancelled" });
    expect(recorder.events.filter((e) => e.type === "runtime.error")).toEqual([]);
  });

  it("reports every new box event as activity, so the thread's silence watch sees work the chat does not show", async () => {
    restoreFetch = installFakeBox([
      { events: [{ id: "s1", type: "status", data: { phase: "thinking" } }], status: { promptRun: { status: "running" } } },
      { events: [{ id: "s1", type: "status", data: { phase: "thinking" } }], status: { promptRun: { status: "running" } } },
      // a heartbeat: a fresh id and time, nothing else new
      { events: [{ id: "s2", type: "status", ts: 2, data: { phase: "thinking" } }], status: { promptRun: { status: "running" } } },
      // a heartbeat whose time sits inside its data
      { events: [{ id: "s4", type: "status", data: { phase: "thinking", ts: 5 } }], status: { promptRun: { status: "running" } } },
      { events: [{ id: "s5", type: "status", data: { phase: "thinking", ts: 6 } }], status: { promptRun: { status: "running" } } },
      { events: [{ id: "r1", type: "response", text: "half" }], status: { promptRun: { status: "running" } } },
      // the same text again under a new id
      { events: [{ id: "r2", type: "response", text: "half" }], status: { promptRun: { status: "running" } } },
      { events: [{ id: "s3", type: "progress" }], status: { promptRun: { status: "finished", result: "half" } } },
    ]);
    await create();
    await instance.adapter.sendTurn({ threadId: "t-live", text: "go", integrations: { computer } });
    await recorder.until((e) => e.type === "turn.completed");
    // one per event that says something new; a repeat, a heartbeat or a
    // resent snapshot is not work, so a box stuck sending them still goes
    // quiet for the silence watch
    expect(recorder.events.filter((e) => e.type === "item.updated")).toEqual([
      expect.objectContaining({ itemType: "reasoning", tokens: null }),
      expect.objectContaining({ itemType: "reasoning", tokens: null }),
    ]);
  });

  it("flushes pending assistant text when the turn is interrupted", async () => {
    restoreFetch = installFakeBox([
      {
        events: [{ id: "e1", type: "response", text: "half" }],
        status: { promptRun: { status: "running" } },
      },
    ]);
    await create();
    await instance.adapter.sendTurn({ threadId: "t-cancel", text: "go", integrations: { computer } });
    await recorder.until((e) => e.type === "content.delta");
    await instance.adapter.interruptTurn("t-cancel");
    const done = await recorder.until((e) => e.type === "turn.completed");
    // STOP1: a user Stop settles as cancelled (ok:true), never as a failure
    expect(done).toMatchObject({ ok: true, stopReason: "cancelled" });
    expect(recorder.events.filter((e) => e.type === "runtime.error")).toEqual([]);
    const assistantIndex = recorder.events.findIndex(
      (event) => event.type === "item.completed" && (event as { itemType: string }).itemType === "assistant_text",
    );
    expect(assistantIndex).toBeLessThan(recorder.events.indexOf(done));
    const texts = recorder.events
      .filter((e) => e.type === "item.completed" && (e as { itemType: string }).itemType === "assistant_text")
      .map((e) => (e as { text: string }).text);
    expect(texts).toEqual(["half"]);
  });
  it("waits for room on the event bus before polling and before emitting, and resumes when it opens", async () => {
    let closed = true;
    const valve = new IntakeValve(() => closed);
    installIntakeValve(valve);
    try {
      let polls = 0;
      const restore = installFakeBox([
        { events: [{ id: "e1", type: "response", text: "one" }, { id: "e2", type: "tool_call", title: "t" }, { id: "e3", type: "status", data: { a: 1 } }], status: { promptRun: { status: "running" } } },
        { events: [], status: { promptRun: { status: "finished", result: "one" } } },
      ]);
      const inner = globalThis.fetch;
      globalThis.fetch = (async (input: string | URL, init?: RequestInit) => { if (String(input).includes("/events")) polls++; return inner(input, init); }) as typeof fetch;
      restoreFetch = () => { globalThis.fetch = inner; restore(); };
      await create();
      await instance.adapter.sendTurn({ threadId: "t-valve", text: "go", integrations: { computer } });
      polls = 0;                                                   // the events snapshot a send takes before its prompt is not a poll
      await new Promise((r) => setTimeout(r, 150));
      // the bus is full: the producer neither polled nor emitted anything beyond the turn's own start
      expect(polls).toBe(0);
      expect(recorder.events.filter((e) => e.type === "content.delta" || e.type === "item.started" || e.type === "item.updated")).toEqual([]);
      closed = false; valve.evaluate();
      await recorder.until((e) => e.type === "turn.completed");
      expect(polls).toBeGreaterThan(0);
      expect(recorder.events.some((e) => e.type === "content.delta")).toBe(true);
    } finally { installIntakeValve(null); }
  });
  it("Stop ends the session promptly while the bus has no room, and nothing is polled or emitted after it", async () => {
    const valve = new IntakeValve(() => true);
    installIntakeValve(valve);
    try {
      let polls = 0;
      const restore = installFakeBox([{ events: [{ id: "e1", type: "response", text: "late" }], status: { promptRun: { status: "running" } } }]);
      const inner = globalThis.fetch;
      globalThis.fetch = (async (input: string | URL, init?: RequestInit) => { if (String(input).includes("/events")) polls++; return inner(input, init); }) as typeof fetch;
      restoreFetch = () => { globalThis.fetch = inner; restore(); };
      await create();
      await instance.adapter.sendTurn({ threadId: "t-stop-closed", text: "go", integrations: { computer } });
      polls = 0;                                                   // the events snapshot a send takes before its prompt is not a poll
      await new Promise((r) => setTimeout(r, 100));
      await instance.adapter.interruptTurn("t-stop-closed");
      const done = await recorder.until((e) => e.type === "turn.completed");
      expect(done).toMatchObject({ ok: true, stopReason: "cancelled" });
      expect(polls).toBe(0);
      expect(recorder.events.filter((e) => e.type === "content.delta" || e.type === "item.started" || e.type === "item.updated")).toEqual([]);
    } finally { installIntakeValve(null); }
  });
  it("a Stop that lands after the status call resolves emits no fresh text and settles as the stopped completion", async () => {
    restoreFetch = installFakeBox([{ events: [], status: { promptRun: { status: "finished", result: "fresh after stop" } } }]);
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const res = await inner(input, init);
      if (String(input).includes(`/prompts/${PROMPT}`)) { await instance.adapter.interruptTurn("t-stop-status"); await res.clone().text(); }
      return res;
    }) as typeof fetch;
    const base = restoreFetch; restoreFetch = () => { globalThis.fetch = inner; base(); };
    await create();
    await instance.adapter.sendTurn({ threadId: "t-stop-status", text: "go", integrations: { computer } });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true, stopReason: "cancelled" });
    expect(JSON.stringify(recorder.events)).not.toContain("fresh after stop");
  });
  it("a Stop that lands after the events call resolves emits none of that call's text", async () => {
    restoreFetch = installFakeBox([{ events: [{ id: "e1", type: "response", text: "late events text" }], status: { promptRun: { status: "running" } } }]);
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const res = await inner(input, init);
      if (String(input).includes("/events")) { await instance.adapter.interruptTurn("t-stop-events"); await res.clone().text(); }
      return res;
    }) as typeof fetch;
    const base = restoreFetch; restoreFetch = () => { globalThis.fetch = inner; base(); };
    await create();
    await instance.adapter.sendTurn({ threadId: "t-stop-events", text: "go", integrations: { computer } });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true, stopReason: "cancelled" });
    expect(JSON.stringify(recorder.events)).not.toContain("late events text");
  });
});
