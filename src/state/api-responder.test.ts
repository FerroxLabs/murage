// api() believes only this launch's engine (src/lib/live-events.ts responderIsOurs).
//
// 2026-11-18: the engine restarted on 18799 while an unrelated local program
// held 8799, and the window kept calling 8799. Every chat showed the other
// program's 404 as a red "no such route" and "Loading messages..." for ever.
// A desktop page now knows the launch id its engine stamps on every answer
// (x-murage-launch); any other responder reads as "Murage is reconnecting",
// a read asks again, and nothing the other program says is shown or applied.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./store.tsx";

const OURS = "launch-ours";
const originalFetch = globalThis.fetch;

type Answer = { status: number; body: string; launch?: string };
const json = (status: number, value: unknown, launch?: string): Answer => ({ status, body: JSON.stringify(value), launch });

/** Answers in turn (the last repeats); the desktop-secret probe is answered as a phone's. */
function responders(...answers: Answer[]) {
  const calls: string[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : String(input);
    if (path.includes("/api/desktop-secret")) return new Response("{}", { status: 404 });
    calls.push(`${init?.method ?? "GET"} ${path}`);
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)]!;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (answer.launch) headers["x-murage-launch"] = answer.launch;
    return new Response(answer.body, { status: answer.status, headers });
  }) as typeof fetch;
  return calls;
}

type Outcome = { value?: unknown; error?: Error & { status?: number; reconnecting?: boolean } };
const settled = async (work: Promise<unknown>): Promise<Outcome> => {
  const outcome = work.then((value): Outcome => ({ value }), (error: unknown): Outcome => ({ error: error as Outcome["error"] }));
  await vi.runAllTimersAsync();
  return outcome;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  (globalThis as { muragebox?: unknown }).muragebox = { serverLaunch: OURS };
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
  delete (globalThis as { muragebox?: unknown }).muragebox;
  vi.restoreAllMocks();
});

describe("api() and a responder that is not this launch's engine", () => {
  it("WITNESS: another program's 404 'no such route' reads as reconnecting, never as its own words", async () => {
    const calls = responders(json(404, { error: "no such route" }));
    const { error } = await settled(api("/api/threads/t-1/messages"));
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).not.toMatch(/no such route/);
    expect(error!.message).toMatch(/^Murage is reconnecting/);
    expect(error!.status).toBe(503);
    expect(error!.reconnecting).toBe(true);
    expect(calls.length).toBe(8); // asked again, a second apart, before saying so
  });

  it("a read asks again and gets the engine's answer once the window reaches it", async () => {
    const calls = responders(json(404, { error: "no such route" }), json(404, { error: "no such route" }), json(200, { messages: ["m"] }, OURS));
    const { value } = await settled(api("/api/threads/t-1/messages"));
    expect(value).toMatchObject({ messages: ["m"] });
    expect(calls.length).toBe(3);
  });

  it("a 200 page from another program is never applied as an empty answer", async () => {
    responders({ status: 200, body: "<html>Directory listing</html>" });
    const { value, error } = await settled(api("/api/bots"));
    expect(value).toBeUndefined();
    expect(error?.message).toMatch(/^Murage is reconnecting/);
  });

  it("an engine launch this page holds no proof for is not ours either", async () => {
    responders(json(404, { error: "no such route" }, "launch-newer"));
    const { error } = await settled(api("/api/bots"));
    expect(error!.message).toMatch(/^Murage is reconnecting/);
  });

  it("a write is not repeated: it may have reached an engine that did not answer as ours", async () => {
    const calls = responders(json(404, { error: "no such route" }));
    const { error } = await settled(api("/api/threads/t-1/messages", { method: "POST", body: "{}" }));
    expect(error!.message).toMatch(/^Murage is reconnecting/);
    expect(calls).toEqual(["POST /api/threads/t-1/messages"]);
  });

  it("this launch's own answers pass, refusals included, exactly as before", async () => {
    responders(json(404, { error: "no such route" }, OURS));
    const { error } = await settled(api("/api/bots"));
    expect(error!.message).toBe("no such route");
    expect(error!.status).toBe(404);
  });

  it("a page with no launch id (a phone, a browser, dev) checks nothing", async () => {
    delete (globalThis as { muragebox?: unknown }).muragebox;
    responders(json(200, { ok: true }));
    const { value } = await settled(api("/api/bots"));
    expect(value).toMatchObject({ ok: true });
  });
});
