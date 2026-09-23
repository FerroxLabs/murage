import { beforeEach, describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";

import { allowedSentence, CitationFilter, runVoiceBrief, runVoiceHostTurn, SentenceSplitter, voiceHostPrompt, type VoiceHostEvent, type VoiceHostState } from "./voice-host.ts";
import { handleVoiceHostRoute, voiceHostState, type VoiceHostRouteDeps } from "./voice-host-route.ts";
import type { Message } from "../store.ts";
import { resetUnavailable, type VoiceEndpoint } from "./voice-routes.ts";

beforeEach(() => resetUnavailable());

const NOW = Date.parse("2026-09-23T09:00:00Z");
const HOST: VoiceEndpoint = { via: "flux", label: "Flux Router", baseUrl: "http://stub.invalid/v1", key: "test-key", model: "claude-haiku-4-5" };
const LOOKUP: VoiceEndpoint = { ...HOST, model: "flux-voice-lookup" };

const STATE: VoiceHostState = {
  botName: "Sable",
  persona: "Dry, brief, loyal.",
  description: "Chief of staff",
  now: NOW,
  task: { title: "Board prep", busy: false, activity: [] },
  recent: [{ who: "bot", text: "The board summary is ready: revenue up 4 percent.", at: NOW - 10 * 60_000 }],
  otherTasks: [],
  needsYou: [],
};

/** A fetch that answers with the given SSE frames, one chunk each. */
function sse(frames: unknown[], init: { status?: number; seen?: (body: any) => void } = {}): typeof fetch {
  return (async (_url: string, request: RequestInit) => {
    init.seen?.(JSON.parse(String(request.body)));
    if (init.status && init.status !== 200) return new Response(JSON.stringify({ error: { message: "no" } }), { status: init.status });
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
}

const text = (content: string) => ({ choices: [{ delta: { content } }] });
const tool = (index: number, name: string | undefined, args: string) => ({
  choices: [{ delta: { tool_calls: [{ index, function: { ...(name ? { name } : {}), arguments: args } }] } }],
});

async function collect(generator: AsyncGenerator<VoiceHostEvent>): Promise<VoiceHostEvent[]> {
  const events: VoiceHostEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

describe("voice host", () => {
  it("streams text as it arrives and ends with done", async () => {
    let body: any;
    const events = await collect(
      runVoiceHostTurn({
        state: STATE,
        history: [],
        said: "How did the board summary look?",
        host: HOST, lookup: LOOKUP,
        fetchImpl: sse([text("Revenue is up "), text("four percent.")], { seen: (b) => (body = b) }),
      }),
    );
    expect(events).toEqual([{ type: "sentence", text: "Revenue is up four percent." }, { type: "done" }]);
    expect(body.stream).toBe(true);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages.at(-1)).toEqual({ role: "user", content: "How did the board summary look?" });
    expect(body.tools.map((t: any) => t.function.name)).toEqual(["hand_down", "quick_lookup", "cancel_task"]);
  });

  it("assembles a hand-down from pieces and hands it down once", async () => {
    const events = await collect(
      runVoiceHostTurn({
        state: STATE,
        history: [],
        said: "Book me a table for two at eight",
        host: HOST, lookup: LOOKUP,
        fetchImpl: sse([
          text("Let me look into that."),
          tool(0, "hand_down", '{"request":"Book a table'),
          tool(0, undefined, ' for two at 8pm tonight"}'),
          tool(1, "hand_down", '{"request":"duplicate"}'),
        ]),
      }),
    );
    expect(events).toEqual([
      { type: "sentence", text: "Let me look into that." },
      { type: "hand_down", request: "Book a table for two at 8pm tonight" },
      { type: "done" },
    ]);
  });

  it("hands down the owner's own words when the arguments are malformed", async () => {
    const events = await collect(
      runVoiceHostTurn({ state: STATE, history: [], said: "check my mail", host: HOST, lookup: LOOKUP, fetchImpl: sse([tool(0, "hand_down", "{not json")]) }),
    );
    expect(events).toContainEqual({ type: "hand_down", request: "check my mail" });
  });

  it("turns cancel_task into a cancel event", async () => {
    const events = await collect(
      runVoiceHostTurn({ state: STATE, history: [], said: "stop that", host: HOST, lookup: LOOKUP, fetchImpl: sse([tool(0, "cancel_task", "{}")]) }),
    );
    expect(events).toEqual([{ type: "cancel" }, { type: "done" }]);
  });

  it("reports a missing key, a paid plan and a dark route as errors, never throws", async () => {
    expect(await collect(runVoiceHostTurn({ state: STATE, history: [], said: "hi", host: null, fetchImpl: sse([]) }))).toEqual([
      expect.objectContaining({ type: "error", reason: "key" }),
    ]);
    for (const [status, reason] of [[402, "premium"], [404, "unavailable"], [401, "auth"], [429, "rate_limit"], [500, "upstream"]] as const) {
      const events = await collect(runVoiceHostTurn({ state: STATE, history: [], said: "hi", host: HOST, lookup: LOOKUP, fetchImpl: sse([], { status }) }));
      expect(events).toEqual([expect.objectContaining({ type: "error", reason })]);
    }
    const unreachable = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await collect(runVoiceHostTurn({ state: STATE, history: [], said: "hi", host: HOST, lookup: LOOKUP, fetchImpl: unreachable }))).toEqual([
      expect.objectContaining({ type: "error", reason: "upstream" }),
    ]);
  });

  it("answers a lookup through Flux, speaking the result sentence by sentence without markdown", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push(url);
      if (url.endsWith("/chat/completions")) return sse([text("Let me check. "), tool(0, "quick_lookup", '{"query":"Opus 5.5 vs GPT-6 Sol benchmarks"}')])(url, init);
      const body = JSON.parse(String(init.body));
      expect(body).toMatchObject({ query: "Opus 5.5 vs GPT-6 Sol benchmarks", model: "flux-voice-lookup" });
      return sse([text("**Opus 5.5** leads on the index, 58 to 48. "), text("That is from [Artificial Analysis](https://x.test).")])(url, init);
    }) as typeof fetch;
    const events = await collect(runVoiceHostTurn({ state: STATE, history: [], said: "benchmarks?", host: HOST, lookup: LOOKUP, fetchImpl }));
    expect(events).toEqual([
      { type: "sentence", text: "Let me check." },
      { type: "lookup", query: "Opus 5.5 vs GPT-6 Sol benchmarks" },
      { type: "sentence", text: "Opus 5.5 leads on the index, 58 to 48." },
      { type: "sentence", text: "That is from Artificial Analysis." },
      { type: "done" },
    ]);
    expect(seen).toEqual(["http://stub.invalid/v1/chat/completions", "http://stub.invalid/v1/voice/lookup"]);
  });

  it("hands a lookup down when the lookup fails before saying anything", async () => {
    for (const lookup of [
      async () => new Response("dark", { status: 404 }),
      async () => new Response(`data: ${JSON.stringify({ object: "flux.voice.lookup.error", error: { message: "x" } })}\n\n`, { status: 200 }),
    ]) {
      resetUnavailable();
      const fetchImpl = (async (url: string, init: RequestInit) =>
        url.endsWith("/chat/completions") ? sse([tool(0, "quick_lookup", '{"query":"S&P close"}')])(url, init) : lookup()) as typeof fetch;
      const events = await collect(runVoiceHostTurn({ state: STATE, history: [], said: "how did the market close", host: HOST, lookup: LOOKUP, fetchImpl }));
      expect(events).toEqual([{ type: "lookup", query: "S&P close" }, { type: "hand_down", request: "S&P close" }, { type: "done" }]);
    }
  });

  it("looks up with the owner's own xAI key through xAI's web search", async () => {
    const seen: string[] = [];
    const xai = (events: unknown[]) =>
      new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { status: 200 });
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push(url);
      if (url.endsWith("/chat/completions")) return sse([tool(0, "quick_lookup", '{"query":"S&P close"}')])(url, init);
      expect(JSON.parse(String(init.body)).tools).toEqual([{ type: "web_search" }]);
      return xai([{ type: "response.output_text.delta", delta: "It closed at 7764.64 on September 22." }, { type: "response.completed" }]);
    }) as typeof fetch;
    const lookup: VoiceEndpoint = { via: "xai", label: "xAI", baseUrl: "http://xai.invalid/v1", key: "own", model: "grok-4-fast-non-reasoning" };
    const events = await collect(runVoiceHostTurn({ state: STATE, history: [], said: "market?", host: HOST, lookup, fetchImpl }));
    expect(events).toContainEqual({ type: "sentence", text: "It closed at 7764.64 on September 22." });
    expect(seen.at(-1)).toBe("http://xai.invalid/v1/responses");
  });

  it("when Flux lookups are not switched on, the owner's own xAI key answers, and Flux is skipped next time", async () => {
    const seen: string[] = [];
    const xaiLookup: VoiceEndpoint = { via: "xai", label: "xAI", baseUrl: "http://xai.invalid/v1", key: "own", model: "grok-4-1-fast-non-reasoning" };
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push(url);
      if (url.endsWith("/chat/completions")) return sse([tool(0, "quick_lookup", '{"query":"AI news today"}')])(url, init);
      if (url.endsWith("/voice/lookup")) return new Response("{}", { status: 404 });
      return new Response(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Google shipped a Gemini app for Windows." })}\n\n`, { status: 200 });
    }) as typeof fetch;
    const turn = () => collect(runVoiceHostTurn({ state: STATE, history: [], said: "news?", host: HOST, lookup: [LOOKUP, xaiLookup], fetchImpl }));
    expect(await turn()).toContainEqual({ type: "sentence", text: "Google shipped a Gemini app for Windows." });
    expect(seen.filter((u) => !u.endsWith("/chat/completions"))).toEqual([`${LOOKUP.baseUrl}/voice/lookup`, "http://xai.invalid/v1/responses"]);
    seen.length = 0;
    await turn();
    expect(seen.filter((u) => !u.endsWith("/chat/completions"))).toEqual(["http://xai.invalid/v1/responses"]);
  });

  it("with Flux the only lookup source and not switched on, the question is handed down", async () => {
    const fetchImpl = (async (url: string, init: RequestInit) =>
      url.endsWith("/chat/completions") ? sse([tool(0, "quick_lookup", '{"query":"AI news today"}')])(url, init) : new Response("{}", { status: 404 })) as typeof fetch;
    const events = await collect(runVoiceHostTurn({ state: STATE, history: [], said: "news?", host: HOST, lookup: [LOOKUP], fetchImpl }));
    expect(events).toContainEqual({ type: "hand_down", request: "AI news today" });
  });

  it("stops running work when asked and the reply says so, even without the cancel tool", async () => {
    const busy = { ...STATE, task: { ...STATE.task, busy: true } };
    const said = (state: VoiceHostState, words: string) =>
      collect(runVoiceHostTurn({ state, history: [], said: words, host: HOST, lookup: LOOKUP, fetchImpl: sse([text("Stopping that now.")]) }));
    expect(await said(busy, "Actually, stop that, never mind.")).toContainEqual({ type: "cancel" });
    // nothing running, or not asked to stop: nothing is cancelled
    expect(await said(STATE, "Actually, stop that, never mind.")).not.toContainEqual({ type: "cancel" });
    expect(await said(busy, "How's it going?")).not.toContainEqual({ type: "cancel" });
    // the tool was called: one cancel, not two
    const both = await collect(
      runVoiceHostTurn({ state: busy, history: [], said: "stop that", host: HOST, lookup: LOOKUP, fetchImpl: sse([text("Stopping that."), tool(0, "cancel_task", "{}")]) }),
    );
    expect(both.filter((e) => e.type === "cancel")).toHaveLength(1);
  });

  it("speaks whole sentences and drops the ones that promise time or progress", async () => {
    const events = await collect(
      runVoiceHostTurn({
        state: STATE,
        history: [],
        said: "how's it going",
        host: HOST, lookup: LOOKUP,
        fetchImpl: sse([text("Still reading the pack. Should have it "), text("in a minute or two. Revenue was $1,240.50 last "), text("week")]),
      }),
    );
    expect(events).toEqual([
      { type: "sentence", text: "Still reading the pack." },
      { type: "sentence", text: "Revenue was $1,240.50 last week" },
      { type: "done" },
    ]);
  });

  it("drops citation markers, even split across chunks, and keeps ordinary brackets", () => {
    const f = new CitationFilter();
    const pieces = ["Opus leads, 58 to 48.[", "[1]](https://artificialanalysis.ai/a", "?b=1) GPT-6 Sol is cheaper [2] and", " faster [see note]."];
    expect(pieces.map((p) => f.push(p)).join("") + f.flush()).toBe("Opus leads, 58 to 48. GPT-6 Sol is cheaper  and faster [see note].");
    const g = new CitationFilter();
    expect(g.push("Closed at 7764.64.[[3]](") + g.flush()).toBe("Closed at 7764.64.");
  });

  it("splits sentences only at real boundaries", () => {
    const splitter = new SentenceSplitter();
    expect(splitter.push("It costs 1,240.50 dollars. Next")).toEqual(["It costs 1,240.50 dollars."]);
    expect(splitter.push(" one? Yes! ")).toEqual(["Next one?", "Yes!"]);
    expect(splitter.flush()).toEqual([]);
    for (const promise of ["Almost done.", "Back in a few minutes.", "Should have it shortly.", "Give me a couple of seconds."]) {
      expect(allowedSentence(promise)).toBe(false);
    }
    for (const fine of ["Let me look into that.", "Your first meeting is at ten.", "It took a minute to load last time"]) {
      expect(allowedSentence(fine)).toBe(true);
    }
  });

  it("builds its brief from the bot's own profile and says how fresh the snapshot is", () => {
    const prompt = voiceHostPrompt({ ...STATE, task: { title: "Board prep", busy: true, activity: ["reading the sheet"] }, approval: "Send the summary to the board" });
    expect(prompt).toContain("You are Sable");
    expect(prompt).toContain("Dry, brief, loyal.");
    expect(prompt).toContain("busy on it right now");
    expect(prompt).toContain("Steps so far, newest last (the only progress you may mention): reading the sheet.");
    expect(prompt).toContain("Send the summary to the board");
    expect(prompt).toContain("[10 min ago] You: The board summary is ready");
  });
});

