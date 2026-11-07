// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// HL-S2: the production HighLevel runtime, read only (MurageMain 11-04). Every test fails on the base (int/1015
// b47ece583), which had no runtime. The harness stores the older "propose" grant with all twenty tools, as data saved
// before the cut would, so each test also shows that such a grant reads as read.
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HIGHLEVEL_HELPER_NAMES, HIGHLEVEL_READ_TOOL_NAMES, HIGHLEVEL_WRITE_TOOLS, readOnlyHighLevelAccess } from "../../shared/highlevel.ts";
import { OWN_UNASKED, PHONE_PREALLOWED, isOwnQuiet, isOwnUnasked } from "../../shared/own-servers.ts";
import { HERMES_OWN_UNASKED_TOOLS } from "../drivers/acp/hermes.ts";
import { claudeOwnUnaskedTools } from "../drivers/claude.ts";
import { GATE_UNASKED } from "../drivers/pi-permission-gate.ts";
import { highLevelHarness, scriptCrm } from "../testing/fake-highlevel.ts";
import { HighLevelActions, type ActionIntent, type ActionJournal } from "./actions.ts";
import { FileActionJournal, defaultHighLevelJournalFile } from "./journal-file.ts";
import { HIGHLEVEL_NOT_CONNECTED, createHighLevelRuntime, ownerReadGrant } from "./runtime.ts";

function runtime(options: { dataDir?: string; connected?: boolean } = {}) {
  const h = highLevelHarness();
  scriptCrm(h.api);
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), "hl-s2-"));
  const puts: ActionIntent[] = [];
  const journal: ActionJournal = { put: (intent) => { puts.push(intent); }, delete: () => {}, all: () => [] };
  const rt = createHighLevelRuntime({
    dataDir, capabilities: h.capabilities, signals: h.signals, bot: (id) => (id === h.bot.id ? h.bot : undefined), journal,
    ...(options.connected === false ? {} : { leases: h.leases }), fetch: h.api.fetch,
  });
  return { h, rt, puts, dataDir };
}

const WRITES = [...HIGHLEVEL_WRITE_TOOLS] as string[];
const listed = async (rt: ReturnType<typeof runtime>["rt"], h: ReturnType<typeof runtime>["h"]) => {
  const reply = await rt.host.handle(h.claim, { jsonrpc: "2.0", id: 1, method: "tools/list" }) as { result?: { tools: { name: string }[] } };
  return (reply.result?.tools ?? []).map((tool) => tool.name);
};

describe("HL-S2: production HighLevel stays closed until a location is connected", () => {
  it("with no connection source every call answers not connected and nothing reaches the network", async () => {
    const { h, rt } = runtime({ connected: false });
    const read = await rt.host.call(h.claim, "HIGHLEVEL_SEARCH_CONTACTS", { query: "ada" });
    expect(read.isError).toBe(true);
    expect(h.api.requests).toHaveLength(0);
    expect(await rt.mountsFor(h.bot.id)).toBe(false);
    await expect(rt.leases.lease({ requestId: "r1", connectionId: "hl_conn_1", connectionEpoch: 1, reason: "use" })).rejects.toThrow(HIGHLEVEL_NOT_CONNECTED);
  });

  it("mounts only for a bot with a native grant on a live connection and connected apps on", async () => {
    const { h, rt } = runtime();
    expect(await rt.mountsFor(h.bot.id)).toBe(true);
    h.bot.composio = false;
    expect(await rt.mountsFor(h.bot.id)).toBe(false);
    h.bot.composio = true;
    h.leases.views.get("hl_conn_1")!.state = "needs_reconnect";
    expect(await rt.mountsFor(h.bot.id)).toBe(false);
    expect(await rt.mountsFor("bot_unknown")).toBe(false);
  });
});

