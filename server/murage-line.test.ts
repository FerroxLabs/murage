// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One rule for every row written into a conversation (1.0.3 lifecycle card): a row Murage writes in its own voice (a status, error, stop or
// notice chip, a "Saved file" card, an approval or sign-in card) is never a turn's engine output. Unmarked, a bot row with no turn id is
// attached to the member's open turn (lineage-write.ts writerTurnFor) and moves its session past the reply, so a later hold marks the session.
// The scan reads EVERY call that appends a row and fails unless the row is wrapped in murageLine, is a literal provably not engine output
// (an owner row, actorKind murage, a run card, a copy) or engine output naming its producing turn, or is a reviewed forward below. A
// murageLine row is Murage's own only when it carries none of the model's words: one that quotes them (a prompt, an image) names the
// producing turn, so it rests on that turn's inputs and is withheld with them.
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { isEngineOutput } from "./message-db.ts";
import { murageLine } from "./murage-line.ts";
import { recoveredSteerLine, sendNoticeLine } from "./send-store.ts";
import { appendDelegationRow } from "./delegations.ts";
import { RowSink, writeActivityRow, writeBotRow } from "./bot-egress.ts";
import { status } from "./murage-status.ts";
import type { Message } from "./store.ts";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
// relative names with '/' on every platform, as the allow lists below are written
const relPath = (file: string): string => relative(ROOT, file).replace(/\\/g, "/");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" || name === "testing" ? [] : sources(path);
    return name.endsWith(".ts") && !name.includes(".test.") && !name.includes(".expect-errors.") ? [path] : [];
  });
}

/** Where the row sits among each write call's arguments (store.ts appendMessage / insertMessage* / appendAfterHead, bot-egress.ts appendRow). */
const ROW_ARG: Record<string, number> = { appendMessage: 1, insertMessage: 1, appendAfterHead: 2, insertMessageAfter: 2, insertMessageBefore: 2, appendRow: 2 };
const WRITE = /(\.|\b)(appendMessage|insertMessage|appendAfterHead|insertMessageAfter|insertMessageBefore|appendRow)\s*\(/g;
/** A call of murageLine (not a method of the same name, `comms.murageLine(...)`). */
const MURAGE_LINE = /(^|[^.\w$])murageLine\s*\(/g;
const MARKED = /^murageLine\s*\(/;

/** The top-level comma-separated pieces of `text` up to the bracket that closes the list it starts in (strings skipped). */
function topLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0, from = 0, quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = ""; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) { if (depth === 0) return [...parts, text.slice(from, i)]; depth--; }
    else if (c === "," && depth === 0) { parts.push(text.slice(from, i)); from = i + 1; }
  }
  return [...parts, text.slice(from)];
}

/** Every call in `source` that appends a row to a conversation, with the row expression it writes. A declaration (`appendMessage(threadId:
 * string, ...)` or `function appendRow(`) is not a call. */
function writes(source: string): { line: number; row: string }[] {
  const found: { line: number; row: string }[] = [];
  WRITE.lastIndex = 0;
  for (let match = WRITE.exec(source); match; match = WRITE.exec(source)) {
    const args = topLevel(source.slice(match.index + match[0].length));
    if (match[1] !== "." && (/function\s*$/.test(source.slice(Math.max(0, match.index - 9), match.index)) || /^\s*[\w$]+\??\s*:/.test(args[0] ?? ""))) continue;
    // the message database under the store: it writes the row the store's own method (scanned at its caller) was handed
    if (/\bmdb$/.test(source.slice(Math.max(0, match.index - 4), match.index))) continue;
    found.push({ line: source.slice(0, match.index).split("\n").length, row: (args[ROW_ARG[match[2]]] ?? "").trim().replace(/\s+/g, " ") });
  }
  return found;
}

