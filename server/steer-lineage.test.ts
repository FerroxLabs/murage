import { useOutsideStoreFixture } from "./testing/outside-store-fixture.ts";
import { fixtureBotFolder } from "./testing/bot-folder-fixture.ts";
// A steer quoting a memory-derived reply discloses that reply to the running
// turn the moment its text is written to the engine. Fuigo acknowledges an
// interjection later (up to its budget); if the quote's source is revoked in
// between, the quote is withheld by the time the acknowledgement arrives. Its
// roots must still be on the running turn and its engine session, so the next
// write's session check resets the session. Through the real Fuigo driver and
// the fake ACP CLI, whose interjection echo (the acknowledgement) is delayed.
import { storeAnchorMessage } from "./memory/testing/anchor-message.ts";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { afterEach as thawAfterEach, beforeEach as thawBeforeEach } from "vitest";
import { thawRootSetWritesForTest } from "./memory/replay-lineage.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
// 1.0.2: this test models a 1.0.1 file (legacy root-set rows) for the read-time judge, which still decides legacy data until S6.
thawBeforeEach(() => thawRootSetWritesForTest(true));
thawAfterEach(() => thawRootSetWritesForTest(false));
import { DATA_DIR, ensureDirs } from "./config.ts";
import type { ProviderInstance } from "./contracts.ts";
import { closeDatabase, database } from "./database.ts";
import { createAcpDriver } from "./drivers/acp/core.ts";
import { recordEvents } from "./testing/events.ts";
import { fixtureEngineFence } from "./testing/mcp-admission-fixture.ts";
import ts from "typescript";
import { FuigoAgentDriver } from "./drivers/acp/fuigo.ts";
import { ClaudeDriver } from "./drivers/claude.ts";
import { InternalCapabilities } from "./internal-capabilities.ts";
import { saveMemoryCandidate } from "./memory/authority.ts";
import { buildMemoryBundle } from "./memory/bundle.ts";
import { captureBranchChange, captureSource } from "./memory/capture.ts";
import { MemoryDispatchReceipt, retainedSessionInvalid } from "./memory/dispatch.ts";
import { reconcileMemoryRoster, type MemoryRoster } from "./memory/policy.ts";
import { fixtureMemoryAccess as memoryAccess } from "./testing/recall-access-fixture.ts";
import { capturedMessageWithheld, recordSessionRoots, sessionOutputRoots } from "./memory/replay-lineage.ts";
import { setMemoryMode } from "./memory/repository.ts";
import { appendMessage } from "./message-db.ts";
import { denyLookup, sessionLookup } from "./memory/deny-read.ts";
import { closeTurnLineage, openTurnLineage, writeSessionLineage } from "./memory/lineage-write.ts";
import { stampFreshSession } from "./memory/testing/writetime-fixture.ts";
import { drainRevokeMarker } from "./memory/memory-revocation.ts";
import type { TurnLineage } from "./memory/lineage-types.ts";
import type { Message } from "./store.ts";
import { steerWithQuoteLineage, type RunningTurnLineage } from "./steer-lineage.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { LineageAllowance } from "./memory/lineage-allowance.ts";
import { bindFixtureTurn } from "./testing/consuming-fixture.ts";
import { fixtureBoundTurn } from "./testing/mcp-admission-fixture.ts";
import { fencedTurnInput } from "./drivers/engine-input.ts";
import { buildPrompt, noneRef, promptPart } from "./memory/prompt-parts.ts";

const FAKE_ACP = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-acp-cli.ts");
const posixOnly = describe.skipIf(process.platform === "win32");
const roster: MemoryRoster = { bots: [{ id: "bot", threadId: "chat", tasks: [{ threadId: "older" }, { threadId: "desk" }] }], groups: [] };
const registry = new InternalCapabilities();
const empty = { async search() { return { hits: [], vectorRows: 0, coverageComplete: false }; } };
const QUOTE = { threadId: "chat", id: "reply-1", role: "bot" };