describe("HL-S2 is read only: no change reaches HighLevel", () => {
  it("no change tool reaches any engine, Fuigo first: the host lists only reads and no engine pre-allows a change", async () => {
    const { h, rt } = runtime();
    // Fuigo, Flux Router, Codex, Pi and every other ACP or MCP engine get their HighLevel tools from this one tools/list
    const names = await listed(rt, h);
    expect(names).toEqual([...HIGHLEVEL_READ_TOOL_NAMES, ...HIGHLEVEL_HELPER_NAMES]);
    expect(names.some((name) => WRITES.includes(name))).toBe(false);
    // ACP (Fuigo, Grok, Codex ACP) and every own-map engine: a change name is never unasked or quiet
    for (const tool of WRITES) { expect(isOwnUnasked("own:highlevel", tool)).toBe(false); expect(isOwnQuiet("own:highlevel", tool)).toBe(false); }
    const rows = [...OWN_UNASKED, ...PHONE_PREALLOWED].filter((row) => row.mount === "own:highlevel").flatMap((row) => row.tools);
    expect(rows.some((tool) => WRITES.includes(tool))).toBe(false);
    // Claude, Hermes and Pi pre-allow lists
    expect(claudeOwnUnaskedTools("highlevel").some((tool) => WRITES.some((write) => tool.endsWith(`__${write}`)))).toBe(false);
    expect(HERMES_OWN_UNASKED_TOOLS.some((tool) => WRITES.some((write) => tool.endsWith(`__${write}`)))).toBe(false);
    expect(GATE_UNASKED.filter(([mount]) => mount === "own:highlevel").flatMap(([, tools]) => tools).some((tool) => WRITES.includes(tool))).toBe(false);
  });

  it("a change call is refused before anything is recorded or sent, even under an older stored change grant", async () => {
    const { h, rt, puts } = runtime();
    expect(h.bot.highlevelAccess).toMatchObject({ grants: [{ ceiling: "propose" }] });
    for (const tool of WRITES) {
      const result = await rt.host.call(h.claim, tool as never, { contactId: "contact_1", body: "x", name: "x", tags: ["x"], title: "x" });
      expect(result.isError).toBe(true);
    }
    // a well-formed change is refused by the grant itself, not by argument checks: the read-only view holds no change tool
    const note = await rt.host.call(h.claim, "HIGHLEVEL_ADD_NOTE", { contactId: "contact_1", body: "approved text" });
    expect(note.structuredContent).toMatchObject({ code: "not_granted" });
    expect(puts).toHaveLength(0);
    expect(h.api.requests.filter((request) => request.method !== "GET")).toHaveLength(0);
  });

  it("an old stored change grant reads as read: reads still work and the grant shows as read", async () => {
    const { h, rt } = runtime();
    const read = await rt.host.call(h.claim, "HIGHLEVEL_SEARCH_CONTACTS", { query: "ada" });
    expect(read.isError).not.toBe(true);
    const view = readOnlyHighLevelAccess(h.bot.highlevelAccess) as { grants: { ceiling: string; tools: string[] }[] };
    expect(view.grants).toEqual([expect.objectContaining({ ceiling: "read", tools: [...HIGHLEVEL_READ_TOOL_NAMES] })]);
    // a stored grant holding only change tools grants nothing at all
    h.saveAccess([{ ...h.grant(), tools: ["HIGHLEVEL_ADD_NOTE"] }]);
    expect((readOnlyHighLevelAccess(h.bot.highlevelAccess) as { grants: unknown[] }).grants).toEqual([]);
    expect(await rt.mountsFor(h.bot.id)).toBe(false);
    expect(await listed(rt, h)).toEqual([]);
  });

  it("the owner route refuses a change grant: only read with read tools is saved", () => {
    const input = { connectionId: "hl_conn_1", botId: "bot_1", revision: 2 };
    expect(ownerReadGrant({ ceiling: "propose", tools: [...HIGHLEVEL_READ_TOOL_NAMES] }, input)).toEqual({ ok: false, error: "HighLevel access is read only." });
    expect(ownerReadGrant({ ceiling: "read", tools: ["HIGHLEVEL_SEARCH_CONTACTS", "HIGHLEVEL_ADD_NOTE"] }, input).ok).toBe(false);
    expect(ownerReadGrant({ ceiling: "read", tools: [] }, input).ok).toBe(false);
    expect(ownerReadGrant({ tools: ["HIGHLEVEL_SEARCH_CONTACTS"] }, input).ok).toBe(false);
    expect(ownerReadGrant({ ceiling: "read", tools: [...HIGHLEVEL_READ_TOOL_NAMES] }, input)).toEqual({ ok: true,
      grant: { toolkit: "highlevel", accountId: "hl_conn_1", tools: [...HIGHLEVEL_READ_TOOL_NAMES], botId: "bot_1", revision: 2, ceiling: "read" } });
  });
});

