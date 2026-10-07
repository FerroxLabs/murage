import { describe, expect, it, vi } from "vitest";

import {
  CLEANUP_TIMEOUT_MS,
  acceptCleaned,
  buildCleanupPrompt,
  cleanDictation,
  cleanupNames,
  shouldSkipCleanup,
} from "./dictation-cleanup.ts";
import type { VoiceEndpoint } from "./voice-routes.ts";

const endpoint: VoiceEndpoint = {
  via: "flux",
  label: "Flux",
  baseUrl: "https://flux.example/v1",
  key: "sk-flux-test",
  model: "claude-haiku-4-5",
};

const reply = (content: string | null, status = 200) =>
  new Response(JSON.stringify(status === 200 ? { choices: [{ message: { content } }] } : { error: { message: "boom" } }), {
    status,
    headers: { "content-type": "application/json" },
  });

const RAW = "um so I think we should uh send the report to Dana on Friday you know";
const CLEAN = "I think we should send the report to Dana on Friday.";

describe("the clean-up prompt", () => {
  const prompt = buildCleanupPrompt({ target: "Ada", names: ["Ada", "Murage"] });

  it("carries Flow's rules", () => {
    expect(prompt).toContain("Remove filler words (um, uh, like, you know, basically, actually, so, well)");
    expect(prompt).toContain("Apply course correction ONLY when the speaker explicitly restates");
    expect(prompt).toContain("Format numbers properly");
    expect(prompt).toContain("LISTS:");
    expect(prompt).toContain("PARAGRAPHS:");
    expect(prompt).toContain("SELF-CORRECTIONS:");
    expect(prompt).toContain("scratch that");
    expect(prompt).toContain("Preserve the speaker's intent exactly");
    expect(prompt).toContain("If the input is very short (1-3 words), return it as-is");
    expect(prompt).toContain("Send to John, scratch that, send to Sarah");
  });

  it("credits Flow only in code, never in the prompt, and names the target", () => {
    expect(prompt).toContain("chat message to an AI teammate named Ada");
    expect(prompt).not.toMatch(/Flow/);
  });

  it("lists the names to spell exactly", () => {
    expect(prompt).toContain("Ada");
    expect(prompt).toContain("Murage");
  });
});

describe("the personal dictionary", () => {
  it("always has Murage, Flux and Fuigo, then every bot and room, then the glossary, once each", () => {
    const names = cleanupNames({ bots: ["Ada", "Zed"], rooms: ["Launch Room", "Ada"], glossary: ["Wayland", "murage"] });
    expect(names.slice(0, 3)).toEqual(["Murage", "Flux", "Fuigo"]);
    expect(names).toEqual(expect.arrayContaining(["Ada", "Zed", "Launch Room", "Wayland"]));
    expect(names.filter((n) => n.toLowerCase() === "ada")).toHaveLength(1);
    expect(names.filter((n) => n.toLowerCase() === "murage")).toHaveLength(1);
  });

  it("appears in the request the model gets", async () => {
    const fetchImpl = vi.fn(async () => reply(CLEAN));
    await cleanDictation(RAW, { endpoint, target: "Ada", names: ["Ada", "Launch Room", "Fuigo"], fetchImpl: fetchImpl as never });
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    const system = body.messages[0].content as string;
    expect(system).toContain("Ada");
    expect(system).toContain("Launch Room");
    expect(system).toContain("Fuigo");
    expect(body.messages[1]).toEqual({ role: "user", content: RAW });
    expect(body.model).toBe("claude-haiku-4-5");
  });
});

