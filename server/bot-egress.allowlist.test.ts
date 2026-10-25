// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The import allowlist the typed hand-off boundary relies on (DESIGN-r7 item 2). The types stop a worker's string from reaching a bot; this keeps
// the few functions that could turn a string into a status, read worker words back, or mint released text in the few modules that need them.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SERVER_DIR = fileURLToPath(new URL(".", import.meta.url));
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { if (name !== "node_modules" && name !== "testing") sources(path, out); continue; }
    if (/\.ts$/.test(name) && !/\.(test|bench\.test|expect-errors)\.ts$/.test(name) && !name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}
const files = sources(SERVER_DIR).map(path => ({ name: relative(SERVER_DIR, path).replace(/\\/g, "/"), text: readFileSync(path, "utf8") }));
/** The modules (outside tests) whose source matches `pattern`. */
const using = (pattern: RegExp) => files.filter(file => pattern.test(file.text)).map(file => file.name).sort();

describe("who may make a status from a string, read worker words, or mint released text", () => {
  it("only the server's port adapters wrap a string as a Murage line", () => {
    expect(using(/\bhostLine\b/)).toEqual(["host-words.ts", "index.ts", "project-digest.ts", "result-egress.ts", "shared-work.ts"]);
  });
  it("the status wrapper is claimed by one module", () => {
    expect(using(/MurageStatus\.claimHost\(/)).toEqual(["host-words.ts"]);
  });
  it("worker words are unsealed by the result gate alone", () => {
    expect(using(/WorkerText\.claimUnseal\(/)).toEqual(["result-egress.ts"]);
    expect(using(/WorkerText\.unseal\b/)).toEqual([]);
  });
  it("released text is minted by the result gate alone", () => {
    expect(using(/ReleasedText\.claim\(/)).toEqual(["result-egress.ts"]);
    expect(using(/new ReleasedText\(/)).toEqual(["released-text.ts"]);
    expect(using(/new MurageStatus\(/)).toEqual(["murage-status.ts"]);
  });
  it("worker text is sealed only where a stored row or a reply enters", () => {
    // frozen-replies.ts: the boot recovery seals a worker turn's stored rows before the gate judges them (REPLY-WITHHELD-CONTRACT C5, R7)
    expect(using(/new WorkerText\(/)).toEqual(["boundary-ports.ts", "card-summary.ts", "frozen-replies.ts", "handoff-boundary.ts", "index.ts", "project-notes.ts"]);
  });
  it("a row's store is held by the row sink and nobody else in the egress modules", () => {
    expect(using(/\bRowSink\.append\b/)).toEqual([]);
    expect(using(/sinkStores\b/)).toEqual(["bot-egress.ts"]);
  });
});

describe("names, card titles and kept statuses", () => {
  it("a card title is made only by the boundary's store adapter", () => {
    expect(using(/(?<![.\w])cardTitle\(/)).toEqual(["boundary-ports.ts", "murage-status.ts"]);
  });
  it("no module reads a request's ending by parsing a prefixed note", () => {
    expect(using(/startsWith\(NOTE_PREFIX\)|"status:"/)).toEqual([]);
  });
});

describe("a dispatch failure reaches a transcript a bot reads only as a code", () => {
  const index = files.find(file => file.name === "index.ts")!.text;
  it("the chip a delegation that could not start leaves in the source conversation is a table line, not the engine's message", () => {
    expect(index).not.toMatch(/delegation to @\$\{bot\?\.name \?\? toBotId\} could not start: \$\{/);
    expect(index).toMatch(/status\("row_could_not_start", \{ name: botNameOf\(bot, toBotId\), why: code \}\)/);
  });
  it("the full explanation of a refusal before the turn began is kept in the worker's own conversation", () => {
    // the hand-off's start moved to the dispatch (pm-sends): a startTurn that throws was refused before the turn began
    const dispatch = files.find(file => file.name === "handoff-dispatch.ts")!.text;
    expect(dispatch).toMatch(/await h\.startTurn\(target\.id, text, \{[\s\S]{0,600}?\} catch \(error\) \{[\s\S]{0,400}?recordRefusedStart\(bus\.store, destination, error instanceof Error \? error\.message : String\(error\)\);/);
  });
  it("a synchronous ask refused before the asked bot's turn began keeps the same explanation for the owner (R8-03)", () => {
    const ask = index.slice(index.indexOf("function askBotAndWait("), index.indexOf("async function defaultSelection("));
    expect(ask).toMatch(/\.catch\(\(err\) => \{[\s\S]{0,500}?recordRefusedStart\(store, threadId, reason\);[\s\S]{0,120}?finish\(askOutcome\("error"/);
  });
  it("a shared run's dispatch failure is kept as a status and the engine's words only as the owner's diagnostic (R8-02)", () => {
    expect(index).not.toMatch(/onDispatchError: note => finish\(undefined, note\)/);
    expect(index).toMatch(/onDispatchError: \(reason, error\) => finish\(undefined, \{ ending: status\("delegated_turn_could_not_start", \{ why: startFailureCodeFrom\(error \?\? reason\) \}\), diagnostic: reason \}\)/);
  });
});

describe("the hand-off boundary", () => {
  const boundary = files.find(file => file.name === "handoff-boundary.ts")!.text;
  it("imports nothing that wraps a string as a status, and no comms module", () => {
    expect(boundary).not.toMatch(/from "\.\/host-words\.ts"/);
    expect(boundary).not.toMatch(/from "\.\/comms-visibility\.ts"/);
    expect(boundary).not.toMatch(/\bhostLine\b/);
    expect(boundary).not.toMatch(/\boutboundWords\b/);
  });
  it("holds the row sink only as a type", () => {
    expect(boundary).toMatch(/import \{ type RowSink, /);
    expect(boundary).not.toMatch(/new RowSink\(/);
  });
  it("never reaches for the whole store, a comms bus, or a row's text", () => {
    expect(boundary).not.toMatch(/\bcommsBus\b|\bwhole\(|\.appendMessage\(|\.patchMessage\(|\.messagesFor\(|\bmessageById\(/);
  });
  it("reads a stored row only sealed, and only the rows since a turn began", () => {
    expect(boundary).toMatch(/store\.rowsSince\(/);
    expect(boundary).not.toMatch(/\browsFor\(/);
    expect(boundary).not.toMatch(/\.tool\??\.name\b/);
  });
  it("holds no database handle and casts no string to a name or a card title (r8 F3)", () => {
    expect(boundary).not.toMatch(/from "\.\/database\.ts"/);
    expect(boundary).not.toMatch(/\bdatabase\(\)/);
    expect(boundary).not.toMatch(/\bbotNameOf\b/);
    expect(boundary).not.toMatch(/(?<![.\w])cardTitle\(/);
    expect(boundary).not.toMatch(/as (unknown as )?(BotName|CardTitle)\b/);
  });
  it("reads how a request ended only as a kept status, never by parsing a note (R8-02)", () => {
    expect(boundary).not.toMatch(/\bstatusFromNote\b|\bnoteOf\b|outcomeNote, "request_failed"/);
  });
});