describe("HL-S2: the action journal library stays durable for the later change slice", () => {
  it("a change that was being sent when the app stopped becomes outcome_unknown, never resent", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hl-s2-"));
    const journal = new FileActionJournal(defaultHighLevelJournalFile(dataDir));
    let now = 1_800_000_000_000;
    const actions = new HighLevelActions({ journal, now: () => now });
    const context = { botId: "bot_1", threadId: "thread_1", turnGeneration: "gen_1", connectionId: "hl_conn_1", connectionEpoch: 1, locationId: "loc", companyId: "co",
      grantRevision: 1, accessRevision: 1, policyRevision: 0, roleBinding: "r" };
    const review = actions.propose(context, "HIGHLEVEL_ADD_NOTE", { contactId: "c1", body: "x" }, { recordRefs: ["contactId:c1"], fields: ["body"] });
    actions.approve(review.actionId, review.reviewDigest);
    actions.beginDispatch(review.actionId, context);
    actions.recordAttempt(review.actionId, 1, context);
    now += 1;
    const after = new HighLevelActions({ journal: new FileActionJournal(defaultHighLevelJournalFile(dataDir)), now: () => now });
    after.recover();
    expect(after.get(review.actionId)).toMatchObject({ phase: "outcome_unknown", outcomeCode: "interrupted_after_send" });
  });

  it("a torn last line is skipped; a damaged journal holds changes while reads still work", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hl-s2-"));
    const file = defaultHighLevelJournalFile(dataDir);
    new FileActionJournal(file);
    appendFileSync(file, "{\"v\":1,\"put\":{\"actionId\":\"hla_");
    expect(new FileActionJournal(file).all()).toEqual([]);

    writeFileSync(file, "not json\n{\"v\":1,\"delete\":\"hla_x\"}\n");
    const held: unknown[] = [];
    const h = highLevelHarness();
    scriptCrm(h.api);
    const rt = createHighLevelRuntime({ dataDir, capabilities: h.capabilities, signals: h.signals, bot: (id) => (id === h.bot.id ? h.bot : undefined),
      leases: h.leases, fetch: h.api.fetch, onJournalHeld: (error) => { held.push(error); } });
    expect(rt.journalHeld).toBe(true);
    expect(held).toHaveLength(1);
    const write = await rt.host.call(h.claim, "HIGHLEVEL_ADD_NOTE", { contactId: "contact_1", body: "x" });
    expect(write.isError).toBe(true);
    expect(h.api.calls("POST", /\/notes$/u)).toHaveLength(0);
    const read = await rt.host.call(h.claim, "HIGHLEVEL_SEARCH_CONTACTS", { query: "ada" });
    expect(read.isError).not.toBe(true);
  });

  it("compaction keeps the log bounded and the rows intact", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hl-s2-"));
    const file = defaultHighLevelJournalFile(dataDir);
    const journal = new FileActionJournal(file);
    const actions = new HighLevelActions({ journal });
    const context = { botId: "bot_1", threadId: "thread_1", turnGeneration: "gen_1", connectionId: "hl_conn_1", connectionEpoch: 1, locationId: "loc", companyId: "co",
      grantRevision: 1, accessRevision: 1, policyRevision: 0, roleBinding: "r" };
    for (let i = 0; i < 400; i++) {
      const review = actions.propose({ ...context, turnGeneration: `gen_${i}` }, "HIGHLEVEL_ADD_NOTE", { contactId: "c1", body: `n${i}` }, { recordRefs: [], fields: ["body"] });
      actions.deny(review.actionId);
    }
    const lines = readFileSync(file, "utf8").trim().split("\n").length;
    expect(lines).toBeLessThanOrEqual(400 * 2 + 256 + 1);
    expect(new FileActionJournal(file).all()).toHaveLength(400);
  });
});

