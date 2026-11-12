// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import { removeTempDirSync } from "./testing/cleanup.ts";

const gates = vi.hoisted(() => ({ quote: "shown", door: true, reader: "shown", memory: "shown" }));
vi.mock("./memory/replay-lineage.ts", async importOriginal => ({
  ...await importOriginal<typeof import("./memory/replay-lineage.ts")>(),
  messageSourceForgotten: () => false,
  capturedMessageVerdict: () => ({ withheld: gates.quote === "withheld", unproven: gates.quote === "unknown" }),
}));
vi.mock("./bot-read.ts", async importOriginal => ({
  ...await importOriginal<typeof import("./bot-read.ts")>(),
  rowsShown: (_db: unknown, _viewer: unknown, batch: unknown[]) => batch.map(() => gates.door),
}));
vi.mock("./memory/deny-read.ts", async importOriginal => {
  const real = await importOriginal<typeof import("./memory/deny-read.ts")>();
  const verdict = (state: string) => {
    if (state === "throw") throw new Error("LOOKUP_TEXT_ID_SENTINEL");
    return state === "shown" ? { state: "shown" } as const : state === "checking" ? { state: "checking", reason: "pending" } as const : { state: "withheld", reason: "deny-line" } as const;
  };
  return { ...real,
    denyLookup: (_db: unknown, page: { lines: { messageId: string }[] }) => new Map(page.lines.map(line => [line.messageId, verdict(gates.reader)])),
    memoryLookup: (_db: unknown, refs: import("./memory/lineage-types.ts").MemoryRef[]) => new Map(refs.map(ref => [memoryRefKey(ref), verdict(gates.memory)])),
  };
});
import { memoryRefKey } from "./memory/lineage-types.ts";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { appendMessage } from "./message-db.ts";
import { workingContextBlock, type WorkingContextInput } from "./working-context.ts";
import { LineageAllowance } from "./memory/lineage-allowance.ts";
import { recoveryNote } from "./memory/fence-recovery.ts";

let input: WorkingContextInput;
let serial = 0;
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  Object.assign(gates, { quote: "shown", door: true, reader: "shown", memory: "shown" });
  input = { botId: "fixture", currentThreadId: "direct", now: Date.now(), bots: [{ id: "fixture", threadId: "direct", tasks: [{ threadId: "THREAD_ID_SENTINEL", title: "Task" }] }], groups: [], routines: [] };
});
const say = (withheld = false) => appendMessage("THREAD_ID_SENTINEL", { id: `MESSAGE_ID_SENTINEL-${++serial}`, role: "bot", kind: "text", text: "REMEMBERED_TEXT_SENTINEL", at: input.now - 1000, ...(withheld ? { withheldFromBots: "forgotten" as const } : {}) });
const build = () => workingContextBlock(LineageAllowance.tool(1_000_000_000), true, input, database(), { audience: { owner: true, scopeIds: [] } });

it.each(["stored", "lineage", "unproven", "door", "reader-withheld", "reader-checking", "reader-throw"])("A7 counts-only quote omission at %s survives an empty block", gate => {
  say(gate === "stored");
  if (gate === "lineage") gates.quote = "withheld";
  if (gate === "unproven") gates.quote = "unknown";
  if (gate === "door") gates.door = false;
  if (gate.startsWith("reader-")) gates.reader = gate.slice(7);
  const info = vi.spyOn(console, "info");
  const block = build();
  expect(block.text).toBe(""); expect(block.quoted).toEqual([]);
  const cause = gate === "reader-checking" ? "checking" : ["door", "unproven", "reader-throw"].includes(gate) ? "unknown" : "changed";
  expect(block.omissions).toEqual({ checking: Number(cause === "checking"), changed: Number(cause === "changed"), unknown: Number(cause === "unknown") });
  expect(recoveryNote(0, { omitted: Object.values(block.omissions).reduce((a, b) => a + b, 0), cause })?.line).toBe("Murage left remembered details out of this reply.");
  expect(JSON.stringify(block.omissions)).not.toMatch(/SENTINEL/);
  expect(JSON.stringify(info.mock.calls)).not.toMatch(/SENTINEL/);
  info.mockRestore();
});

it.each(["withheld", "checking", "throw"])("A7 counts-only file omission at %s", state => {
  say();
  gates.memory = state;
  database().prepare("INSERT INTO artifacts(id,name,kind,mime,bytes,sha256,extension,created_at,bot_id,thread_id,run_id,source_root,relative_path,source_fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("ARTIFACT_ID_SENTINEL", "FILE_TEXT_SENTINEL.md", "document", "text/markdown", 10, "0".repeat(64), ".md", input.now, "fixture", "THREAD_ID_SENTINEL", "run", "root", "FILE_TEXT_SENTINEL.md", "fp");
  const block = build();
  expect(block.text).toContain("REMEMBERED_TEXT_SENTINEL"); expect(block.text).not.toContain("FILE_TEXT_SENTINEL");
  expect(block.omissions).toEqual({ checking: Number(state === "checking"), changed: Number(state === "withheld"), unknown: Number(state === "throw") });
});

it("A7 a shown or audience-suppressed block owes no omission notice", () => {
  say();
  expect(build().omissions).toEqual({ checking: 0, changed: 0, unknown: 0 });
  const hidden = workingContextBlock(LineageAllowance.tool(), false, input, database());
  expect(hidden.omissions).toEqual({ checking: 0, changed: 0, unknown: 0 });
});


it.each(["withheld", "checking", "throw"])("A7 counts-only project-card omission at %s", async state => {
  const { channelToProjectRows } = await import("./project-settings.ts");
  const { createProjectCard } = await import("./project-cards.ts");
  input.groups = [{ id: "project", name: "Fixture", threadId: "project-chat", memberIds: ["fixture"], channelProject: { goal: "Fixture" } }];
  channelToProjectRows(database(), { groupId: "project", bulletin: "", leadBotId: "fixture", now: input.now });
  const made = createProjectCard(database(), { groupId: "project", title: "CARD_TEXT_SENTINEL", assigneeBotId: "fixture", actor: { kind: "owner" }, memberIds: ["fixture"], now: input.now });
  expect(made.ok).toBe(true);
  gates.memory = state;
  const block = build();
  expect(block.text).not.toContain("CARD_TEXT_SENTINEL");
  expect(block.omissions).toEqual({ checking: Number(state === "checking"), changed: Number(state === "withheld"), unknown: Number(state === "throw") });
});

it("A7 two rejecting quote doors count one omission and a later build asks afresh", () => {
  say(); gates.door = false; gates.reader = "checking";
  expect(build().omissions).toEqual({ checking: 1, changed: 0, unknown: 0 });
  gates.door = true; gates.reader = "shown";
  expect(build().omissions).toEqual({ checking: 0, changed: 0, unknown: 0 });
});


it("A7 an ineligible file owes no omission note", () => {
  say();
  input.bots = [{ id: "fixture", threadId: "direct", tasks: [] }];
  gates.memory = "withheld";
  database().prepare("INSERT INTO artifacts(id,name,kind,mime,bytes,sha256,extension,created_at,bot_id,thread_id,run_id,source_root,relative_path,source_fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("ARTIFACT_ID_SENTINEL", "FILE_TEXT_SENTINEL.md", "document", "text/markdown", 10, "0".repeat(64), ".md", input.now, "fixture", "THREAD_ID_SENTINEL", "run", "root", "FILE_TEXT_SENTINEL.md", "fp");
  const block = build();
  expect(block.text).toBe("");
  expect(block.omissions).toEqual({ checking: 0, changed: 0, unknown: 0 });
});