function message(partial: Partial<Message> & Pick<Message, "role" | "kind">): Message {
  return { id: Math.random().toString(36).slice(2), at: NOW, ...partial } as Message;
}

describe("voice host route", () => {
  const bot = {
    id: "b1",
    name: "Sable",
    threadId: "t1",
    busy: true,
    tasks: [
      { threadId: "t1", title: "Board prep", createdAt: NOW - 86_400_000 },
      { threadId: "t2", title: "Travel", createdAt: NOW - 3 * 86_400_000 },
    ],
  };
  const path: Message[] = [
    message({ role: "user", kind: "text", text: "Summarise the board pack", at: NOW - 120_000 }),
    message({ role: "bot", kind: "activity", tool: { name: "Read", spoken: "reading the board pack" } }),
    message({ role: "bot", kind: "activity", tool: { name: "Bash", summary: "counting rows" } }),
  ];
  const deps: VoiceHostRouteDeps = {
    bot: (id) => (id === "b1" ? bot : null),
    activePath: () => path,
    lastActivityAt: () => NOW - 3_600_000,
    needsYou: () => [{ title: "Approve travel", summary: "Flight to Bangkok", at: NOW - 60_000 }],
    readBody: async (req: any) => req.body,
    now: () => NOW,
    endpoints: () => ({ host: HOST, lookup: [LOOKUP] }),
  };

  it("shows a failed turn to the host as a failure, so it is not treated as running", () => {
    const failedPath: Message[] = [
      message({ role: "user", kind: "text", text: "AI news from the last 72 hours", at: NOW - 60_000 }),
      message({ role: "bot", kind: "activity", at: NOW - 59_000, tool: { name: "error: Grok CLI is not signed in", ok: false, errorDetails: "Grok CLI is not signed in" } as any }),
    ];
    const state = voiceHostState({ ...bot, busy: false }, "t1", { ...deps, activePath: () => failedPath }, NOW);
    expect(state.recent.at(-1)).toMatchObject({ who: "bot", text: "(That attempt failed and nothing is running: Grok CLI is not signed in)" });
  });

  it("snapshots the running turn's steps, the other tasks and the inbox", () => {
    const state = voiceHostState(bot, "t1", deps, NOW);
    expect(state.task).toEqual({ title: "Board prep", busy: true, activity: ["reading the board pack", "counting rows"] });
    expect(state.recent).toEqual([{ who: "owner", text: "Summarise the board pack", at: NOW - 120_000 }]);
    expect(state.otherTasks).toEqual([{ title: "Travel", at: NOW - 3_600_000 }]);
    expect(state.needsYou).toHaveLength(1);
  });

  function fakeRes() {
    const res = new PassThrough() as any;
    let head: { status: number; headers: Record<string, string> } | null = null;
    let out = "";
    res.writeHead = (status: number, headers: Record<string, string>) => {
      head = { status, headers };
      return res;
    };
    res.write = (chunk: string) => {
      out += chunk;
      return true;
    };
    res.end = (chunk?: string) => {
      if (chunk) out += chunk;
      return res;
    };
    return { res, head: () => head, out: () => out };
  }

  it("streams the host's events as server-sent events", async () => {
    const r = fakeRes();
    const handled = await handleVoiceHostRoute("POST", "/api/bots/b1/voice-host", { body: { text: "how's it going" } } as any, r.res, {
      ...deps,
      run: async function* () {
        yield { type: "sentence", text: "Still reading." };
        yield { type: "done" };
      },
    });
    expect(handled).toBe(true);
    expect(r.head()?.headers["content-type"]).toBe("text/event-stream");
    expect(r.out()).toBe('data: {"type":"sentence","text":"Still reading."}\n\ndata: {"type":"done"}\n\n');
  });

  it("refuses an empty turn, an unknown bot and another bot's task", async () => {
    for (const [body, url, status] of [
      [{ text: " " }, "/api/bots/b1/voice-host", 400],
      [{ text: "hi" }, "/api/bots/nope/voice-host", 404],
      [{ text: "hi", threadId: "someone-else" }, "/api/bots/b1/voice-host", 409],
    ] as const) {
      const r = fakeRes();
      await handleVoiceHostRoute("POST", url, { body } as any, r.res, deps);
      expect(r.head()?.status).toBe(status);
    }
  });

  it("tells a long finished answer as a brief, which may run past a spoken turn's length", async () => {
    const answer = "## Today's AI news\n\n" + "- A launch story. ".repeat(200);
    const r = fakeRes();
    let told: any = null;
    await handleVoiceHostRoute("POST", "/api/bots/b1/voice-host", { body: { text: answer, brief: true } } as any, r.res, {
      ...deps,
      run: async function* () {
        throw new Error("a brief is not a host turn");
      },
      brief: async function* (options) {
        told = options;
        yield { type: "sentence", text: "Three big stories." };
        yield { type: "done" };
      },
    });
    expect(told.answer).toBe(answer.trim());
    expect(told.host).toBe(HOST);
    expect(r.out()).toContain("Three big stories.");
  });

  it("ignores every other path", async () => {
    const r = fakeRes();
    expect(await handleVoiceHostRoute("POST", "/api/bots/b1/messages", {} as any, r.res, deps)).toBe(false);
    expect(await handleVoiceHostRoute("GET", "/api/bots/b1/voice-host", {} as any, r.res, deps)).toBe(false);
  });
});

