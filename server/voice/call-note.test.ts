import { describe, expect, it } from "vitest";

import { callNoteText, handleCallNoteRoute, type CallNoteDeps } from "./call-note.ts";

describe("call note", () => {
  it("records what was answered, looked up and started, and nothing else", () => {
    const text = callNoteText(
      [
        { said: "What's on the board?", outcome: "answered", detail: "Three meetings today." },
        { said: "Where did the S&P close?", outcome: "looked_up", detail: "7764.64 on September 22." },
        { said: "Book a table at eight", outcome: "handed_down", detail: "Book a table for two at 8pm" },
        { said: "yes", outcome: "decision" },
      ],
      4 * 60_000,
    );
    expect(text).toBe(
      [
        "**Call notes** (4 min)",
        "",
        '- You asked "What\'s on the board?". Answered on the call: "Three meetings today."',
        '- You asked "Where did the S&P close?". Looked it up on the web: "7764.64 on September 22."',
        '- You asked "Book a table at eight". Started as a task: "Book a table for two at 8pm"',
        '- You answered an approval: "yes".',
        "",
        "Anything started on the call continues in this conversation.",
      ].join("\n"),
    );
  });

  it("writes nothing for an empty call", () => {
    expect(callNoteText([], 1_000)).toBeNull();
    expect(callNoteText([{ said: "  ", outcome: "answered" }], 1_000)).toBeNull();
  });

  function fakeRes() {
    let status = 0;
    let body = "";
    const res: any = { writeHead: (s: number) => ((status = s), res), end: (b: string) => ((body = b), res) };
    return { res, status: () => status, body: () => JSON.parse(body) };
  }
  const bot = { id: "b1", threadId: "t1", tasks: [{ threadId: "t1" }, { threadId: "t2" }] };

  it("appends the note to the bot's own task and ignores junk entries", async () => {
    const appended: Array<[string, string]> = [];
    const deps: CallNoteDeps = { bot: (id) => (id === "b1" ? bot : null), append: (t, x) => appended.push([t, x]), readBody: async (r: any) => r.body };
    const r = fakeRes();
    await handleCallNoteRoute("POST", "/api/bots/b1/call-note", { body: { threadId: "t2", durationMs: 60_000, log: [{ said: "hi", outcome: "answered" }, { said: "x", outcome: "evil" }, "junk"] } } as any, r.res, deps);
    expect(r.status()).toBe(200);
    expect(appended).toEqual([["t2", '**Call notes** (1 min)\n\n- You asked "hi". Answered on the call.']]);
  });

  it("refuses another bot's task and an unknown bot", async () => {
    const deps: CallNoteDeps = { bot: (id) => (id === "b1" ? bot : null), append: () => { throw new Error("must not write"); }, readBody: async (r: any) => r.body };
    for (const [url, body, status] of [
      ["/api/bots/b1/call-note", { threadId: "other", log: [{ said: "hi", outcome: "answered" }] }, 409],
      ["/api/bots/nope/call-note", { log: [] }, 404],
    ] as const) {
      const r = fakeRes();
      await handleCallNoteRoute("POST", url, { body } as any, r.res, deps);
      expect(r.status()).toBe(status);
    }
  });
});
