// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Settings > Memory > Learn about me: the panel and its in-window review list.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { en } from "@/locales";
import { LearnAboutMe, keepAllLines, lamErrorText, rememberAction, reviewLines } from "./LearnAboutMe";
import { parseExport } from "../../shared/learn-about-me/parse";
import { LAM_EXPORT_PROMPT } from "../../shared/learn-about-me/prompt";
import { rememberedOrigin } from "../../shared/learn-about-me/origin";
import { memoryRecordOriginLabel, MemoryReview } from "./MemoryReview";

const PASTE = "Here is what I saved:\nINSTRUCTIONS\n2025-03-10 Always answer in British English\nIDENTITY\nundated I live in Austin\nPROJECTS\n2025-06 Building a garden planner\nPREFERENCES\nShort answers\nNever use tables\nTrailing note";
const render = (props: Partial<Parameters<typeof LearnAboutMe>[0]> = {}) => renderToStaticMarkup(createElement(LearnAboutMe, { desktop: true, memoryActive: true, request: async () => ({}), initialReview: { provider: "chatgpt", text: PASTE }, ...props }));
const lines = () => { const parsed = parseExport(PASTE); if (!parsed.ok) throw new Error("parse"); return reviewLines(parsed.lines); };

describe("Learn about me panel", () => {
  it("renders nothing off the desktop app", () => {
    expect(render({ desktop: false })).toBe("");
    expect(render({ desktop: undefined })).toBe("");
  });

  it("shows the export prompt, the provider picker and the paste box", () => {
    const html = render({ initialReview: undefined });
    expect(html).toContain("Learn about me");
    expect(html).toContain("I am moving my notes to Murage");
    for (const name of ["ChatGPT", "Claude", "Gemini", "Grok", "Copilot"]) expect(html).toContain(`>${name}<`);
    expect(html).toContain("Review what it found");
    expect(html).not.toContain('data-testid="learn-about-me-banner"');
  });

  it("shows the banner whenever a list is open, groups the lines and offers no pin control", () => {
    const html = render();
    expect(html).toContain('data-testid="learn-about-me-banner"');
    expect(html).toContain("This list lives only in this window");
    for (const heading of ["Instructions for every bot", "About me", "Projects and preferences", "Not under a heading"]) expect(html).toContain(heading);
    expect(html).not.toMatch(/\bpin\b/i);
    expect(html).toContain("From your ChatGPT export, dated 2025-03-10");
    expect(html).toContain("Reads like an instruction");
  });

  it("offers Keep all only for Projects and preferences, and only for waiting lines without a flag", () => {
    const html = render();
    expect(html.match(/>Keep all</g)).toHaveLength(1);
    const projects = html.slice(html.indexOf('data-lam-group="projects"'));
    expect(projects.indexOf(">Keep all<")).toBeLessThan(projects.indexOf("data-lam-line"));
    expect(keepAllLines(lines()).map(line => line.text)).toEqual(["Building a garden planner", "Short answers", "Trailing note"]);
  });

  it("disables Keep while memory is off and says why", () => {
    const html = render({ memoryActive: false });
    expect(html).toContain("Turn memory on to keep lines");
    expect(html).not.toMatch(/<button type="button" class="[^"]*">Keep</);
  });

  it("Keep posts one remember action with the exact words and where they came from", () => {
    const [, instruction, identity] = lines();
    expect(rememberAction({ ...instruction!, draft: " Always answer in British English, please " }, "chatgpt")).toEqual({ action: "remember", actionId: instruction!.actionId, text: "Always answer in British English, please", origin: { provider: "chatgpt", date: "2025-03-10" } });
    expect(rememberAction(identity!, "claude")).toEqual({ action: "remember", actionId: identity!.actionId, text: "I live in Austin", origin: { provider: "claude" } });
    expect(new Set(lines().map(line => line.actionId)).size).toBe(lines().length);
    for (const line of lines()) expect(line.actionId).toMatch(/^[\w-]{8,80}$/);
  });
});

