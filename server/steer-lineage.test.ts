// A steer quoting a memory-derived reply discloses that reply to the running
// turn the moment its text is written to the engine. Fuigo acknowledges an
// interjection later (up to its budget); if the quote's source is revoked in
// between, the quote is withheld by the time the acknowledgement arrives. Its
// roots must still be on the running turn and its engine session, so the next
// write's session check resets the session. Through the real Fuigo driver and
// the fake ACP CLI, whose interjection echo (the acknowledgement) is delayed.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { capturedMessageWithheld, outputRootsBad, outputRootsFor, recordOutputRoots, recordSessionRoots, sessionOutputRoots } from "./memory/replay-lineage.ts";
import { setMemoryMode } from "./memory/repository.ts";
import { steerWithQuoteLineage, type RunningTurnLineage } from "./steer-lineage.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const FAKE_ACP = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-acp-cli.ts");
const posixOnly = describe.skipIf(process.platform === "win32");
const roster: MemoryRoster = { bots: [{ id: "bot", threadId: "chat", tasks: [{ threadId: "older" }, { threadId: "desk" }] }], groups: [] };
const registry = new InternalCapabilities();
const empty = { async search() { return { hits: [], vectorRows: 0, coverageComplete: false }; } };
const ROOT = "chat\u0000reply-1";
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
  const receipt = new MemoryDispatchReceipt(await buildMemoryBundle("", turn, empty), turn, "engine");
  receipt.sessionStarted("s1");
  receipt.noteLookup([{ id: record, version: 1, evidence: [{ sourceId: "message:older:m1", revision: 1 }] }], turn);
  receipt.accepted();
  receipt.output("reply-1");
  expect(capturedMessageWithheld("chat", "reply-1")).toBe(false);
}

let root: string;
let instance: ProviderInstance | undefined;
const savedAck = process.env.MURAGE_FUIGO_INTERJECT_ACK_MS;