function access() {
  registry.begin("bot", "chat", "g");
  return memoryAccess(registry, registry.resolve(`Bearer ${registry.mint({ botId: "bot", threadId: "chat", generation: "g", depth: 0, kind: "memory", skillAuthoring: false })}`)!, () => roster);
}

/** reply-1 (thread "chat", another branch) was made with a memory record
 * resting on thread "older"'s message m1: a permitted memory-derived reply. */
async function memoryDerivedReply() {
  const text = "The alarm code is 4812.";
  storeAnchorMessage(database(), "older", "m1", text, "user", 1);
  captureSource(database(), { id: "message:older:m1", threadId: "older", messageId: "m1", kind: "text", speaker: "owner", outcome: "recorded", text });
  const turn = access();
  const record = saveMemoryCandidate(text, [{ sourceId: "message:older:m1", revision: 1, startByte: 0, endByte: Buffer.byteLength(text) }], "k", turn);
  database().prepare("UPDATE memory_records SET state='active' WHERE id=?").run(record);
  const receipt = new MemoryDispatchReceipt(await buildMemoryBundle("", turn, empty, {allowance: LineageAllowance.tool()}), turn, "engine");
  receipt.sessionStarted("s1");
  receipt.noteLookup([{ id: record, version: 1, evidence: [{ sourceId: "message:older:m1", revision: 1 }] }], turn);
  receipt.accepted();
  receipt.output("reply-1");
  expect(capturedMessageWithheld(LineageAllowance.tool(1_000_000_000), "chat", "reply-1")).toBe(false);
}


// ---- the production (write-time, 1.0.2) path ----
const CONTENT = { audience: null } as const;
const wmsg = (id: string, extra: Partial<Message> = {}): Message => ({ id, role: "bot", kind: "text", text: id, at: Date.now(), ...extra });
const verdictOf = (thread: string, id: string) => denyLookup(database(), { threadId: thread, lines: [{ messageId: id, author: "generated" }] }, CONTENT).get(id)!;
const turns: TurnLineage[] = [];
const boundTurns = new WeakMap<TurnLineage, ReturnType<typeof bindFixtureTurn>>();
function openTurn(threadId: string, turnId: string): TurnLineage {
  const turn = openTurnLineage(database(), { threadId, turnId });
  boundTurns.set(turn, bindFixtureTurn(database(), turn, "bot"));
  turns.push(turn); return turn;
}
/** reply-1 (thread "chat") rests on a1, a bot line of thread "older": stored through appendMessage so both carry lineage rows. */
function writtenReply(text = "The alarm code is 4812.") {
  appendMessage("older", { ...wmsg("m1"), role: "user" });
  const t0 = openTurn("older", "t-older");
  appendMessage("older", wmsg("a1", { parentId: "m1", text }));
  closeTurnLineage(t0);
  const t1 = openTurn("chat", "t-chat");
  appendMessage("chat", wmsg("reply-1", { text }), undefined, undefined, [{ kind: "line", threadId: "older", messageId: "a1" }]);
  closeTurnLineage(t1);
  expect(verdictOf("chat", "reply-1").state).toBe("shown");
}
/** The source leaves its branch (an edit and resend in "older" abandons a1): reply-1 is withheld once the revoke marker drains. */
function revokeSource() {
  appendMessage("older", { ...wmsg("m1b"), role: "user" });
  expect(drainRevokeMarker(database()).pending).toBe(false);
  expect(verdictOf("chat", "reply-1").state).toBe("withheld");
}
const FUIGO_SESSION = { threadId: "desk", driverInstance: "fuigo-steer", nativeSession: "s-desk" };

let root: string;
let instance: ProviderInstance | undefined;
const savedAck = process.env.MURAGE_FUIGO_INTERJECT_ACK_MS;

