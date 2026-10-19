// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One rule for every row Murage writes in its own voice (1.0.3 lifecycle card): a status, error, stop or notice chip is never a turn's
// engine output. The event fold stamps its own chips (index.ts pushMessage); every other writer of a literal activity row either wraps it
// in murageLine or says actorKind "murage". This scan keeps a new writer from forgetting it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { isEngineOutput } from "./message-db.ts";
import { murageLine } from "./murage-line.ts";
import { sendNoticeLine } from "./send-store.ts";
import { appendDelegationRow } from "./delegations.ts";
import { RowSink, writeActivityRow } from "./bot-egress.ts";
import { status } from "./murage-status.ts";
import type { Message } from "./store.ts";

const ROOT = new URL(".", import.meta.url).pathname;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" || name === "testing" ? [] : sources(path);
    return name.endsWith(".ts") && !name.includes(".test.") && !name.includes(".expect-errors.") ? [path] : [];
  });
}

/** Every object literal passed as an argument (after the thread id) of each appendMessage / insertMessage / appendAfterHead call in
 * `source`, with whether it is wrapped in murageLine. */
function literalRows(source: string): { at: number; wrapped: boolean; body: string }[] {
  const found: { at: number; wrapped: boolean; body: string }[] = [];
  const call = /\b(?:appendMessage|insertMessage|appendAfterHead)\(/g;
  for (let match = call.exec(source); match; match = call.exec(source)) {
    const args: string[] = [];
    let i = match.index + match[0].length, depth = 0, from = i;
    for (; i < source.length; i++) {
      const c = source[i];
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) { if (depth === 0) break; depth--; }
      else if (c === "," && depth === 0) { args.push(source.slice(from, i)); from = i + 1; }
    }
    args.push(source.slice(from, i));
    for (const arg of args.slice(1)) {
      const rest = arg.trimStart();
      const wrapped = rest.startsWith("murageLine(");
      if (!wrapped && !rest.startsWith("{")) continue;
      found.push({ at: match.index, wrapped, body: rest });
    }
  }
  return found;
}

describe("every row Murage writes in its own voice goes through one rule", () => {
  it("a literal bot activity row is wrapped in murageLine or is actorKind murage", () => {
    const unmarked: string[] = [];
    for (const file of sources(ROOT)) {
      const source = readFileSync(file, "utf8");
      for (const row of literalRows(source)) {
        if (row.wrapped || !/\brole:\s*["']bot["']/.test(row.body) || !/\bkind:\s*["']activity["']/.test(row.body)) continue;
        if (/actorKind:\s*["']murage["']/.test(row.body)) continue;
        unmarked.push(`${relative(ROOT, file)}:${source.slice(0, row.at).split("\n").length}`);
      }
    }
    expect(unmarked).toEqual([]);
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
    expect(written.map(row => isEngineOutput({ id: "r", at: 1, ...row }))).toEqual([false, false]);
  });
});
