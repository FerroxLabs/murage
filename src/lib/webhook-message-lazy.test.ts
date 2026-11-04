// The webhook bubble's parser loads on first use. These pin the rule that
// matters while it is away: a message that may be a webhook run never shows
// its stored text, whether the parser is still loading or failed to load.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { ComposerReplyStrip, ReplyQuote } from "@/components/ReplyQuote";
import type { Message } from "@/state/store";

import * as parser from "./webhook-message";
import { WEBHOOK_LOADING_TEXT, loadWebhookMessage, looksLikeWebhookMessage, resetWebhookMessageLoaderForTest, useWebhookDisplayText, webhookViewNow } from "./webhook-message-lazy";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");

const ID = "0123456789abcdef";
const TASK_ID = "fedcba9876543210";
const SECRET = "sender-controlled payload 4f1c";
const fencedRun = `<<webhook-task id=${TASK_ID}>>\nSummarize the failed build.\n<<end webhook-task id=${TASK_ID}>>\n\n<<page-content id=${ID} origin=webhook kind=webhook-event>>\nReceived: 2026-11-02T10:00:00.000Z\nEvent: build.failed\n\n${SECRET}\n<<end page-content id=${ID}>>`;
const legacyRun = `[DEFAULT WEBHOOK INSTRUCTIONS]\nSummarize the failed build.\n[/DEFAULT WEBHOOK INSTRUCTIONS]\n\n[UNTRUSTED WEBHOOK EVENT DATA]\nEvent: build.failed\n\n${SECRET}\n[/UNTRUSTED WEBHOOK EVENT DATA]`;

afterEach(() => resetWebhookMessageLoaderForTest());

describe("looksLikeWebhookMessage", () => {
  it("passes every text the parser reads as a webhook run, and no ordinary message", () => {
    const runs = [fencedRun, legacyRun, legacyRun.replaceAll("DEFAULT WEBHOOK INSTRUCTIONS", "USER-CONFIGURED WEBHOOK INSTRUCTIONS"), `[AUTHENTICATED WEBHOOK TASK]\nT\n[/AUTHENTICATED WEBHOOK TASK]\n\n[UNTRUSTED WEBHOOK EVENT DATA]\nE\n\np\n[/UNTRUSTED WEBHOOK EVENT DATA]`];
    for (const run of runs) {
      expect(parser.webhookMessageView(run)).not.toBeNull();
      expect(looksLikeWebhookMessage(run)).toBe(true);
    }
    for (const plain of ["hello", "", "see [UNTRUSTED WEBHOOK", "page-content id=1 origin=web"]) {
      expect(parser.webhookMessageView(plain)).toBeNull();
      expect(looksLikeWebhookMessage(plain)).toBe(false);
    }
  });

  it("keeps the openers the parser itself matches", () => {
    // If the parser's openers change, this cheap test must change with it, or a
    // webhook run would draw as plain text before the parser is checked.
    const source = read("./webhook-message.ts");
    expect(source).toContain('const EVENT_DATA_OPEN = "[UNTRUSTED WEBHOOK EVENT DATA]\\n";');
    expect(source).toContain("origin=webhook kind=webhook-event>>$/gm;");
  });
});

describe("webhookViewNow before, during and after the load", () => {
  it("holds a webhook run while the parser loads, then shows the card", async () => {
    let release!: (module: typeof parser) => void;
    resetWebhookMessageLoaderForTest(() => new Promise((resolve) => { release = resolve; }));
    expect(webhookViewNow(fencedRun)).toEqual({ status: "loading" });
    expect(webhookViewNow("hello")).toEqual({ status: "none" });
    const load = loadWebhookMessage();
    expect(webhookViewNow(fencedRun)).toEqual({ status: "loading" });
    release(parser);
    await load;
    expect(webhookViewNow(fencedRun)).toEqual({ status: "view", view: { task: "Summarize the failed build.", payload: SECRET } });
    expect(webhookViewNow(legacyRun)).toEqual({ status: "view", view: { task: "Summarize the failed build.", payload: SECRET } });
  });

  it("keeps holding a webhook run when the parser fails to load", async () => {
    resetWebhookMessageLoaderForTest(() => Promise.reject(new TypeError("Failed to fetch dynamically imported module")));
    await expect(loadWebhookMessage()).rejects.toThrow(/dynamically imported/);
    expect(webhookViewNow(fencedRun)).toEqual({ status: "failed" });
    expect(webhookViewNow(legacyRun)).toEqual({ status: "failed" });
    expect(webhookViewNow("hello")).toEqual({ status: "none" });
  });

  it("imports the parser once for every bubble", async () => {
    let calls = 0;
    resetWebhookMessageLoaderForTest(() => { calls += 1; return Promise.resolve(parser); });
    await Promise.all([loadWebhookMessage(), loadWebhookMessage(), loadWebhookMessage()]);
    await loadWebhookMessage();
    expect(calls).toBe(1);
  });
});

