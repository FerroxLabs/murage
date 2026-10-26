// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";

import { packageAgentAsMember, packageAgentPlaybooks, parseBotPackage } from "./bot-package.ts";
import {
  GROK_TIMEOUT_MS, MAX_GROK_PAGE_BYTES, MAX_GROK_REDIRECTS,
  fetchGrokTemplateCard, grokExportToPackage, grokImportFromInput,
} from "./grok-import.ts";
import { GROK_EXPORT_PROMPT, GROK_PASTE_MAX_BYTES, GrokImportError, parseGrokExport } from "../shared/grok-import.ts";

const SHARE_ID = "d8OshqLZvtcKDcNluPuyo";
const SHARE_URL = `https://x.ai/bot/${SHARE_ID}`;
const PAGE = `<!DOCTYPE html><html><head>
<meta property="og:title" content="Inbox Pilot by Avid &amp; Co"/>
<meta property="og:description" content="Sorts your inbox every morning and drafts the replies that matter."/>
</head><body></body></html>`;

const html = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "content-type": "text/html", ...headers } });
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

/** A plain sentence: one line, one full stop, at the end. */
function expectOneSentence(error: unknown) {
  expect(error).toBeInstanceOf(GrokImportError);
  const message = (error as Error).message;
  expect(message).not.toMatch(/\n/);
  expect(message).toMatch(/\.$/);
  expect(message.slice(0, -1)).not.toMatch(/[.!?]\s/);
  expect(message).not.toMatch(/[–—]/);
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a refusal");
}

const EXPORT = {
  format: "murage.grok/1",
  name: "Inbox Pilot",
  description: "Sorts your inbox every morning.",
  instructions: "You are Inbox Pilot. Read new mail, sort it into Today, Later and Never, and draft short replies.",
  skills: [
    { name: "triage-inbox", description: "Sort new mail by urgency", body: "1. Read each new message.\n2. Label it Today, Later or Never." },
    { name: "draft-reply", description: "Write a short reply", body: "Keep replies under five sentences and match the sender's tone." },
  ],
  routines: [
    { name: "Morning sort", schedule: "Weekdays at 8am", cron: "0 8 * * 1-5", prompt: "Sort the inbox and send me a summary." },
    { name: "On new VIP mail", schedule: "When a VIP email arrives", cron: "", prompt: "Tell me right away." },
  ],
  apps: ["Gmail"],
  memories: [],
};
const pasted = (value: unknown) => `Here is my export:\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;

describe("Grok Bot public page: host lock", () => {
  it.each([
    "https://evil.example/bot/" + SHARE_ID,
    "http://x.ai/bot/" + SHARE_ID,
    "https://x.ai.evil.example/bot/" + SHARE_ID,
    "https://user:pw@x.ai/bot/" + SHARE_ID,
    "https://x.ai:8443/bot/" + SHARE_ID,
    "https://x.ai/bot/too-short",
    "https://x.ai/other/" + SHARE_ID,
  ])("refuses %s without any request", async (link) => {
    const fetcher = vi.fn<typeof fetch>();
    expectOneSentence(await caught(fetchGrokTemplateCard(link, fetcher)));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("asks only x.ai, over https, without following redirects itself", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => html(PAGE));
    const card = await fetchGrokTemplateCard(`www.x.ai/bot/${SHARE_ID}/`, fetcher);
    expect(card).toEqual({ shareId: SHARE_ID, name: "Inbox Pilot", creator: "Avid & Co", description: "Sorts your inbox every morning and drafts the replies that matter.", url: SHARE_URL });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(SHARE_URL);
    expect(init?.redirect).toBe("manual");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("stops at a redirect that leaves x.ai", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => redirect("https://evil.example/steal"));
    expectOneSentence(await caught(fetchGrokTemplateCard(SHARE_URL, fetcher)));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("refuses a redirect that lands on another x.ai page, such as the homepage", async () => {
    let calls = 0;
    const fetcher = vi.fn<typeof fetch>(async () => (++calls === 1 ? redirect("https://x.ai/") : html(PAGE)));
    expectOneSentence(await caught(fetchGrokTemplateCard(SHARE_URL, fetcher)));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("stops at a redirect down to http", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => redirect(`http://x.ai/bot/${SHARE_ID}`));
    expectOneSentence(await caught(fetchGrokTemplateCard(SHARE_URL, fetcher)));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("Grok Bot public page: redirect, size and time limits", () => {
  it("follows at most three redirects that stay on x.ai", async () => {
    expect(MAX_GROK_REDIRECTS).toBe(3);
    let calls = 0;
    const ok = vi.fn<typeof fetch>(async () => (++calls <= 3 ? redirect(`https://www.x.ai/bot/${SHARE_ID}?hop=${calls}`) : html(PAGE)));
    await expect(fetchGrokTemplateCard(SHARE_URL, ok)).resolves.toMatchObject({ name: "Inbox Pilot" });
    expect(ok).toHaveBeenCalledTimes(4);

    const loop = vi.fn<typeof fetch>(async () => redirect(`https://x.ai/bot/${SHARE_ID}`));
    expectOneSentence(await caught(fetchGrokTemplateCard(SHARE_URL, loop)));
    expect(loop).toHaveBeenCalledTimes(4);
  });

  it("refuses a page over 2 MiB by its declared length", async () => {
    expect(MAX_GROK_PAGE_BYTES).toBe(2 * 1024 * 1024);
    const fetcher = vi.fn<typeof fetch>(async () => html(PAGE, 200, { "content-length": String(MAX_GROK_PAGE_BYTES + 1) }));
    expectOneSentence(await caught(fetchGrokTemplateCard(SHARE_URL, fetcher)));
  });

  it("stops reading a streamed page once it passes 2 MiB", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(256 * 1024).fill(0x61);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 64) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const fetcher = vi.fn<typeof fetch>(async () => new Response(body, { status: 200 }));
    expectOneSentence(await caught(fetchGrokTemplateCard(SHARE_URL, fetcher)));
    expect(pulled).toBeLessThanOrEqual(10);
  });

  it("gives up after its time limit (20 s by default)", async () => {
    expect(GROK_TIMEOUT_MS).toBe(20_000);
    const fetcher = vi.fn<typeof fetch>((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    }));
    const error = await caught(fetchGrokTemplateCard(SHARE_URL, fetcher, 30));
    expectOneSentence(error);
    expect((error as Error).message).toMatch(/did not answer within/);
  });

  it("says plainly when the bot is not there", async () => {
    expectOneSentence(await caught(fetchGrokTemplateCard(SHARE_URL, async () => html("", 404))));
    expectOneSentence(await caught(fetchGrokTemplateCard(SHARE_URL, async () => html("<html><head></head></html>"))));
  });
});