describe("cleanDictation", () => {
  it("returns the cleaned text on success", async () => {
    const fetchImpl = vi.fn(async () => reply(CLEAN));
    expect(await cleanDictation(RAW, { endpoint, names: [], fetchImpl: fetchImpl as never })).toEqual({ text: CLEAN, cleaned: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toBe("https://flux.example/v1/chat/completions");
    expect(init.headers.authorization).toBe("Bearer sk-flux-test");
  });

  it("falls back to the raw transcript on a 500", async () => {
    const fetchImpl = vi.fn(async () => reply(null, 500));
    expect(await cleanDictation(RAW, { endpoint, names: [], fetchImpl: fetchImpl as never })).toEqual({ text: RAW, cleaned: false });
  });

  it("falls back when the request throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await cleanDictation(RAW, { endpoint, names: [], fetchImpl: fetchImpl as never })).toEqual({ text: RAW, cleaned: false });
  });

  it("falls back on a timeout, and the timeout is 4 seconds", async () => {
    expect(CLEANUP_TIMEOUT_MS).toBe(4000);
    const fetchImpl = vi.fn((_url: string, init: { signal: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))),
    );
    const started = Date.now();
    const result = await cleanDictation(RAW, { endpoint, names: [], fetchImpl: fetchImpl as never, timeoutMs: 30 });
    expect(result).toEqual({ text: RAW, cleaned: false });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("falls back on empty output", async () => {
    for (const content of ["", "   \n", null]) {
      const fetchImpl = vi.fn(async () => reply(content));
      expect(await cleanDictation(RAW, { endpoint, names: [], fetchImpl: fetchImpl as never })).toEqual({ text: RAW, cleaned: false });
    }
  });

  it("falls back when no endpoint can serve it", async () => {
    expect(await cleanDictation(RAW, { endpoint: null, names: [] })).toEqual({ text: RAW, cleaned: false });
  });

  it("skips inputs of 3 words or fewer without calling the model", async () => {
    const fetchImpl = vi.fn(async () => reply("Hello."));
    for (const short of ["hello", "send it now", "  yes please  ", ""]) {
      expect(await cleanDictation(short, { endpoint, names: [], fetchImpl: fetchImpl as never })).toEqual({ text: short, cleaned: false });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(shouldSkipCleanup("one two three")).toBe(true);
    expect(shouldSkipCleanup("one two three four")).toBe(false);
  });

  it("falls back when the output is more than 1.3x the input", async () => {
    const fetchImpl = vi.fn(async () => reply(`${CLEAN} ${CLEAN} ${CLEAN}`));
    expect(await cleanDictation(RAW, { endpoint, names: [], fetchImpl: fetchImpl as never })).toEqual({ text: RAW, cleaned: false });
  });

  it("falls back when a long input shrinks below 0.3x", async () => {
    const long = "um ".repeat(5) + "we need to move the launch review to next Thursday because the legal team is out and the numbers are not final yet and Dana wants to see them first";
    const fetchImpl = vi.fn(async () => reply("Move it."));
    expect(await cleanDictation(long, { endpoint, names: [], fetchImpl: fetchImpl as never })).toEqual({ text: long, cleaned: false });
  });
});

describe("acceptCleaned", () => {
  it("lets short inputs shrink (the 0.3x floor is for inputs over 12 words)", () => {
    expect(acceptCleaned("uh yes please do that now", "Yes.", [])).toBe("Yes.");
  });

  it("rejects output that adds content not in the input", () => {
    const raw = "tell Dana the report is ready for review today";
    const invented = "Tell Dana the report is ready for review today, and also schedule a budget meeting with finance tomorrow.";
    expect(acceptCleaned(raw, invented, [])).toBeNull();
  });

  it("keeps numbers formatted, and names spelled from the dictionary", () => {
    expect(acceptCleaned("send twenty three dollars to Ada please", "Send $23 to Ada please.", ["Ada"])).toBe("Send $23 to Ada please.");
    expect(acceptCleaned("ask ada about the murrage release notes today", "Ask Ada about the Murage release notes today.", ["Ada", "Murage"])).toBe(
      "Ask Ada about the Murage release notes today.",
    );
  });

  it("trims the model's whitespace", () => {
    expect(acceptCleaned(RAW, `\n${CLEAN}\n`, [])).toBe(CLEAN);
  });
});

describe("the meaning guard", () => {
  it("uses the raw text when a negation is added", () => {
    expect(acceptCleaned("please send the report to Dana today", "Please do not send the report to Dana today.", [])).toBeNull();
    expect(acceptCleaned("we can ship this on Friday for sure", "We can't ship this on Friday for sure.", [])).toBeNull();
    expect(acceptCleaned("we can ship this on Friday for sure", "We can ship this without delay on Friday for sure.", [])).toBeNull();
    expect(acceptCleaned("we can ship this on Friday for sure", "We can ship this on Friday, never mind.", [])).toBeNull();
  });

  it("keeps a negation the speaker said", () => {
    expect(acceptCleaned("um please do not send the report today", "Please do not send the report today.", [])).toBe(
      "Please do not send the report today.",
    );
    expect(acceptCleaned("it isn't ready yet so wait", "It isn’t ready yet, so wait.", [])).toBe("It isn’t ready yet, so wait.");
  });

  it("matches whole words or stems, not prefixes", () => {
    // "send" must not admit "sensitive"
    expect(acceptCleaned("please send the files to Dana today", "Please send the sensitive files to Dana today.", [])).toBeNull();
    // inflections of a heard word are fine
    expect(acceptCleaned("she was sending the files to Dana today", "She was sending the files to Dana today.", [])).not.toBeNull();
    expect(acceptCleaned("they send reports to Dana every day", "They sent reports to Dana every day.", [])).not.toBeNull();
  });
});