describe("voice brief", () => {
  it("asks for the gist in a few spoken sentences with no tools, and streams them", async () => {
    let sent: any;
    const events = await collect(
      runVoiceBrief({
        state: STATE,
        answer: "## News\n\n- US and China discuss an AI incident line.\n- Google ships Gemini for Windows.",
        host: HOST,
        fetchImpl: sse([text("Two big stories. "), text("The full version is in the chat.")], { seen: (body) => (sent = body) }),
      }),
    );
    expect(events).toEqual([
      { type: "sentence", text: "Two big stories." },
      { type: "sentence", text: "The full version is in the chat." },
      { type: "done" },
    ]);
    expect(sent.tools).toBeUndefined();
    expect(sent.messages[0].content).toContain("Cover every item it reports");
    expect(sent.messages[1].content).toContain("Gemini for Windows");
  });

  it("reports a failure as an event, so the caller reads the answer out", async () => {
    expect((await collect(runVoiceBrief({ state: STATE, answer: "x", host: HOST, fetchImpl: sse([], { status: 500 }) })))[0]).toMatchObject({ type: "error" });
    expect((await collect(runVoiceBrief({ state: STATE, answer: "x", host: null })))[0]).toMatchObject({ type: "error", reason: "key" });
  });
});

describe("voice host warm-up", () => {
  it("wakes the model with one token and never waits on it", async () => {
    let calls = 0;
    const r = { head: null as any, res: null as any };
    const res: any = { writeHead: (s: number) => ((r.head = s), res), end: () => res, on: () => res };
    await handleVoiceHostRoute("POST", "/api/bots/b1/voice-host", { body: { warm: true } } as any, res, {
      bot: () => ({ id: "b1", name: "Sable", threadId: "t1" }),
      activePath: () => [],
      lastActivityAt: () => undefined,
      needsYou: () => [],
      readBody: async (req: any) => req.body,
      endpoints: () => ({ host: HOST, lookup: [] }),
      warm: async () => {
        calls += 1;
      },
    });
    expect(r.head).toBe(202);
    expect(calls).toBe(1);
  });
});