beforeEach(() => {
  closeDatabase();
  removeTempDirSync(DATA_DIR);
  mkdirSync(DATA_DIR, { recursive: true });
  ensureDirs();
  setMemoryMode("active");
  reconcileMemoryRoster(roster);
  root = mkdtempSync(join(tmpdir(), "murage-steer-lineage-"));
  chmodSync(FAKE_ACP, 0o755);
});
afterEach(async () => {
  for (const turn of turns.splice(0)) closeTurnLineage(turn);
  if (savedAck === undefined) delete process.env.MURAGE_FUIGO_INTERJECT_ACK_MS; else process.env.MURAGE_FUIGO_INTERJECT_ACK_MS = savedAck;
  await instance?.dispose();
  instance = undefined;
  await removeTempDir(root);
});

/** A Fuigo turn on thread "desk", running and held; its interjection echo
 * (the acknowledgement) arrives `echoMs` after the write. */
async function runningFuigo(echoMs: number) {
  const home = join(root, "home");
  mkdirSync(join(home, ".fuigo"), { recursive: true });
  writeFileSync(join(home, ".fuigo", "auth.json"), "{}");
  const dump = join(root, "rpc.json");
  instance = await FuigoAgentDriver.create({
    instanceId: "fuigo-steer", displayName: "Fuigo", enabled: true,
    environment: {
      HOME: home,
      FAKE_ACP_MODE: "echo-gated",
      FAKE_ACP_GATE_FILE: join(root, "never.gate"),
      FAKE_ACP_RPC_DUMP: dump,
      FAKE_ACP_INTERJECT: "silent",
      FAKE_ACP_LATE_ECHO_MS: String(echoMs),
    },
    config: { cli: FAKE_ACP, fullAuto: false },
  });
  await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "desk", text: "Count the invoices" });
  // the fake engine rewrites its dump while this polls: a half-written file is "not yet", never a failure
  const prompted = () => { try { return existsSync(dump) && (JSON.parse(readFileSync(dump, "utf8")) as string[]).includes("session/prompt"); } catch { return false; } };
  for (let i = 0; i < 500 && !prompted(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(prompted()).toBe(true);
  // the running turn's lineage and its engine session (v6 marks every session it saw)
  const lineage: RunningTurnLineage = { roots: { roots: new Set(), over: false }, instanceId: "fuigo-steer", startGeneration: 0, session: "s-desk", generation: "g-desk", turn: { threadId: "desk", turnId: "t-desk", turnLsn: 0, parents: [] } as unknown as RunningTurnLineage["turn"] };
  recordSessionRoots("desk", "fuigo-steer", "s-desk", lineage.roots);
  const methods = (): string[] => { try { return JSON.parse(readFileSync(dump, "utf8")); } catch { return []; } };
  return { adapter: instance.adapter, lineage, methods };
}

posixOnly("a steer's quoted reply is recorded at the write, not after the acknowledgement", () => {
  it("rejects a stored-file steer without a hook even without a release binding", async () => {
    const quote = join(root, "quote.txt");
    writeFileSync(quote, "The sample total is seven.");
    const { adapter, methods } = await runningFuigo(300);
    expect(methods().filter(method => method === "session/prompt")).toHaveLength(1);
    expect(await adapter.steer!("desk", readFileSync(quote, "utf8"))).toBe("rejected");
    expect(methods().filter(method => method === "session/prompt")).toHaveLength(1);
    expect(methods()).not.toContain("_fuigo/interject");
  }, 30_000);

  it("a hook throwing MEMORY_CONTEXT_REVOKED refuses before any interjection write", async () => {
    const { adapter, methods } = await runningFuigo(300);
    let checked = 0;
    await expect(adapter.steer!("desk", "The sample total is seven.", () => {
      checked++;
      throw Object.assign(new Error("MEMORY_CONTEXT_REVOKED"), { code: "MEMORY_CONTEXT_REVOKED" });
    })).rejects.toMatchObject({ code: "MEMORY_CONTEXT_REVOKED" });
    expect(checked).toBe(1);
    expect(methods().filter(method => method === "session/prompt")).toHaveLength(1);
    expect(methods()).not.toContain("_fuigo/interject");
  }, 30_000);

  it("a stopped turn rejects a steer before consulting its hook", async () => {
    process.env.MURAGE_FUIGO_INTERJECT_ACK_MS = "400";
    const { adapter, methods } = await runningFuigo(300);
    const stopping = adapter.stopAll!();
    let checked = 0;
    try {
      expect(await adapter.steer!("desk", "The sample total is seven.", () => { checked++; })).toBe("rejected");
      expect(checked).toBe(0);
      expect(methods().filter(method => method === "session/prompt")).toHaveLength(1);
      expect(methods()).not.toContain("_fuigo/interject");
    } finally { await stopping; }
  }, 30_000);

  it("a withheld stored quote through steerWithQuoteLineage writes nothing", async () => {
    const text = "The sample total is seven.";
    writtenReply(text);
    const { adapter, lineage, methods } = await runningFuigo(300);
    const turn = openTurn("desk", "t-desk");
    revokeSource();
    expect(await steerWithQuoteLineage(adapter, "desk", `> ${text}\nUse the sample`, true, {
      holds: () => true, steerId: "withheld-quote", lineage, quote: QUOTE, turn,
    })).toBe("queue");
    expect(methods().filter(method => method === "session/prompt")).toHaveLength(1);
    expect(methods()).not.toContain("_fuigo/interject");
    expect(turn.parents).toEqual([]);
  }, 30_000);

  it("a quote whose source is revoked while Fuigo's acknowledgement is pending stays on the turn and session; the next check resets it", async () => {
    writtenReply();
    const { adapter, lineage, methods } = await runningFuigo(1200);
    const turn = openTurn("desk", "t-desk");
    writeSessionLineage(database(), FUIGO_SESSION, turn); // the session binds to the running turn
    let fenced = 0;
    const steering = steerWithQuoteLineage(adapter, "desk", "> The alarm code is 4812.\nUse it on the side door", true, {
      holds: () => { fenced++; return true; }, steerId: "steer-1", lineage, quote: QUOTE, turn,
    });
    // The fence ran (the quote's verdict was a proven allow) and the text was written; the acknowledgement is pending.
    expect(fenced).toBe(1);
    expect(turn.parents).toContainEqual({ kind: "line", threadId: "chat", messageId: "reply-1" });
    // reply-1's source leaves its branch while Fuigo has not answered yet.
    revokeSource();
    // A reply the turn persists now, before the acknowledgement, carries the quote through the turn's parents, so it is withheld like the quote itself.
    appendMessage("desk", wmsg("reply-2"));
    expect(verdictOf("desk", "reply-2").state).not.toBe("shown"); // held (checking: pending) at once, ...
    drainRevokeMarker(database());
    expect(verdictOf("desk", "reply-2").state).toBe("withheld"); // ... withheld once the revoke marker drains
    expect(await steering).toBe("steer");
    expect(methods().filter(method => method === "_fuigo/interject")).toHaveLength(1);
    expect(methods().filter(method => method === "session/prompt")).toHaveLength(1);
    // The engine has the quote: it stays on the turn (checked above) and reaches the session when the turn's session lineage is written.
    writeSessionLineage(database(), FUIGO_SESSION, turn);
    // The revocation validator (the next write's check) resets the session.
    expect(sessionLookup(database(), FUIGO_SESSION, CONTENT).state).not.toBe("shown");
  }, 30_000);

  it("an uncertain steer (no acknowledgement within the budget) counts as disclosed", async () => {
    process.env.MURAGE_FUIGO_INTERJECT_ACK_MS = "400";
    writtenReply();
    const { adapter, lineage } = await runningFuigo(5000);
    const turn = openTurn("desk", "t-desk");
    writeSessionLineage(database(), FUIGO_SESSION, turn);
    const steering = steerWithQuoteLineage(adapter, "desk", "Use it on the side door", true, { holds: () => true, steerId: "steer-2", lineage, quote: QUOTE, turn });
    revokeSource();
    expect(await steering).toBe("uncertain");
    // the engine may have the text: the quote stays on the turn and its session resets
    expect(turn.parents).toContainEqual({ kind: "line", threadId: "chat", messageId: "reply-1" });
    writeSessionLineage(database(), FUIGO_SESSION, turn);
    // The session carries the revoked quote from this write on. Its hold sits at the write's own slot, above every prompt already built
    // (revoke-commit.ts inheritMarks, 1.0.3 F2), so a read of the bare session row is "shown" until the walk marks it: the walk is what resets it.
    drainRevokeMarker(database());
    expect(sessionLookup(database(), FUIGO_SESSION, CONTENT).state).not.toBe("shown");
  }, 30_000);

  it("a steer the fence refuses writes nothing and records nothing", async () => {
    await memoryDerivedReply();
    const { adapter, lineage } = await runningFuigo(300);
    const delivery = await steerWithQuoteLineage(adapter, "desk", "Use it on the side door", true, { holds: () => false, steerId: "steer-3", lineage, quote: QUOTE, turn: openTurn("desk", "t-desk") });
    expect(delivery).toBe("queue");
    expect(lineage.roots.roots.size).toBe(0);
    expect(sessionOutputRoots(LineageAllowance.tool(1_000_000_000), "desk", "fuigo-steer", "s-desk").roots.size).toBe(0);
    captureBranchChange(database(), "older", null);
    stampFreshSession(database(), "desk", "fuigo-steer", "s-desk"); // the session as a 1.0.3 fresh start left it (S6 rule 26)
    expect(retainedSessionInvalid(LineageAllowance.tool(), "desk", "fuigo-steer", "s-desk")).toBe(false);
  }, 30_000);

  it("a quote whose source is revoked after its text was rendered, before the fence runs, is refused: nothing written, nothing recorded", async () => {
    await memoryDerivedReply();
    const { adapter, lineage, methods } = await runningFuigo(300);
    const delivery = await steerWithQuoteLineage(adapter, "desk", "> The alarm code is 4812.\nUse it on the side door", true, {
      // the session itself still holds; the quote's source is revoked in between
      holds: () => { captureBranchChange(database(), "older", null); return true; },
      steerId: "steer-4", lineage, quote: QUOTE,
      turn: openTurn("desk", "t-desk"),
    });
    // refused: the caller runs the line as its own turn, which renders the quote again
    expect(delivery).toBe("queue");
    await new Promise((r) => setTimeout(r, 500));
    expect(JSON.parse(readFileSync(join(root, "rpc.json"), "utf8")) as string[]).not.toContain("_fuigo/interject");
    expect(methods().filter(method => method === "session/prompt")).toHaveLength(1);
    expect(lineage.roots.roots.size).toBe(0);
    expect(sessionOutputRoots(LineageAllowance.tool(1_000_000_000), "desk", "fuigo-steer", "s-desk").roots.size).toBe(0);
  }, 30_000);
});

// Owners: this lane owns the ACP final writer and its isolated caller witnesses.
async function runningSteer() {
  const cli = join(root, "steer-engine.mjs");
  const dump = join(root, "steer-rpc.jsonl");
  writeFileSync(cli, `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
if (process.argv.includes("--version")) { console.log("Fixture 1.0.0"); process.exit(0); }
const out = frame => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\\n");
const update = update => out({ method: "session/update", params: { sessionId: "fixture-session", update } });
let held;
createInterface({ input: process.stdin }).on("line", line => {
  const frame = JSON.parse(line);
  appendFileSync(${JSON.stringify(dump)}, line + "\\n");
  const result = value => out({ id: frame.id, result: value });
  if (frame.method === "initialize") return result({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
  if (frame.method === "session/new") {
    result({ sessionId: "fixture-session" });
    update({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "steer", description: "Steer" }] });
    return;
  }
  if (frame.method === "session/prompt") {
    if (frame.params.prompt[0].text.startsWith("/steer ")) {
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "⏩ Steer queued for the active turn:" } });
      return result({ stopReason: "end_turn" });
    }
    held = frame.id;
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working" } });
    return;
  }
  if (frame.method === "session/cancel") { if (held) out({ id: held, result: { stopReason: "cancelled" } }); return; }
  if (frame.id !== undefined) result({});
});
`);
  chmodSync(cli, 0o755);
  const driver = createAcpDriver({
    driverKind: "customAcp", displayName: "Fixture", models: { default: "", options: [] },
    defaultCli: cli, nativeSource: "fixture.acp", loginNote: "fixture", spawnArgs: () => [],
    pickAuthMethod: () => null, authFailure: "continue", isAuthenticated: () => true,
    fluxReach: () => "elsewhere", ...{ steer: true },
  });
  instance = await driver.create({ instanceId: "steer-fixture", displayName: "Fixture", enabled: true,
    environment: { HOME: root, USERPROFILE: root }, config: { cli, fullAuto: false } });
  const recorder = recordEvents(instance.adapter);
  try {
    await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "desk", text: "work" });
    await recorder.until(event => event.type === "content.delta", 15_000);
  } finally { recorder.stop(); }
  const frames = (): Array<{ method: string; params?: { prompt?: Array<{ text: string }> } }> => {
    try { return readFileSync(dump, "utf8").trim().split("\n").map(line => JSON.parse(line)); } catch { return []; }
  };
  const prompts = () => frames().filter(frame => frame.method === "session/prompt");
  expect(prompts()).toHaveLength(1);
  expect(instance.adapter.steer).toBeTypeOf("function");
  return { adapter: instance.adapter, prompts };
}