describe("a refused Keep in plain words", () => {
  it("shows the server's sentence, and words for a known code", () => {
    expect(lamErrorText(new Error("Turn memory on to keep lines."))).toBe("Turn memory on to keep lines.");
    expect(lamErrorText(new Error("MEMORY_IDEMPOTENCY_CONFLICT"))).toBe("This line was already kept with other words. Paste again to review it fresh.");
    expect(lamErrorText(new Error("MEMORY_SOMETHING_ELSE"))).not.toMatch(/MEMORY_/);
  });
});

describe("kept lines in the memory list", () => {
  const record = { id: "owner-note:chatgpt:d:0123456789abcdef0123456789abcdef", version: 1, scopeId: "scope", kind: "fact", text: "Short answers", assertion: "owner-statement" as const, state: "active" as const, ownerPinned: false, validFrom: new Date(2025, 2, 10).getTime(), validTo: null };
  it("carry their provider and date, read from the id", () => {
    expect(rememberedOrigin(record.id)).toEqual({ provider: "chatgpt", precision: "d" });
    expect(memoryRecordOriginLabel(record)).toMatch(/^Imported from ChatGPT, .*2025/);
    expect(memoryRecordOriginLabel({ ...record, id: "owner-note:claude:u:0123456789abcdef0123456789abcdef" })).toBe("Imported from Claude, undated");
    expect(memoryRecordOriginLabel({ ...record, id: "plain-record" })).toBe("You said this");
  });
  it("say a forgotten memory's words are gone instead of showing empty text", () => {
    const html = renderToStaticMarkup(createElement(MemoryReview, { inspection: { record: { ...record, state: "deleted", text: "" }, evidence: [], lineage: [] }, audiences: [], onAction: async () => {}, onClose: () => {} }));
    expect(html).toContain("Forgotten. Its words are gone.");
  });
});

describe("copy rules", () => {
  const strings = [LAM_EXPORT_PROMPT, ...Object.entries(en).filter(([key]) => key.startsWith("learnAboutMe.") || key === "memoryReview.forgottenWords").map(([, value]) => value)];
  it("finds the new strings", () => { expect(strings.length).toBeGreaterThan(30); });
  it("uses no em or en dash, none of the banned words and no price talk", () => {
    for (const text of strings) {
      expect(text).not.toMatch(/[–—]/);
      expect(text).not.toMatch(/\b(safe|safely|safety|unsafe|composio|price|pricing|free|cost)\b/i);
    }
  });
  it("names Murage and no other product in the export prompt", () => {
    expect(LAM_EXPORT_PROMPT).toContain("Murage");
    expect(LAM_EXPORT_PROMPT).not.toMatch(/ChatGPT|Claude|Gemini|Grok|Copilot|OpenAI|Anthropic|Google/);
  });
  it("is mounted only in Settings > Memory, not in the first run", () => {
    expect(readFileSync(new URL("./MemorySettings.tsx", import.meta.url), "utf8")).toContain("<LearnAboutMe");
    expect(readFileSync(new URL("./FirstRunCard.tsx", import.meta.url), "utf8")).not.toContain("LearnAboutMe");
  });
});

describe("a paste handed over from a chat (PASTE-CAPTURE-FIX 3.3)", () => {
  it("opens the review with the paste filled in, provider Other, and a masked number flagged", () => {
    const html = render({ initialReview: undefined, initialText: "IDENTITY\nundated My checking account ending 4471 is at Frost Bank\nundated I live in Austin" });
    expect(html).toContain('data-testid="learn-about-me-review"');
    expect(html).toContain("My checking account ending **** is at Frost Bank");
    // the paste box keeps the words as pasted (they never leave this window); the review list, which Keep sends, reads masked
    expect(html.slice(html.indexOf('data-testid="learn-about-me-review"'))).not.toContain("4471");
    expect(html).toContain(en["learnAboutMe.flag.maskedIdentifier"]);
  });
  it("reads what the chat handed over once, and opens empty when nothing was handed", async () => {
    const { handLamText, peekLamText, clearLamText } = await import("@/lib/lam-handoff");
    handLamText("PROJECTS\n2025-06 Building a garden planner");
    expect(render({ initialReview: undefined })).toContain("Building a garden planner");
    clearLamText();
    expect(peekLamText()).toBeNull();
    expect(render({ initialReview: undefined })).not.toContain('data-testid="learn-about-me-review"');
  });
});