beforeEach(() => {
  closeDatabase();
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  ensureDirs();
  setMemoryMode("active");
  reconcileMemoryRoster(roster);
  root = mkdtempSync(join(tmpdir(), "murage-steer-lineage-"));
  chmodSync(FAKE_ACP, 0o755);
});
afterEach(async () => {
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
  const prompted = () => existsSync(dump) && (JSON.parse(readFileSync(dump, "utf8")) as string[]).includes("session/prompt");
  for (let i = 0; i < 500 && !prompted(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(prompted()).toBe(true);
  // the running turn's lineage and its engine session (v6 marks every session it saw)
  const lineage: RunningTurnLineage = { roots: { roots: new Set(), over: false }, instanceId: "fuigo-steer", session: "s-desk" };
  recordSessionRoots("desk", "fuigo-steer", "s-desk", lineage.roots);
  return { adapter: instance.adapter, lineage };
}

posixOnly("a steer's quoted reply is recorded at the write, not after the acknowledgement", () => {
  it("a quote whose source is revoked while Fuigo's acknowledgement is pending stays on the turn and session; the next check resets it", async () => {
    await memoryDerivedReply();
    const { adapter, lineage } = await runningFuigo(1200);
    let fenced = 0;
    const steering = steerWithQuoteLineage(adapter, "desk", "> The alarm code is 4812.\nUse it on the side door", true, {
      holds: () => { fenced++; return true; }, steerId: "steer-1", lineage, quote: QUOTE,
    });
    // The fence ran and the text was written; the acknowledgement is pending.
    expect(fenced).toBe(1);
    // reply-1's source leaves its branch while Fuigo has not answered yet.
    captureBranchChange(database(), "older", null);
    expect(capturedMessageWithheld("chat", "reply-1")).toBe(true);
    // A reply the turn persists now, before the acknowledgement, rests on the
    // quote (index.ts records the running turn's roots on each reply), so it
    // is withheld from bots like the quote itself.
    recordOutputRoots("desk", "reply-2", lineage.roots);
    const persisted = outputRootsFor([{ threadId: "desk", id: "reply-2", role: "bot" }]);
    expect([...persisted.roots]).toContain(ROOT);
    expect(outputRootsBad(persisted)).toBe(true);
    expect(await steering).toBe("steer");
    // The engine has the quote: its root is on the turn (every later reply) and on the session.
    expect([...lineage.roots.roots]).toContain(ROOT);
    expect([...sessionOutputRoots("desk", "fuigo-steer", "s-desk").roots]).toContain(ROOT);
    // The revocation validator (the next write's check) resets the session.
    const why: { reason?: string } = {};
    expect(retainedSessionInvalid("desk", "fuigo-steer", "s-desk", why)).toBe(true);
    expect(why.reason).toBe("session-roots");
  }, 30_000);

  it("an uncertain steer (no acknowledgement within the budget) counts as disclosed", async () => {
    process.env.MURAGE_FUIGO_INTERJECT_ACK_MS = "400";
    await memoryDerivedReply();
    const { adapter, lineage } = await runningFuigo(5000);
    const steering = steerWithQuoteLineage(adapter, "desk", "Use it on the side door", true, { holds: () => true, steerId: "steer-2", lineage, quote: QUOTE });
    captureBranchChange(database(), "older", null);
    expect(await steering).toBe("uncertain");
    expect([...sessionOutputRoots("desk", "fuigo-steer", "s-desk").roots]).toContain(ROOT);
    expect(retainedSessionInvalid("desk", "fuigo-steer", "s-desk")).toBe(true);
  }, 30_000);

  it("a steer the fence refuses writes nothing and records nothing", async () => {
    await memoryDerivedReply();
    const { adapter, lineage } = await runningFuigo(300);
    const delivery = await steerWithQuoteLineage(adapter, "desk", "Use it on the side door", true, { holds: () => false, steerId: "steer-3", lineage, quote: QUOTE });
    expect(delivery).toBe("queue");
    expect(lineage.roots.roots.size).toBe(0);
    expect(sessionOutputRoots("desk", "fuigo-steer", "s-desk").roots.size).toBe(0);
    captureBranchChange(database(), "older", null);
    expect(retainedSessionInvalid("desk", "fuigo-steer", "s-desk")).toBe(false);
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
    expect(sessionOutputRoots("desk", "fuigo-steer", "s-desk").roots.size).toBe(0);
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
    await memoryDerivedReply();
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
      const lineage: RunningTurnLineage = { roots: { roots: new Set(), over: false }, instanceId: "claude-steer", session: "claude-session" };
      recordSessionRoots("desk", "claude-steer", "claude-session", lineage.roots);
      let fenced = 0;
      const steering = steerWithQuoteLineage(instance.adapter, "desk", "> The alarm code is 4812.\nSTEER use it on the side door", true, {
        holds: () => { fenced++; return true; }, steerId: "steer-c", lineage, quote: QUOTE,
      });
      // queued before init: the fence has not run and nothing is written
      for (let i = 0; i < 1000 && lines().length < 1; i++) await new Promise((r) => setTimeout(r, 10));
      expect(lines()).toEqual(["recv:one SLOW_INIT"]);
      expect(fenced).toBe(0);
      // reply-1's source leaves its branch while the steer waits
      captureBranchChange(database(), "older", null);
      expect(capturedMessageWithheld("chat", "reply-1")).toBe(true);
      // init arrives and the queued steer is flushed: refused at its fence,
      // so the caller runs the line as its own turn
      writeFileSync(gate, "");
      expect(await steering).toBe("queue");
      expect(fenced).toBe(1);
      await new Promise((r) => setTimeout(r, 400));
      expect(lines().some((line) => line.includes("4812") || line.includes("STEER"))).toBe(false);
      expect(lineage.roots.roots.size).toBe(0);
      expect(sessionOutputRoots("desk", "claude-steer", "claude-session").roots.size).toBe(0);
    } finally {
      delete process.env.STEER_LINEAGE_LOG;
      delete process.env.STEER_LINEAGE_GATE;
    }
  }, 30_000);
});