describe("HL-S2: native HighLevel mounts on the owner's own direct turns only", () => {
  // HL-RO allow gate (1.0.17): the deny list is gone; one allow proof, judged once at admission, is the only guard
  it("the mount reads only highlevelProof, and there is exactly one mount", () => {
    const index = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    expect(index.match(/integrations\.highlevel = /g) ?? []).toHaveLength(1);
    expect(index).toContain("if (highlevelProof && highlevelEngine && await highlevel.mountsFor(bot.id)) {\n        integrations.highlevel = highlevelIntegration(bot.id, threadId, dispatchClaimId);");
    expect(index).not.toContain("highlevelOwnTurn");
    expect(index.match(/const highlevelProof = rebuiltFromProven && highlevelOwnerTurn\(/g) ?? []).toHaveLength(1);
    expect(index.match(/highlevelOwnerTurn\(/g) ?? []).toHaveLength(1);
  });

  it("the ticket is minted once, as a startTurn argument in runIt, and read once by the proof", () => {
    const index = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    expect(index.match(/HL_OWNER_TICKET/g) ?? []).toHaveLength(4); // declaration, opts type, the runIt startTurn, the proof
    expect(index.match(/hlTicket: HL_OWNER_TICKET/g) ?? []).toHaveLength(1);
    expect(index).toMatch(/const message = await startTurn\(bot\.id, text, \{ threadId, replyTo, sendId, origin, [^\n]*\.\.\.\(hlOwnerLine \? \{ hlTicket: HL_OWNER_TICKET \} : \{\}\) \}\);/);
    expect(index).toContain("ticket: opts?.hlTicket, ownerTicket: HL_OWNER_TICKET,");
    // Astra hlro5 H1: a limit failover resend (the only send with phoneCarry) replays persisted text, maybe an edit's: never minted
    expect(index).toContain("&& phoneCarry === undefined && currentAtStart.threadId === threadId;");
    // Astra hlro5 H2: a memory rebuild hands the same options on (the two re-dispatch literals stay exactly the spread the hand-off
    // structure lint and pm-sends r26 read), and is proven only when the turn it rebuilds was, so a failed proof is never upgraded
    expect(index.match(/startTurn\(botId, text, \{ \.\.\.opts, threadId, userMessage, memoryRedispatch: attempt, rebuildOf \}\)/g) ?? []).toHaveLength(2);
    expect(index).not.toContain("hlTicket: highlevelProof");
    expect(index).toContain("const rebuiltFromProven = rebuildOf === undefined || highlevelProvenRuns.delete(rebuildOf);");
    expect(index).toContain("const highlevelProof = rebuiltFromProven && highlevelOwnerTurn({");
    expect(index).toMatch(/if \(highlevelProof\) \{\n[^\n]*\n    highlevelProvenRuns\.add\(run\.generation\);\n  \}/);
    expect(index.match(/highlevelProvenRuns\.(add|delete)\(/g) ?? []).toHaveLength(4); // the record, the rebuild's read, the bound, the release
    // a released run leaves no proof behind (HL-S2-RO 1.0.18): the same release hook that clears ownerStartedRuns
    expect(index).toContain("directRuns.onReleased = (threadId, botId, generation) => { ownerStartedRuns.delete(generation); highlevelProvenRuns.delete(generation);");
    // the routine on the thread is read before the owner-send branch clears it
    const capture = index.indexOf("const routineLiveOnThread = routinePeerSources.has(threadId);");
    expect(capture).toBeGreaterThan(0);
    expect(capture).toBeLessThan(index.indexOf("    routinePeerSources.delete(threadId);"));
  });
});
