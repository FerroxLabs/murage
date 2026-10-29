// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// QW Q2 (1.0.4): the one fence parser the server's fold and the client share, the fence's body normaliser, and the rule that
// only the assistant-text fold materialises a fence. Each case names the failure it prevents.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { closedFences, scanMurageFences } from "./murage-fences.ts";
import { fromQuestionFence } from "../server/question-normalize.ts";
import { QUESTION_LIMITS } from "./questions.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const QUESTION = JSON.stringify({ questions: [{ question: "Which channels?", options: [{ label: "Email" }, { label: "Slack" }], multiSelect: true }] });

describe("scanMurageFences", () => {
  it("reports ranges for ordinary, murage and unterminated code fences", () => {
    const blocks = ["```json\n{}\n```\n", "~~~murage-question\n{}\n~~~\n", "````\n```\nstill code"];
    const text = `before\n${blocks[0]}between\n${blocks[1]}after\n${blocks[2]}`;
    const scan = scanMurageFences(text);
    expect(scan.codeRanges.map(({ start, end }) => text.slice(start, end))).toEqual(blocks);
    expect(scan.closed).toHaveLength(1);
    expect(scan.open).toBeUndefined();
  });

  it("finds closed question and widget fences, each kind numbered on its own (the card and the widget lane match by index)", () => {
    const text = `Hi\n\n\`\`\`murage-question\n${QUESTION}\n\`\`\`\n\n\`\`\`murage-widget\n{"root":1}\n\`\`\`\n\n\`\`\`murage-question\n{}\n\`\`\`\n`;
    const scan = scanMurageFences(text);
    expect(scan.closed.map(({ kind, index, body }) => ({ kind, index, body }))).toEqual([
      { kind: "murage-question", index: 0, body: `${QUESTION}\n` },
      { kind: "murage-widget", index: 0, body: "{\"root\":1}\n" },
      { kind: "murage-question", index: 1, body: "{}\n" },
    ]);
    expect(scan.open).toBeUndefined();
    const [first] = closedFences(text, "murage-question");
    expect(text.slice(first!.start, first!.end)).toBe(`\`\`\`murage-question\n${QUESTION}\n\`\`\`\n`);
  });

  it("an unclosed fence is reported as open, never as closed (a streaming reply is never a card)", () => {
    const scan = scanMurageFences(`Thinking\n\`\`\`murage-question\n{"questions": [`);
    expect(scan.closed).toEqual([]);
    expect(scan.open).toEqual({ kind: "murage-question", index: 0, start: 9 });
  });

  it("a fence quoted inside another code block, a shorter closer, or a closer with words is not a fence of its own", () => {
    const quoted = `\`\`\`\`markdown\n\`\`\`murage-question\n${QUESTION}\n\`\`\`\n\`\`\`\`\n`;
    expect(scanMurageFences(quoted).closed).toEqual([]);
    expect(scanMurageFences(`\`\`\`\`murage-question\n${QUESTION}\n\`\`\`\n`).closed).toEqual([]);
    expect(scanMurageFences(`\`\`\`murage-question\n${QUESTION}\n\`\`\` done\n`).closed).toEqual([]);
    // other languages are never murage fences, and tildes close only tildes
    expect(scanMurageFences("```json\n{}\n```\n").closed).toEqual([]);
    expect(scanMurageFences(`~~~murage-question\n${QUESTION}\n~~~`).closed).toHaveLength(1);
    expect(scanMurageFences(`~~~murage-question\n${QUESTION}\n\`\`\`\n`).open?.kind).toBe("murage-question");
  });
});

describe("scanMurageFences line breaks", () => {
  it.each([["CR", "\r"], ["CRLF", "\r\n"], ["LF", "\n"]])("a %s ends every fence line", (_name, br) => {
    const text = ["```json", "{}", "```", "```murage-question", "{}", "```", ""].join(br);
    const scan = scanMurageFences(text);
    expect(scan.codeRanges).toHaveLength(2);
    expect(scan.closed.map(({ kind, body }) => ({ kind, body }))).toEqual([{ kind: "murage-question", body: `{}${br}` }]);
    expect(scan.open).toBeUndefined();
  });
  it("a bare CR closer closes the fence, so text after it is outside the code range", () => {
    const text = "```\rcode\r```\rafter";
    const { codeRanges } = scanMurageFences(text);
    expect(codeRanges).toHaveLength(1);
    expect(text.slice(codeRanges[0]!.end)).toBe("after");
  });
});

describe("fromQuestionFence (the same normaliser as ask_user)", () => {
  it("a valid fence gives the ask_user questions", () => {
    expect(fromQuestionFence(QUESTION)).toEqual({ ok: true, questions: [{ id: "q1", question: "Which channels?", options: [{ label: "Email" }, { label: "Slack" }], multiSelect: true, allowOther: true }] });
  });
  it("invalid JSON, over any limit, or a secret is refused whole (it stays the bot's text, never a cut-down card)", () => {
    expect(fromQuestionFence("{not json").ok).toBe(false);
    expect(fromQuestionFence(JSON.stringify({ questions: [{ question: "x".repeat(QUESTION_LIMITS.questionChars + 1) }] })).ok).toBe(false);
    expect(fromQuestionFence(JSON.stringify({ questions: [{ question: "Pick", options: [{ label: "y".repeat(QUESTION_LIMITS.labelChars + 1) }] }] })).ok).toBe(false);
    expect(fromQuestionFence(JSON.stringify({ questions: [{ question: "Pick", options: [{ label: "A", description: "z".repeat(QUESTION_LIMITS.descriptionChars + 1) }] }] })).ok).toBe(false);
    expect(fromQuestionFence(JSON.stringify({ questions: Array.from({ length: QUESTION_LIMITS.questions + 1 }, () => ({ question: "Q" })) })).ok).toBe(false);
    expect(fromQuestionFence(JSON.stringify({ questions: [{ question: "Your key?", secret: true }] })).ok).toBe(false);
  });
});

describe("only the assistant-text fold materialises a fence", () => {
  it("one call site, right after the fold's own pushMessage of the reply (coordinator text, status lines and history bypass it)", () => {
    const source = readFileSync(join(ROOT, "server", "index.ts"), "utf8");
    const calls = [...source.matchAll(/materialiseQuestionFences\(/g)];
    // the definition and one call
    expect(calls).toHaveLength(2);
    expect(source).toContain(`const said = pushMessage({ role: "bot", kind: "text", text: shown, turnId: event.turnId }, before, reply);
        // QW Q2: the reply's closed \`\`\`murage-question fences become question cards, here and nowhere else
        const asker = bot?.id ?? (group ? speaker?.botId : undefined);
        if (asker && said) materialiseQuestionFences(event.threadId, asker, said, event.turnId);`);
  });
});