describe("Grok Bot paste: export text creates a bot", () => {
  it("turns a name, standing instructions and two skills into one bot package", async () => {
    const result = await grokImportFromInput(pasted(EXPORT), vi.fn<typeof fetch>());
    const pkg = parseBotPackage(result.document).package;
    expect(pkg.agents).toHaveLength(1);
    const agent = pkg.agents[0]!;
    const member = packageAgentAsMember(agent);
    expect(member.name).toBe("Inbox Pilot");
    expect(member.description).toBe(EXPORT.instructions);
    const playbooks = packageAgentPlaybooks(pkg, agent);
    expect(playbooks.map((playbook) => playbook.name)).toEqual(["triage-inbox", "draft-reply"]);
    expect(playbooks[0]!.instructions).toContain("Label it Today, Later or Never.");
    expect(playbooks[1]!.triggers).toEqual(["draft reply"]);
    // The timed routine travels paused; the event one is named in a plain note.
    expect(pkg.routines).toEqual([expect.objectContaining({
      name: "Morning sort", agent: agent.key, enabledAfterInstall: false,
      schedule: { type: "daily", time: "08:00", weekdays: [1, 2, 3, 4, 5] },
    })]);
    expect(result.notes.some((note) => note.includes("On new VIP mail"))).toBe(true);
    for (const note of result.notes) expect(note).not.toMatch(/[–—]/);
    expect(pkg.requirements.apps).toEqual([expect.objectContaining({ slug: "gmail", label: "Gmail", optional: true })]);
    // No engine, model or key rides along: the bot runs on whatever engine the person picks.
    expect(JSON.stringify(result.document)).not.toMatch(/"(?:engine|model|instanceId|apiKey)"/);
  });

  it("reads an export pasted without a code fence", () => {
    const x = parseGrokExport(JSON.stringify(EXPORT));
    expect(grokExportToPackage(x).document.package.name).toBe("Inbox Pilot");
  });

  it("cuts standing instructions longer than a bot description and says so", () => {
    const long = `${"Do the work well. ".repeat(400)}`;
    const result = grokExportToPackage(parseGrokExport({ ...EXPORT, instructions: long }));
    expect(result.document.package.agents[0]!.description!.length).toBeLessThanOrEqual(4_000);
    expect(result.notes[0]).toMatch(/standing instructions were longer/);
  });
});

describe("Grok Bot paste: refusals", () => {
  it.each([
    ["plain chat text", "hello, can you help me"],
    ["broken JSON", "```json\n{ \"name\": \"Inbox Pilot\", \n```"],
    ["another product's file", JSON.stringify({ format: "murage.team", version: 1 })],
    ["no instructions", pasted({ format: "murage.grok/1", name: "Empty" })],
  ])("malformed paste (%s) gives one plain sentence", async (_label, text) => {
    expectOneSentence(await caught(grokImportFromInput(text, vi.fn<typeof fetch>())));
  });

  it("refuses a 1 MB paste before reading it", async () => {
    expect(GROK_PASTE_MAX_BYTES).toBeLessThan(1_000_000);
    const fetcher = vi.fn<typeof fetch>();
    const big = pasted({ ...EXPORT, instructions: "x".repeat(1_000_000) });
    const error = await caught(grokImportFromInput(big, fetcher));
    expectOneSentence(error);
    expect((error as GrokImportError).status).toBe(413);
    expect(() => parseGrokExport(big)).toThrow(GrokImportError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses an empty box", async () => {
    expectOneSentence(await caught(grokImportFromInput("   ", vi.fn<typeof fetch>())));
  });
});

describe("Grok Bot link in the same box", () => {
  it("a share link fetches the public card and starts a bot from it", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => html(PAGE));
    const result = await grokImportFromInput(`  ${SHARE_URL}  `, fetcher);
    const pkg = parseBotPackage(result.document).package;
    expect(pkg.name).toBe("Inbox Pilot");
    expect(pkg.author).toEqual({ name: "Avid & Co", url: SHARE_URL });
    expect(pkg.agents[0]!.description).toContain("Sorts your inbox every morning");
    expect(result.notes).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("an x.ai address that is not a share link is refused without a request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    expectOneSentence(await caught(grokImportFromInput("https://x.ai/bot/marketplace/bots/inbox-pilot", fetcher)));
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("copy rules", () => {
  it("the export prompt has no dashes or safety words and names Murage", () => {
    expect(GROK_EXPORT_PROMPT).not.toMatch(/[–—]|\bsafe|\bunsafe|Composio/i);
    expect(GROK_EXPORT_PROMPT).toContain("Murage");
  });
});