posixOnly("ACP steer final writer", () => {
  it("rejects a stored-file steer without a hook or release binding", async () => {
    const { adapter, prompts } = await runningSteer();
    const stored = join(root, "stored-quote.txt");
    writeFileSync(stored, "The sample total is seven.");
    expect(await adapter.steer!("desk", readFileSync(stored, "utf8"))).toBe("rejected");
    expect(prompts()).toHaveLength(1);
  });

  it("a final hook refusal leaves the original turn running and a real passing fence still writes", async () => {
    const { adapter, prompts } = await runningSteer();
    let checked = 0;
    expect(await adapter.steer!("desk", "The sample total is seven.", () => {
      if (++checked === 2) throw new Error("MEMORY_CONTEXT_REVOKED");
    })).toBe("rejected");
    expect(checked).toBe(2);
    expect(prompts()).toHaveLength(1);
    expect(adapter.hasSession!("desk")).toBe(true);
    const text = "Use the blue folder";
    const input = fencedTurnInput({ threadId: "desk", prompt: buildPrompt(undefined, [promptPart(text, [noneRef("owner-turn")])]) },
      fixtureEngineFence("desk"));
    expect(await adapter.steer!("desk", text, input.beforeSubmit)).toBe("delivered");
    expect(prompts().map(frame => frame.params!.prompt![0]!.text)).toEqual([expect.stringContaining("work"), `/steer ${text}`]);
  });

  it("a hook throwing a coded revocation refuses without writing", async () => {
    const { adapter, prompts } = await runningSteer();
    const revoked = Object.assign(new Error("MEMORY_CONTEXT_REVOKED"), { code: "MEMORY_CONTEXT_REVOKED" });
    await expect(adapter.steer!("desk", "The sample total is seven.", () => { throw revoked; })).rejects.toBe(revoked);
    expect(prompts()).toHaveLength(1);
  });

  it("a withheld quote through steerWithQuoteLineage never writes", async () => {
    writtenReply("The sample total is seven.");
    const { adapter, prompts } = await runningSteer();
    const turn = openTurn("desk", "t-desk");
    revokeSource();
    expect(await steerWithQuoteLineage(adapter, "desk", "> The sample total is seven.", true, {
      holds: () => true, lineage: undefined, quote: QUOTE, turn,
    })).toBe("queue");
    expect(prompts()).toHaveLength(1);
    expect(turn.parents).toEqual([]);
  });

  it("Stop precedes the steer hook", async () => {
    const { adapter, prompts } = await runningSteer();
    const stopping = adapter.stopAll!();
    let checked = 0;
    try {
      expect(await adapter.steer!("desk", "The sample total is seven.", () => { checked++; })).toBe("rejected");
      expect(checked).toBe(0);
      expect(prompts()).toHaveLength(1);
    } finally { await stopping; }
  });

  it("maps only the skipped-write missing-hook error to rejected", async () => {
    const { acpTurnSteering } = await import("./drivers/acp/steer.ts");
    for (const [error, outcome] of [[new Error("MEMORY_CONTEXT_REVOKED"), "rejected"], [new Error("unrelated"), "uncertain"]] as const) {
      const steering = acpTurnSteering({ running: () => true, send: async () => { throw error; } });
      expect(await steering.steer("The sample total is seven.")).toBe(outcome);
    }
    const revoked = Object.assign(new Error("MEMORY_CONTEXT_REVOKED"), { code: "MEMORY_CONTEXT_REVOKED" });
    const steering = acpTurnSteering({ running: () => true, send: async () => { throw revoked; } });
    await expect(steering.steer("The sample total is seven.")).rejects.toBe(revoked);
  });

  it("keeps both final halt checks, normal submission, and exactly one steer request caller", () => {
    const source = readFileSync(new URL("./drivers/acp/core.ts", import.meta.url), "utf8");
    expect(source.replace(/\s+/g, " ")).toContain(`if (steerWrite) return emitEngineWire(beforeWrite, wire, write, () => {
      if (turnHalted()) throw new Error("ACP_TURN_STOPPED");
      if (!beforeWrite) throw new Error("MEMORY_CONTEXT_REVOKED");
      beforeWrite();
    });
    return fencedSubmit(turn, write, wire, () => {
      if (turnHalted()) throw new Error("ACP_TURN_STOPPED");
      fenceBeforeWrite(fence, state, obj, settleHalted);
    });
    } catch (error) { if (!steerWrite) submissionRefused = true; throw error; }`.replace(/\s+/g, " "));
    expect(source).toContain('interjectUnsupported || turnHalted() || !state.promptSent || !sessionId');
    expect(source).toContain("steerWrite = false,\n        ) =>");
    expect(source).toContain('}, method === "session/prompt" && !steerWrite ? turn.beforeSubmit : beforeWrite, steerWrite));');
    const tree = ts.createSourceFile("core.ts", source, ts.ScriptTarget.Latest, true);
    const callers: string[] = [];
    const walk = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(tree) === "request" && node.arguments[8]?.kind === ts.SyntaxKind.TrueKeyword) callers.push(node.getText(tree));
      ts.forEachChild(node, walk);
    };
    walk(tree);
    expect(callers).toEqual(['request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }, undefined, acpPromptIdleTimeoutMs(), undefined, undefined, undefined, beforeWrite, true)']);
  });
});