describe("voice host on the owner's own keys", () => {
  it("runs on whatever endpoint it is handed, with that provider's model", async () => {
    let seen: any;
    const own: VoiceEndpoint = { via: "anthropic", label: "Anthropic", baseUrl: "http://anthropic.invalid/v1", key: "own-anthropic", model: "claude-haiku-4-5" };
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, auth: (init.headers as Record<string, string>).authorization, model: JSON.parse(String(init.body)).model };
      return sse([text("Hello.")])(url, init);
    }) as typeof fetch;
    await collect(runVoiceHostTurn({ state: STATE, history: [], said: "hi", host: own, lookup: null, fetchImpl }));
    expect(seen).toEqual({ url: "http://anthropic.invalid/v1/chat/completions", auth: "Bearer own-anthropic", model: "claude-haiku-4-5" });
  });

  it("offers no lookup tool when nothing can look things up, so the host hands down instead", async () => {
    let tools: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      tools = JSON.parse(String(init.body)).tools.map((t: any) => t.function.name);
      return sse([text("Let me look into that."), tool(0, "quick_lookup", '{"query":"x"}')])(url, init);
    }) as typeof fetch;
    const events = await collect(runVoiceHostTurn({ state: STATE, history: [], said: "news?", host: HOST, lookup: null, fetchImpl }));
    expect(tools).toEqual(["hand_down", "cancel_task"]);
    expect(events.some((e) => e.type === "lookup")).toBe(false);
  });

  it("looks up through Anthropic's own web search tool", async () => {
    let body: any;
    let headers: Record<string, string> = {};
    const lookup: VoiceEndpoint = { via: "anthropic", label: "Anthropic", baseUrl: "http://anthropic.invalid/v1", key: "own-anthropic", model: "claude-haiku-4-5" };
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (url.endsWith("/chat/completions")) return sse([tool(0, "quick_lookup", '{"query":"S&P close"}')])(url, init);
      body = JSON.parse(String(init.body));
      headers = init.headers as Record<string, string>;
      const frames = [
        { type: "content_block_start", content_block: { type: "server_tool_use" } },
        { type: "content_block_delta", delta: { type: "text_delta", text: "It closed at 7764.64 yesterday." } },
        { type: "message_stop" },
      ];
      return new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""), { status: 200 });
    }) as typeof fetch;
    const events = await collect(runVoiceHostTurn({ state: STATE, history: [], said: "market?", host: HOST, lookup, fetchImpl }));
    expect(events).toContainEqual({ type: "sentence", text: "It closed at 7764.64 yesterday." });
    expect(body.tools).toEqual([{ type: "web_search_20250305", name: "web_search", max_uses: 3 }]);
    expect(headers["x-api-key"]).toBe("own-anthropic");
  });
});