/** Why a literal row is not engine output, or is engine output that names the turn that produced it; undefined when neither is provable. */
function provenLiteral(row: string): string | undefined {
  const props = topLevel(row.slice(1)).map(prop => prop.trim());
  const key = (name: string) => props.find(prop => new RegExp(`^${name}\\s*(:|$)`).test(prop));
  const role = /^role\s*:\s*["'](\w+)["']/.exec(key("role") ?? "")?.[1];
  if (role === "user" || role === "system") return "not a bot row";
  if (role !== "bot") return undefined;
  if (/["']murage["']/.test(key("actorKind") ?? "") || key("murage")) return "actorKind murage";
  if (/["'](routine\.run|goal\.run)["']/.test(key("kind") ?? "")) return "a run card";
  if (key("copyOf") || key("handoffFrom")) return "a copy or hand-off";
  if (namesTurn(key("turnId"))) return "engine output naming its turn";
  return undefined;
}

/** A turnId property that names a turn: shorthand or an expression, never a literal undefined, null or empty id. */
function namesTurn(prop: string | undefined): boolean {
  if (!prop) return false;
  const value = /^turnId\s*:\s*([\s\S]*)$/.exec(prop)?.[1]?.trim();
  return value === undefined || !/^(undefined|null|void\s+0|""|''|``)$/.test(value);
}

/** Keys that hold words or output a row shows: the model's (an image prompt, an approval card's held note or summary, an image record, an
 * attachment) or whatever a writer puts in a text field (text, title, subtitle, summary, detail, body, caption, push body). Every one is
 * Murage's fixed literal, reviewed fixed words, or the row names its producing turn. */
const MODEL_TEXT = /(^|[{,(]\s*)(held|prompt|imageRecord|attachments|text|title|subtitle|summary|detail|body|caption|pushBody)\s*[:,}]/;

/** Every murageLine call in `source`, with the row it marks. A declaration (`murageLine(channel: GroupRecord, ...)`) is not a call. */
function murageLines(source: string): { line: number; row: string }[] {
  const found: { line: number; row: string }[] = [];
  MURAGE_LINE.lastIndex = 0;
  for (let match = MURAGE_LINE.exec(source); match; match = MURAGE_LINE.exec(source)) {
    const args = topLevel(source.slice(match.index + match[0].length));
    if (/^\s*[\w$]+\??\s*:/.test(args[0] ?? "")) continue;
    found.push({ line: source.slice(0, match.index + match[1].length).split("\n").length, row: (args[0] ?? "").trim().replace(/\s+/g, " ") });
  }
  return found;
}

/** Model-text keys whose value is Murage's own fixed words, each read and proven here (by file and the property's first 60 characters). */
const OWN_WORDS: Record<string, string> = {
  "browser-extension-approvals.ts :: held: input.scope === \"site\" ? \"Allow remembers site access ": "the card's fixed note: two literal sentences and a literal suffix",
};

/** The model-text properties a row carries, each as its property text (`held: card.held`). */
function modelTextProps(row: string): string[] {
  const props: string[] = [];
  const pattern = new RegExp(MODEL_TEXT.source, "g");
  for (let match = pattern.exec(row); match; match = pattern.exec(row)) {
    props.push((topLevel(row.slice(match.index + match[1].length))[0] ?? "").trim());
    pattern.lastIndex = match.index + match[0].length - 1;
  }
  return props;
}

/** Why a literal row marked murageLine is Murage's: it carries none of the model's words (a model-text key holds a plain string literal or
 * reviewed fixed words), or it does and names the turn that produced them (it then rests on that turn's inputs, message-db.ts
 * unattributedRefs). Undefined when neither is provable, or the row is no literal. */
function provenMurageLine(row: string, file = ""): string | undefined {
  if (!row.startsWith("{")) return undefined;
  const quoting = modelTextProps(row).filter(prop => !/^\w+\s*:\s*("[^"\\]*"|'[^'\\]*'|`[^`$\\]*`)$/.test(prop) && !OWN_WORDS[`${file} :: ${prop.slice(0, 60)}`]);
  if (!quoting.length) return "Murage's own words";
  const props = topLevel(row.slice(1)).map(prop => prop.trim());
  return namesTurn(props.find(prop => /^turnId\s*(:|$)/.test(prop))) ? "the model's words, naming the producing turn" : undefined;
}

/** Row expressions that are neither a literal nor wrapped at the call, each read and proven here. A new one fails until it is added with
 * its proof; one that is gone fails too, so the list stays the code's. */
const FORWARDS: Record<string, string> = {
  "bot-egress.ts :: message": "RowSink's one write; writeBotRow and writeActivityRow stamp what they hand it (tested below)",
  "bot-egress.ts :: extra.handoffFrom || copyOfBot ? row : murageLine(row)": "writeBotRow: marked unless it is the hand-off row (handoffFrom is never engine output) or a copy of a bot's words naming its source (S6 rule 5: a bot row with copyOf, validated at read)",
  "comms-visibility.ts :: row.copyOf ? row : murageLine(row)": "mirrorReply: the target's bot row with the copyOf it used (S6 rules 5 and 8, validated at read), or murageLine",
  "comms-visibility.ts :: messagedRow(from, target, bus.turnOf?.(sourceThreadId), comm)": "mirrorExchange, an immediate send: the sender's Messaged row is the engine output of the turn running now, which it names (S6 rule 6)",
  "delegations.ts :: messagedRow(from, target, senderTurnId ?? undefined)": "queueDelegation: the sender's Messaged row is the engine output of the turn that queued it, which it names (S6 rule 6)",
  "handoff-reply.ts :: message": "appendHandoffReply: only a recovered reply with its original, the worker's own row (S6 rule 5: a bot row with copyOf, validated at read); one with no original is murageLine",
  "delegations.ts :: sender ? { ...row, from: { botId: sender.id, name: sender.name, color: sender.color } } : row": "row = murageLine(message) (tested below)",
  "index.ts :: { ...recoveredSteerLine(row, randomUUID()), ...(row.origin ? { origin: row.origin as MessageOrigin } : {}) }": "an owner row (tested below)",
  "index.ts :: sendNoticeLine(\"notConfirmed\")": "the stamped notice helper (tested below)",
  "index.ts :: sendNoticeLine(\"lateRefused\")": "the stamped notice helper (tested below)",
  "index.ts :: stored": "the event fold (pushMessage): stamps every chip that is not the engine's, and a bot row of the engine names event.turnId",
  "index.ts :: message": "syncRoutineRunToSource: a routine.run card (message-db.ts MURAGE_KINDS)",
  "voice/voice-notes.ts :: input.turnId ? { ...row, turnId: input.turnId } : murageLine(row)": "createVoiceNote: the producing turn's engine output, or murageLine when no turn made it (tested in voice-notes.test.ts)",
  "chat-widgets.ts :: turnId ? { ...row, turnId } : row": "appendWidget (1.0.6 QW Q4, 0bc0c7c28): the engine's widget names the turn that showed it; with no turn it is an unmarked engine row naming none, which message-db.ts unattributedRefs rests on every open turn's parents (withheld when they are), never Murage's own line",
  "index.ts :: turnId ? { ...row, turnId } : row": "openAnswerAsSendCard (1.0.6 QW Q1, 958352223): the engine's question names the turn that asked it (card.turnId too); with no turn it is an unmarked engine row naming none, which message-db.ts unattributedRefs rests on every open turn's parents, never Murage's own line",
  "store.ts :: input":"appendAfterHead / insertMessageBefore handing their caller's row (scanned at the caller) to appendMessage",
  "store.ts :: message": "insertMessageAfter handing its caller's row (scanned at the caller) to appendMessage",
  "output-publication.ts :: imageOutputRow(row, options.turnId)": "completeImageOutput: the producing turn's engine output (turnId from the actor's capability), or murageLine when no turn made it (tested in output-publication.test.ts)",
  "output-publication.ts :: imageOutputRow(row, receipt.producer === \"assistant-image\" && receipt.runId ? receipt.runId : undefined)": "finishImageReceipt: an assistant image's receipt run id is the provider turn that sent it (index.ts publishAssistantImage)",
};

/** murageLine calls whose row is no literal, each read and proven here (as FORWARDS). */
const MARKED_FORWARDS: Record<string, string> = {
  "bot-egress.ts :: murageLine(row)": "writeBotRow: a worker's words written into another conversation than its turn's; its sources ride copyOf when the outbound names them",
  "delegations.ts :: murageLine(message)": "appendDelegationRow: Murage's chips about a hand-off",
  "handoff-reply.ts :: murageLine(message)": "appendHandoffReply: another conversation's reply quoted into the asking one; its source rides copyOf when the caller passes it",
  "routine-requests.ts :: murageLine(messageInput)": "a routine request card: title and detail from cardCopy",
  "comms-visibility.ts :: murageLine(row)": "mirrorReply: a status line that quotes no worker (a copy of a worker's words is the target's bot row with copyOf, S6 rules 5 and 8)",
  "index.ts :: murageLine(plain)": "the event fold: the turn's own chips carry event.turnId, so they rest on that turn's inputs",
  "voice/voice-notes.ts :: murageLine(row)": "createVoiceNote with no producing turn (a replay); with one the row is the turn's engine output",
  "output-publication.ts :: murageLine(row)": "imageOutputRow with no producing turn named; with one the row is the turn's engine output",
};

/** How much of a row's text keys it (file and the row's first characters). */
const ROW_KEY = 100;
/** Marked rows with a text field whose words Murage composes itself (fixed copy, a bot's or skill's name, a status line): each read and proven. */
const MURAGE_COPY: Record<string, string> = {
  "host-computer-consent.ts :: { role: \"bot\", kind: \"options\", card: { title: `Let @${bot.name} use this computer?`, subtitle: `@${": "Murage composes these words (fixed copy, a bot's or skill's name, or a status line); no engine or bot text",
  "handoff-reply.ts :: { role: \"bot\", kind: \"text\", inboundKind: \"action\", text: outboundWords(line), murage: { kind: \"stat": "Murage composes these words (the no-answer status line, a kept status); no engine or bot text",
  "index.ts :: { role: \"bot\", kind: \"text\", text: line, setupEcho: echo }": "Murage composes these words (fixed copy, a bot's or skill's name, or a status line); no engine or bot text",
  "index.ts :: { role: \"bot\", kind: \"options\", card: { title: card.title, subtitle: card.subtitle, options: [], set": "Murage composes these words (fixed copy, a bot's or skill's name, or a status line); no engine or bot text",
  "index.ts :: { role: \"bot\", kind: \"activity\", // A room chip with no speaker renders unattributed; a 1:1 chip alr": "Murage composes these words (fixed copy, a bot's or skill's name, or a status line); no engine or bot text",
  "index.ts :: { role: \"bot\", kind: \"text\", text: `Connected-app access is waiting for your review for @${target.na": "Murage composes these words (fixed copy, a bot's or skill's name, or a status line); no engine or bot text",
  "index.ts :: { role: \"bot\", kind: \"text\", text: `${offSkills.length === 1 ? \"One skill I came with is\" : `${offSk": "Murage composes these words (fixed copy, a bot's or skill's name, or a status line); no engine or bot text",
  "index.ts :: { role: \"bot\", kind: \"text\", text: intakeClosingLine(\"general\"), }": "Murage composes these words (fixed copy, a bot's or skill's name, or a status line); no engine or bot text",
  "index.ts :: { role: \"bot\", kind: \"text\", text: intakeClosingLine(outcome, intake.candidate?.name), }": "Murage composes these words (fixed copy, a bot's or skill's name, or a status line); no engine or bot text",
  "index.ts :: { role: \"bot\", kind: \"text\", text: `I switched off my \"${name}\" skill because the skill check found ": "Murage composes these words (fixed copy, a bot's or skill's name, or a status line); no engine or bot text",
  "publish/publish-ops.ts :: { role: \"bot\", kind: \"options\", ...(from ? { from } : {}), card: { title, subtitle: \"\", options: [],": "Murage composes these words (fixed copy, a bot's or skill's name, or a status line); no engine or bot text",
  "store.ts :: { role: \"bot\", kind: \"text\", text: openingLine(name) }": "Murage composes these words (fixed copy, a bot's or skill's name, or a status line); no engine or bot text",
};
/** Marked rows with a text field that may carry the model's or a bot's words and name no producing turn. Empty: every such row names its turn
 * (turnId from the server's capability state or the original row), or is listed above as Murage's or the owner's own copy. A new one fails. */
const OPEN_GAPS: Record<string, string> = {};

describe("every row Murage writes in its own voice goes through one rule", () => {
  it("every call that appends a row writes one marked as Murage's or one provably the engine output of the turn it names", () => {
    const unproven: string[] = [];
    const forwarded = new Set<string>();
    for (const file of sources(ROOT)) {
      const source = readFileSync(file, "utf8");
      for (const { line, row } of writes(source)) {
        if (MARKED.test(row)) continue; // proven below, with every other murageLine call
        if (row.startsWith("{") && provenLiteral(row)) continue;
        const key = `${relPath(file)} :: ${row}`;
        if (FORWARDS[key]) { forwarded.add(key); continue; }
        unproven.push(`${relPath(file)}:${line} ${row.slice(0, 120)}`);
      }
    }
    expect(unproven, "wrap the row in murageLine, or give engine output its producing turnId").toEqual([]);
    expect(Object.keys(FORWARDS).filter(key => !forwarded.has(key)), "a reviewed forward that no longer exists").toEqual([]);
  });

  it("every murageLine row is Murage's own words, or quotes the model's and names the turn that produced them", () => {
    const unproven: string[] = [];
    const forwarded = new Set<string>();
    for (const file of sources(ROOT)) {
      const source = readFileSync(file, "utf8");
      for (const { row } of murageLines(source)) {
        if (provenMurageLine(row, relPath(file))) continue;
        const key = `${relPath(file)} :: murageLine(${row})`;
        if (MARKED_FORWARDS[key]) { forwarded.add(key); continue; }
        const head = `${relPath(file)} :: ${row.slice(0, ROW_KEY)}`;
        if (MURAGE_COPY[head] || OPEN_GAPS[head]) { forwarded.add(head); continue; }
        unproven.push(`${head}`);
      }
    }
    expect(unproven, "a row quoting the model's words (a prompt, an image) names its producing turnId").toEqual([]);
    expect([...Object.keys(MARKED_FORWARDS), ...Object.keys(MURAGE_COPY), ...Object.keys(OPEN_GAPS)].filter(key => !forwarded.has(key)), "a reviewed forward that no longer exists").toEqual([]);
  });

  it("the guard is not bypassed by spacing, an undefined turn or a marked row quoting the model", () => {
    const spaced = writes(`store.appendMessage (t, { role: "bot", kind: "text", text: "x" });\nstore.appendMessage(t, murageLine ({ role: "bot", prompt }));`);
    expect(spaced.map(row => row.row.slice(0, 12)), "whitespace before ( is still a write").toEqual(["{ role: \"bot", "murageLine ("]);
    expect(MARKED.test(spaced[1].row)).toBe(true);
    expect(murageLines(`x = murageLine ({ role: "bot", attachments: [a] });\ncomms.murageLine(channel, s);\nmurageLine(channel: GroupRecord): void;`).map(row => row.line)).toEqual([1]);
    expect(provenLiteral(`{ role: "bot", kind: "text", text, turnId: undefined }`), "turnId: undefined names no turn").toBeUndefined();
    expect(provenLiteral(`{ role: "bot", kind: "text", text, turnId: null }`)).toBeUndefined();
    expect(provenLiteral(`{ role: "bot", kind: "text", text, turnId }`)).toBe("engine output naming its turn");
    expect(provenMurageLine(`{ role: "bot", kind: "activity", tool: { name: "error: x", ok: false } }`)).toBe("Murage's own words");
    expect(provenMurageLine(`{ role: "bot", kind: "options", card: { title: "Approve", held: prompt } }`), "a held prompt with no turn").toBeUndefined();
    expect(provenMurageLine(`{ role: "bot", kind: "text", text, attachments: [{ kind: "image", path }] }`), "an image with no turn").toBeUndefined();
    expect(provenMurageLine(`{ role: "bot", kind: "activity", turnId: undefined, tool: { imageRecord: { prompt } } }`)).toBeUndefined();
    expect(provenMurageLine(`{ role: "bot", kind: "activity", turnId: actor.turnId, tool: { imageRecord: { prompt } } }`)).toBe("the model's words, naming the producing turn");
    expect(provenMurageLine("row"), "a non-literal row is proven only by review").toBeUndefined();
    expect(provenMurageLine(`{ role: "bot", kind: "options", card: { title: "x", held: "Asked once for each bot." } }`), "a fixed literal is Murage's").toBe("Murage's own words");
    expect(provenMurageLine(`{ role: "bot", kind: "options", card: { title: "x", held: \`Files: \${names}\` } }`), "a template with values is not").toBeUndefined();
  });

  it("the scan sees every write and refuses an unmarked one", () => {
    const rows = writes(`store.appendMessage(t, { role: "bot", kind: "text", text: "Saved file: x" });\nstore.appendMessage(t, murageLine({ role: "bot" }));\nappendMessage(threadId: string, m: Message) {}\nrows.appendRow(sink, t, row);`);
    expect(rows.map(row => [row.line, row.row.slice(0, 11)])).toEqual([[1, "{ role: \"bo"], [2, "murageLine("], [4, "row"]]);
    expect(provenLiteral(rows[0].row)).toBeUndefined();
    expect(provenLiteral(`{ role: "bot", kind: "text", text, turnId: event.turnId }`)).toBe("engine output naming its turn");
    expect(provenLiteral(`{ role: "bot", kind: "text", ...(copyOf ? { copyOf } : {}) }`), "a conditional copy proves nothing").toBeUndefined();
    expect(provenLiteral(`{ role: "user", kind: "text", text }`)).toBe("not a bot row");
  });

  it("a marked line is never engine output; the same row unmarked is", () => {
    const row = { id: "x", at: 1, role: "bot" as const, kind: "activity" as const, turnId: "turn-1", tool: { name: "error: spawn failed", ok: false } };
    expect(isEngineOutput(row)).toBe(true);
    expect(isEngineOutput(murageLine(row))).toBe(false);
  });

  it("the shared writers of Murage's chips stamp the rows they write", () => {
    expect(isEngineOutput({ id: "n", at: 1, ...sendNoticeLine("lateRefused") })).toBe(false);
    const written: Omit<Message, "id" | "at">[] = [];
    const store = { appendMessage: (_threadId: string, message: Omit<Message, "id" | "at">) => { written.push(message); return { id: "r", at: 1, ...message } as Message; } };
    appendDelegationRow({ store: { ...store, groupByThread: () => undefined, bot: () => undefined } } as never, "t", undefined, { role: "bot", kind: "activity", tool: { name: "Delegation waiting", ok: false } });
    writeActivityRow(new RowSink(store), "t", {}, status("withheld"));
    writeBotRow(new RowSink(store), "t", {}, status("withheld"));
    expect(written.map(row => isEngineOutput({ id: "r", at: 1, ...row }))).toEqual([false, false, false]);
    expect(recoveredSteerLine({ text: "hi", queueId: "q" } as never, "s").role).toBe("user");
  });
});