// A stand-in Claude CLI that sends `init` only once the gate file exists, so a
// steer sent before then waits in the driver's pre-init queue. It logs every
// user line it receives.
const SLOW_INIT_CLAUDE = `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("2.1.292 (Claude Code)"); process.exit(0); }
const fs = require("node:fs");
const out = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
const log = (line) => fs.appendFileSync(process.env.STEER_LINEAGE_LOG, line + "\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type !== "user") continue;
    const text = typeof msg.message.content === "string" ? msg.message.content : JSON.stringify(msg.message.content);
    log("recv:" + text);
    if (!text.includes("SLOW_INIT")) continue;
    const gate = setInterval(() => {
      if (!fs.existsSync(process.env.STEER_LINEAGE_GATE)) return;
      clearInterval(gate);
      out({ type: "system", subtype: "init", session_id: "claude-session", model: "mini" });
      setTimeout(() => {
        out({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } });
        out({ type: "result", is_error: false, stop_reason: "end_turn", total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
      }, 300);
    }, 20);
  }
});
`;

posixOnly("a Claude steer that waits for init is checked against its quote at the write", () => {
  it("a quote whose source is revoked while the steer is queued before init is never written, and nothing is recorded", async () => {
    writtenReply();
    const cli = join(root, "slow-init-claude");
    writeFileSync(cli, SLOW_INIT_CLAUDE, { mode: 0o755 });
    const log = join(root, "claude.log");
    const gate = join(root, "init.gate");
    process.env.STEER_LINEAGE_LOG = log;
    process.env.STEER_LINEAGE_GATE = gate;
    try {
      instance = await ClaudeDriver.create({
        instanceId: "claude-steer", displayName: "Claude", environment: {}, enabled: true,
        config: { cli, permissionMode: "acceptEdits" },
      });
      const lines = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
      const turn = openTurn("desk", "t-desk");
      // Initial owner text carries no stored source. Only an accepted quote
      // may add a parent to the retained turn exercised below.
      const initial = fencedTurnInput({ cwd: fixtureBotFolder(), threadId: "desk", warmIdentity: { botId: "bot", audience: "owner" }, releaseBinding: boundTurns.get(turn)!.binding,
        prompt: buildPrompt(undefined, [promptPart("one SLOW_INIT", [noneRef("owner-turn")])]),
      }, { db: database(), retained: turn, reader: CONTENT });
      await instance.adapter.sendTurn(fixtureBoundTurn(initial));
      const lineage: RunningTurnLineage = { roots: { roots: new Set(), over: false }, instanceId: "claude-steer", startGeneration: 0, session: "claude-session", generation: "g-claude", turn: { threadId: "desk", turnId: "t-claude", turnLsn: 0, parents: [] } as unknown as RunningTurnLineage["turn"] };
      const session = { threadId: "desk", driverInstance: "claude-steer", nativeSession: "claude-session" };
      writeSessionLineage(database(), session, turn);
      let fenced = 0;
      const steering = steerWithQuoteLineage(instance.adapter, "desk", "> The alarm code is 4812.\nSTEER use it on the side door", true, {
        holds: () => { fenced++; return true; }, steerId: "steer-c", lineage, quote: QUOTE, turn,
      });
      // queued before init: the fence has not run and nothing is written
      for (let i = 0; i < 1000 && lines().length < 1; i++) await new Promise((r) => setTimeout(r, 10));
      // The fake CLI never answers the MCP status request, so the turn can carry Murage's "may still have been loading" line for its
      // required servers (the approvals broker is one since 1.0.4) ahead of the text; the text itself arrives unchanged.
      expect(lines().join("\n")).toMatch(/^recv:(\[Murage: [^\n]*\]\n)?one SLOW_INIT$/);
      expect(fenced).toBe(0);
      // reply-1's source leaves its branch while the steer waits
      revokeSource();
      // init arrives and the queued steer is flushed: refused at its fence,
      // so the caller runs the line as its own turn
      writeFileSync(gate, "");
      expect(await steering).toBe("queue");
      // 1.0.2: the write-time send fence (memory/dispatch.ts assertSendFence) sees the withheld quote and refuses before the legacy session
      // fence (`holds`) is even asked, so `fenced` stays 0; nothing was written
      expect(fenced).toBe(0);
      await new Promise((r) => setTimeout(r, 400));
      expect(lines().some((line) => line.includes("4812") || line.includes("STEER"))).toBe(false);
      // nothing recorded: the quote never joined the turn, so its replies and session stay clean
      expect(turn.parents).toEqual([]);
      appendMessage("desk", wmsg("reply-2"));
      expect(verdictOf("desk", "reply-2").state).toBe("shown");
      writeSessionLineage(database(), session, turn);
      expect(sessionLookup(database(), session, CONTENT).state).toBe("shown");
    } finally {
      delete process.env.STEER_LINEAGE_LOG;
      delete process.env.STEER_LINEAGE_GATE;
    }
  }, 30_000);
});

useOutsideStoreFixture();
