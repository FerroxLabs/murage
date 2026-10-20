// A steer quoting a memory-derived reply discloses that reply to the running
// turn the moment its text is written to the engine. Fuigo acknowledges an
// interjection later (up to its budget); if the quote's source is revoked in
// between, the quote is withheld by the time the acknowledgement arrives. Its
// roots must still be on the running turn and its engine session, so the next
// write's session check resets the session. Through the real Fuigo driver and
// the fake ACP CLI, whose interjection echo (the acknowledgement) is delayed.
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
import { FuigoAgentDriver } from "./drivers/acp/fuigo.ts";
import { ClaudeDriver } from "./drivers/claude.ts";
import { InternalCapabilities } from "./internal-capabilities.ts";
import { saveMemoryCandidate } from "./memory/authority.ts";
import { buildMemoryBundle } from "./memory/bundle.ts";
import { captureBranchChange, captureSource } from "./memory/capture.ts";
import { MemoryDispatchReceipt, retainedSessionInvalid } from "./memory/dispatch.ts";
import { memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./memory/policy.ts";
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
function openTurn(threadId: string, turnId: string): TurnLineage { const turn = openTurnLineage(database(), { threadId, turnId }); turns.push(turn); return turn; }
/** reply-1 (thread "chat") rests on a1, a bot line of thread "older": stored through appendMessage so both carry lineage rows. */
function writtenReply() {
  appendMessage("older", { ...wmsg("m1"), role: "user" });
  const t0 = openTurn("older", "t-older");
  appendMessage("older", wmsg("a1", { parentId: "m1", text: "The alarm code is 4812." }));
  closeTurnLineage(t0);
  const t1 = openTurn("chat", "t-chat");
  appendMessage("chat", wmsg("reply-1", { text: "The alarm code is 4812." }), undefined, undefined, [{ kind: "line", threadId: "older", messageId: "a1" }]);
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
  await instance.adapter.sendTurn({ threadId: "desk", text: "Count the invoices" });
  // the fake engine rewrites its dump while this polls: a half-written file is "not yet", never a failure
  const prompted = () => { try { return existsSync(dump) && (JSON.parse(readFileSync(dump, "utf8")) as string[]).includes("session/prompt"); } catch { return false; } };
  for (let i = 0; i < 500 && !prompted(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(prompted()).toBe(true);
  // the running turn's lineage and its engine session (v6 marks every session it saw)
  const lineage: RunningTurnLineage = { roots: { roots: new Set(), over: false }, instanceId: "fuigo-steer", session: "s-desk", generation: "g-desk", turn: { threadId: "desk", turnId: "t-desk", turnLsn: 0, parents: [] } as unknown as RunningTurnLineage["turn"] };
  recordSessionRoots("desk", "fuigo-steer", "s-desk", lineage.roots);
  return { adapter: instance.adapter, lineage };
}

posixOnly("a steer's quoted reply is recorded at the write, not after the acknowledgement", () => {
  it("a quote whose source is revoked while Fuigo's acknowledgement is pending stays on the turn and session; the next check resets it", async () => {
    writtenReply();
    const { adapter, lineage } = await runningFuigo(1200);
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
    const delivery = await steerWithQuoteLineage(adapter, "desk", "Use it on the side door", true, { holds: () => false, steerId: "steer-3", lineage, quote: QUOTE });
    expect(delivery).toBe("queue");
    expect(lineage.roots.roots.size).toBe(0);
    expect(sessionOutputRoots(LineageAllowance.tool(1_000_000_000), "desk", "fuigo-steer", "s-desk").roots.size).toBe(0);
    captureBranchChange(database(), "older", null);
    stampFreshSession(database(), "desk", "fuigo-steer", "s-desk"); // the session as a 1.0.3 fresh start left it (S6 rule 26)
    expect(retainedSessionInvalid(LineageAllowance.tool(), "desk", "fuigo-steer", "s-desk")).toBe(false);
  }, 30_000);

  it("a quote whose source is revoked after its text was rendered, before the fence runs, is refused: nothing written, nothing recorded", async () => {
    await memoryDerivedReply();
    const { adapter, lineage } = await runningFuigo(300);
    const delivery = await steerWithQuoteLineage(adapter, "desk", "> The alarm code is 4812.\nUse it on the side door", true, {
      // the session itself still holds; the quote's source is revoked in between
      holds: () => { captureBranchChange(database(), "older", null); return true; },
      steerId: "steer-4", lineage, quote: QUOTE,
    });
    // refused: the caller runs the line as its own turn, which renders the quote again
    expect(delivery).toBe("queue");
    await new Promise((r) => setTimeout(r, 500));
    expect(JSON.parse(readFileSync(join(root, "rpc.json"), "utf8")) as string[]).not.toContain("_fuigo/interject");
    expect(lineage.roots.roots.size).toBe(0);
    expect(sessionOutputRoots(LineageAllowance.tool(1_000_000_000), "desk", "fuigo-steer", "s-desk").roots.size).toBe(0);
  }, 30_000);
});

// A stand-in Claude CLI that sends `init` only once the gate file exists, so a
// steer sent before then waits in the driver's pre-init queue. It logs every
// user line it receives.
const SLOW_INIT_CLAUDE = `#!/usr/bin/env node
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
      await instance.adapter.sendTurn({ threadId: "desk", text: "one SLOW_INIT", warmIdentity: { botId: "bot", audience: "owner" } });
      const lineage: RunningTurnLineage = { roots: { roots: new Set(), over: false }, instanceId: "claude-steer", session: "claude-session", generation: "g-claude", turn: { threadId: "desk", turnId: "t-claude", turnLsn: 0, parents: [] } as unknown as RunningTurnLineage["turn"] };
      const turn = openTurn("desk", "t-desk");
      const session = { threadId: "desk", driverInstance: "claude-steer", nativeSession: "claude-session" };
      writeSessionLineage(database(), session, turn);
      let fenced = 0;
      const steering = steerWithQuoteLineage(instance.adapter, "desk", "> The alarm code is 4812.\nSTEER use it on the side door", true, {
        holds: () => { fenced++; return true; }, steerId: "steer-c", lineage, quote: QUOTE, turn,
      });
      // queued before init: the fence has not run and nothing is written
      for (let i = 0; i < 1000 && lines().length < 1; i++) await new Promise((r) => setTimeout(r, 10));
      expect(lines()).toEqual(["recv:one SLOW_INIT"]);
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
