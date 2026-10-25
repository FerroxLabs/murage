// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// QW Q2 (1.0.4): what the owner sees of a bot's ```murage-question fence. Each case names the failure it prevents.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { questionFenceCards, questionFenceDisplay } from "./question-fence-display";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BODY = "{\"questions\":[{\"question\":\"Which channels?\"}]}";
const fence = `\`\`\`murage-question\n${BODY}\n\`\`\`\n`;
const reply = `Before I post it:\n\n${fence}\nThanks.`;

describe("questionFenceDisplay", () => {
  it("hides a closed fence only when its card exists in the thread", () => {
    expect(questionFenceDisplay(reply, false, "0")).toEqual({ text: "Before I post it:\n\n\nThanks.", preparing: false });
  });
  it("with no card (invalid, refused, a room, history) the fence stays today's code block", () => {
    expect(questionFenceDisplay(reply, false)).toEqual({ text: reply, preparing: false });
    expect(questionFenceDisplay(reply, false, "1")).toEqual({ text: reply, preparing: false });
  });
  it("hides only the fence the card names when a message holds several", () => {
    const two = `${fence}${fence.replace("Which", "What")}`;
    expect(questionFenceDisplay(two, false, "1").text).toBe(fence.trimEnd());
  });
  it("while streaming, an unclosed question fence is the quiet line, never raw JSON", () => {
    const streaming = `Before I post it:\n\n\`\`\`murage-question\n{"questions": [{"question": "Which`;
    expect(questionFenceDisplay(streaming, true)).toEqual({ text: "Before I post it:", preparing: true });
  });
  it("once settled, an unclosed fence is plain text again (it never became a card)", () => {
    const unclosed = `\`\`\`murage-question\n${BODY}`;
    expect(questionFenceDisplay(unclosed, false)).toEqual({ text: unclosed, preparing: false });
  });
  it("a widget fence is left to its own lane", () => {
    const widget = "```murage-widget\n{}\n```\n";
    expect(questionFenceDisplay(widget, true, "0")).toEqual({ text: widget, preparing: false });
  });
});

describe("questionFenceCards", () => {
  it("collects the fences that have a card, per message, as a stable string", () => {
    expect(questionFenceCards([
      { card: { fenceOf: { messageId: "m1", index: 1 } } },
      {},
      { card: { fenceOf: { messageId: "m1", index: 0 } } },
      { card: { fenceOf: { messageId: "m2", index: 0 } } },
    ])).toEqual(new Map([["m1", "0,1"], ["m2", "0"]]));
  });

  it("QW Q4: a widget fence hides only when its widget row exists, counted apart from question fences", () => {
    const reply = "Pick:\n\n```murage-widget\n{\"type\":\"Card\"}\n```\n\n```murage-question\n{}\n```\n\n```murage-widget\n{bad\n```\nDone.";
    const carded = questionFenceCards([{ widget: { fenceOf: { messageId: "m1", index: 0 } } }, { card: { fenceOf: { messageId: "m1", index: 0 } } }]).get("m1");
    expect(carded).toBe("0,w0");
    expect(questionFenceDisplay(reply, false, carded).text).toBe("Pick:\n\n\n\n```murage-widget\n{bad\n```\nDone.");
    expect(questionFenceDisplay(reply, false, "0").text).toContain("```murage-widget\n{\"type\"");
    expect(questionFenceDisplay(reply, false).text).toBe(reply);
  });
});

it("the quiet line is a translated string in every language pack", () => {
  for (const code of ["en", "de", "es", "fr", "hi", "ja", "pt-br", "zh"]) {
    const pack = JSON.parse(readFileSync(join(ROOT, "src", "locales", `${code}.json`), "utf8")) as Record<string, string>;
    expect(pack["chat.preparingQuestion"], code).toBeTruthy();
  }
  const chatMarkdown = readFileSync(join(ROOT, "src", "components", "ChatMarkdown.tsx"), "utf8");
  expect(chatMarkdown).toContain(`t("chat.preparingQuestion")`);
});
