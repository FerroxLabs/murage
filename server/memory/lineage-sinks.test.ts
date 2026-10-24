// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The static sink test of the write-time privacy lane (DESIGN-WRITETIME 2, Enforcement (b)). Completeness at write is the whole guarantee
// (risk 1): a message writer, an engine send or a tool handler that returns stored text without naming what it rests on leaks after a
// later forget. This test lists every such sink in server/ and fails on any that is not in the reviewed list below, on a reviewed count that
// moved (a sink added or removed: review it and update the list), and on any cast to a lineage brand outside the one module that may make it.
//
// Each reviewed entry says how the sink is covered: "lineage" (it goes through the brands: promptPart / toolText / buildPrompt /
// turnToolText, or the driver send types in drivers/engine-input.ts), "driver-internal" (a driver re-sending the input it was given), or
// "pending <slice>": reviewed, owned by that slice of the lane, which moves it onto the brands. A pending entry is still covered at read: a
// line with no lineage row reads "checking" and is never shown (DESIGN-WRITETIME 2, Enforcement (c)).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SERVER = join(import.meta.dirname, "..");

type Category = "messageInsert" | "engineSend" | "toolHandler" | "maker";
const PATTERNS: Record<Category, RegExp> = {
  // every writer of the messages table (DESIGN-WRITETIME 2: writeMessage takes a LineageToken)
  messageInsert: /INSERT(?:\s+OR\s+\w+)?\s+INTO\s+messages\b/g,
  // every driver send, steer and text-only submission (not LineageAllowance.steer(), a budget constructor)
  engineSend: /(?<!LineageAllowance)\.(?:sendTurn|steer|textOnlyTurn)(?:!|\?\.)?\(/g,
  // every Murage tool handler registry entry: project tools and the internal tool routes
  toolHandler: /projectToolHandlers\.set\(|path\s*===\s*"\/api\/internal\/|path\.startsWith\("\/api\/internal\//g,
  // every maker of engine input or tool results
  maker: /\b(?:promptPart|toolText|buildPrompt|turnToolText)\(/g,
};
const CASTS = /\bas\s+(BuiltPrompt|ToolText|PromptPart|LineageToken)\b/g;
const CAST_OWNER: Record<string, string> = { BuiltPrompt: "memory/prompt-parts.ts", ToolText: "memory/prompt-parts.ts", PromptPart: "memory/prompt-parts.ts", LineageToken: "memory/lineage-write.ts" };

type Reviewed = { count: number; covered: string };
/** The reviewed sinks: file -> category -> count and how it is covered. */
const REVIEWED: Record<string, Partial<Record<Category, Reviewed>>> = {
  "message-db.ts": { messageInsert: { count: 2, covered: "lineage (writeMessage takes the LineageToken writeLineage returns; the legacy-file import writes its rows and marks its threads not ready)" } },
  "drivers/engine-input.ts": { engineSend: { count: 2, covered: "lineage (sendBuiltTurn / steerBuilt: BuiltPrompt in, the send fence before every write)" } },
  "drivers/acp/core.ts": { engineSend: { count: 1, covered: "driver-internal (a prewarm: nothing is sent)" } },
  "harness/instance-holds.ts": { engineSend: { count: 1, covered: "driver-internal (a wrapper passing the turn it was given)" } },
  "harness/memory-adapter.ts": { engineSend: { count: 1, covered: "driver-internal (a wrapper passing the turn it was given)" } },
  "drivers/cli-memory-learning.ts": { engineSend: { count: 1, covered: "driver-internal (learning's hidden one-shot on a CLI or ACP login: the extraction prompt the memory helper built, a thread no window or bot sees, no tools, every ask denied, its events ignored by the server)" } },
  "index.ts": {
    engineSend: { count: 3, covered: "lineage (the sends inside sendProjectUsageTurn write fencedTurnInput's input: a BuiltPrompt in, the send fence before every write)" },
    toolHandler: { count: 50, covered: "lineage (1.0.4 QW: ask-user, show-widget and update-widget answer a message id, a widget id and a fixed line, never stored text; routes that hand a turn stored or bot-written text answer through toolJson / turnToolText: tool-result, skills, the image library; ask and delegate results join the turn in result-egress.ts; the rest hand over no stored text: a bot filing an MCP server switched off (answers its name and pending keys only), capabilities, connectors, browser and computer control, web search, image generation, routines, roster, staging)" },
    maker: { count: 8, covered: "lineage (the direct, room-member and Chief proposal prompts; toolJson; the room's last rebuild carries an empty working context resting on none)" },
  },
  "memory/pip-reflect.ts": { engineSend: { count: 1, covered: "lineage (a text-only reflection over the bot's admitted sources, probe and content through one paid-call wrapper; every claim it writes cites them as memory_evidence, which the marker walks source -> records)" } },
  "memory/pip-reflect-host.ts": { engineSend: { count: 1, covered: "lineage (the text-only route the reflection calls; see pip-reflect.ts)" } },
  "memory/routes.ts": { toolHandler: { count: 4, covered: "lineage (memory search and recall: each lookup is a receipt that joins the running turn, dispatch.ts noteLookup -> receiptJoinsTurn)" } },
  "image-library-audience.ts": { toolHandler: { count: 2, covered: "lineage (an owner-audience check only; the library routes answer through toolJson in index.ts)" } },
  "internal-capabilities.ts": { toolHandler: { count: 4, covered: "lineage (none: capability routing only, no stored text; the Cloud line's /api/internal/box/v1/ prefix maps to the computer kind)" } },
  "shared-bots-roster.ts": { toolHandler: { count: 2, covered: "lineage (none: roster refusals only, no stored text)" } },
  "project-tool-routing.ts": { toolHandler: { count: 3, covered: "lineage (none: card verbs return card state, not stored lines; a card a lead writes rests on its turn, project-cards.ts)" } },
  "project-memory-tools.ts": {
    toolHandler: { count: 4, covered: "lineage (read-messages: turnToolText with point carries; bring-in: the running turn; summary and suggest: the writer's turn)" },
    maker: { count: 2, covered: "lineage" },
  },
  "loop-nudge.ts": { maker: { count: 2, covered: "lineage (a fixed note resting on none: murage; steerBusyDesk runs the send fence)" } },
  "memory/prompt-parts.ts": { maker: { count: 5, covered: "lineage (the constructors themselves)" } },
  "room-transcript.ts": { maker: { count: 1, covered: "lineage (roomTranscriptPart)" } },
  "skills.ts": { maker: { count: 2, covered: "lineage (skills index part, skill file tool text)" } },
  "steer-lineage.ts": { maker: { count: 2, covered: "lineage (a steer's BuiltPrompt: the owner's words and the quote it carries)" } },
  "working-context.ts": { maker: { count: 2, covered: "lineage (workingContextPart)" } },
};

function sources(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "testing") continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")) files.push(path);
    }
  };
  walk(SERVER);
  return files;
}
/** Code lines only: a comment that names a sink is not one. */
const codeLines = (text: string) => text.split("\n").filter(line => { const t = line.trim(); return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*"); });

function inventory(): { found: Record<string, Partial<Record<Category, number>>>; casts: string[] } {
  const found: Record<string, Partial<Record<Category, number>>> = {};
  const casts: string[] = [];
  for (const file of sources()) {
    const rel = relative(SERVER, file).split("\\").join("/");
    for (const line of codeLines(readFileSync(file, "utf8"))) {
      for (const [category, pattern] of Object.entries(PATTERNS) as Array<[Category, RegExp]>) {
        const n = line.match(pattern)?.length ?? 0;
        if (n) (found[rel] ??= {})[category] = (found[rel]![category] ?? 0) + n;
      }
      for (const match of line.matchAll(CASTS)) if (CAST_OWNER[match[1]!] !== rel) casts.push(`${rel}: as ${match[1]}`);
    }
  }
  return { found, casts };
}

describe("write-time sinks (DESIGN-WRITETIME 2, Enforcement (b))", () => {
  const { found, casts } = inventory();

  it("every message insert, engine send, tool handler and lineage constructor in server/ is in the reviewed list, with its reviewed count", () => {
    const unreviewed: string[] = [];
    for (const [file, categories] of Object.entries(found)) {
      for (const [category, count] of Object.entries(categories) as Array<[Category, number]>) {
        const reviewed = REVIEWED[file]?.[category];
        if (!reviewed) unreviewed.push(`${file} ${category} x${count}: not reviewed`);
        else if (reviewed.count !== count) unreviewed.push(`${file} ${category}: ${count} found, ${reviewed.count} reviewed`);
      }
    }
    for (const [file, categories] of Object.entries(REVIEWED)) {
      for (const category of Object.keys(categories) as Category[]) if (!found[file]?.[category]) unreviewed.push(`${file} ${category}: reviewed but gone (update the list)`);
    }
    expect(unreviewed).toEqual([]);
  });

  it("no cast to BuiltPrompt, PromptPart or ToolText outside prompt-parts.ts, nor to LineageToken outside lineage-write.ts", () => {
    expect(casts).toEqual([]);
  });

  it("every reviewed entry says how it is covered, and none is left pending once S1 to S5 are merged", () => {
    for (const categories of Object.values(REVIEWED)) for (const entry of Object.values(categories)) expect(entry!.covered).toMatch(/^(lineage|driver-internal)\b/);
  });

  it("every server send of a turn takes a BuiltPrompt: sendProjectUsageTurn's input is contracts.ts BuiltSendTurnInput, unwrapped once by fencedTurnInput", () => {
    const index = readFileSync(join(SERVER, "index.ts"), "utf8");
    // (a Cloud home first checks its execution gate, which refuses before anything is sent: the Cloud line's requireOpen)
    expect(index).toMatch(/async function sendProjectUsageTurn\(instance: ProviderInstance, built: BuiltSendTurnInput, fence: EngineFence\) \{\n(?:  homeExecutionGate\?\.requireOpen\(\);\n)?  let turn: SendTurnInput = fencedTurnInput\(built, fence\);/);
    expect(index).not.toMatch(/\btext: withNowLine\(/);
    const contracts = readFileSync(join(SERVER, "contracts.ts"), "utf8");
    expect(contracts).toMatch(/export type BuiltSendTurnInput = Omit<SendTurnInput, "text"> & \{ readonly prompt: import\("\.\/memory\/lineage-types\.ts"\)\.BuiltPrompt \};/);
  });

  it("the driver send types are the only place a BuiltPrompt becomes adapter text, and they run the send fence", () => {
    const engineInput = readFileSync(join(SERVER, "drivers/engine-input.ts"), "utf8");
    expect(engineInput).toMatch(/beforeSubmit: \(\) => \{ assertEngineInput\(fence, prompt\); beforeSubmit\?\.\(\); \}/);
    expect(engineInput).toMatch(/\(\) => \{ assertEngineInput\(fence, prompt\); beforeWrite\?\.\(\); \}/);
    const unwraps = sources().filter(file => /\bengineText\(/.test(codeLines(readFileSync(file, "utf8")).join("\n"))).map(file => relative(SERVER, file).split("\\").join("/"));
    expect(unwraps).toEqual(["drivers/engine-input.ts"]);
  });

  it("the S2 tool handlers return what they rest on: read-messages through turnToolText, bring-in with the running turn", () => {
    const tools = readFileSync(join(SERVER, "project-memory-tools.ts"), "utf8");
    expect(tools).toMatch(/return toolResult\(result, readMessagesToolText\(consuming, read\)\);/);
    expect(tools).toMatch(/botInitiated: true, turn: currentTurnLineage\(consuming\),/);
    const bringIn = readFileSync(join(SERVER, "memory/bring-in.ts"), "utf8");
    expect(bringIn).toMatch(/if \(input\.turn\) addTurnParents\(input\.turn, broughtRefs\);/);
    expect(bringIn).toMatch(/if \(input\.turn\) writeRecordLineage\(db, \{ kind: "record", id: recordId, version: 1, scopeId: room \}, input\.turn\);/);
  });
});