describe("the chat bubble", () => {
  const chat = read("../components/ChatView.tsx");
  const bubble = chat.slice(chat.indexOf("const webhook = useWebhookMessageView("), chat.indexOf("View event payload"));

  it("does not put the parser on first paint", () => {
    expect(chat).not.toMatch(/from "@\/lib\/webhook-message"/);
    expect(chat).not.toMatch(/import\("@\/lib\/webhook-message"\)/);
    expect(read("./webhook-message-lazy.ts")).toMatch(/^import type \{ WebhookMessageView \} from "\.\/webhook-message";$/m);
    expect(read("./webhook-message-lazy.ts")).not.toMatch(/^import \{[^}]*\} from "\.\/webhook-message";$/m);
  });

  it("shows only the placeholder or the retry while a webhook run is held, never its text", () => {
    expect(bubble).toContain('const webhookHeld = webhook.status === "loading" || webhook.status === "failed";');
    expect(bubble).toContain('const visibleText = webhookHeld ? "" :');
    expect(bubble).toContain("user && !webhookView && !webhookHeld && !telegramView ? splitTranscriptAttachments");
    expect(bubble).toContain("user && !webhookHeld ? telegramMessageDisplay(text) : null");
    expect(bubble).toContain("{user && !webhookHeld && <CopyButton text={visibleText} />}");
    expect(bubble).toMatch(/\.\.\.\(webhookHeld\s*\? \[\]\s*: \[\{ id: "copy"/);
    expect(bubble).toContain("if (user && editing && !webhookView && !webhookHeld) {");
    // The held branch is drawn first, and draws only fixed words.
    const held = bubble.slice(bubble.indexOf("{user && webhookHeld ? ("), bubble.indexOf(") : user && webhookView ? ("));
    expect(held).toContain("{LAZY_RETRY_TEXT}");
    expect(held).toContain("{WEBHOOK_LOADING_TEXT}");
    expect(held).not.toMatch(/\{(text|visibleText|message\.text)\}/);
    expect(bubble.indexOf("{user && webhookHeld ? (")).toBeLessThan(bubble.indexOf(") : user && webhookView ? ("));
    expect(WEBHOOK_LOADING_TEXT).toBe("Loading message…");
  });
});

describe("quotes of a webhook run (reply, composer strip, pinned banner, room label)", () => {
  const message = (text: string, role: "user" | "bot" = "user") => ({ id: "m1", role, kind: "text", text, at: 0 }) as unknown as Message;
  const quotes = (text: string, role: "user" | "bot" = "user") =>
    renderToStaticMarkup(createElement("div", null, createElement(ReplyQuote, { message: message(text, role) }), createElement(ComposerReplyStrip, { message: message(text, role), onClear: () => {} })));
  const Shown = ({ text, user }: { text: string; user: boolean }) => useWebhookDisplayText(text, user);

  it("shows the placeholder while the parser loads, never the stored text", () => {
    resetWebhookMessageLoaderForTest(() => new Promise(() => {}));
    for (const run of [fencedRun, legacyRun]) {
      const html = quotes(run);
      expect(html).toContain(WEBHOOK_LOADING_TEXT);
      expect(html).not.toContain(SECRET);
      expect(html).not.toContain("page-content");
    }
    expect(quotes("hello there")).toContain("hello there");
  });

  it("keeps the placeholder when the parser fails to load", async () => {
    resetWebhookMessageLoaderForTest(() => Promise.reject(new TypeError("Failed to fetch dynamically imported module")));
    await loadWebhookMessage().catch(() => {});
    const html = quotes(fencedRun);
    expect(html).toContain(WEBHOOK_LOADING_TEXT);
    expect(html).not.toContain(SECRET);
  });

  it("shows the task once the parser is here, and a bot message as it is", async () => {
    resetWebhookMessageLoaderForTest(() => Promise.resolve(parser));
    await loadWebhookMessage();
    const html = quotes(fencedRun);
    expect(html).toContain("Summarize the failed build.");
    expect(html).not.toContain(SECRET);
    expect(renderToStaticMarkup(createElement(Shown, { text: fencedRun, user: false }))).toContain(SECRET);
    expect(renderToStaticMarkup(createElement(Shown, { text: "plain", user: true }))).toBe("plain");
  });

  it("the pinned banner and the room label read the quote through the same hook", () => {
    const chat = read("../components/ChatView.tsx");
    const banner = chat.slice(chat.indexOf("const pinned = useMessageById("), chat.indexOf("title=\"Jump to the pinned message\""));
    expect(banner).toContain('const shown = useWebhookDisplayText(pinned?.text ?? "", pinned?.role === "user");');
    expect(banner).toContain("const text = shown.replace(");
    expect(banner).not.toContain("pinned.text ?? \"\").replace(");
    const room = read("../components/RoomSpeakerLabel.tsx");
    expect(room).toContain('const quoted = useWebhookDisplayText(replyTo?.text ?? "", replyTo?.role === "user");');
    expect(room).toContain("replySnippet((replyTo.text ? quoted : \"\")");
  });
});
