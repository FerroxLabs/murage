// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Regression (1.0.18, bot-folder launch contract f62f91afa): the production learning call path has no fixture folder. consolidate and
// grounding call the resolved extractor with no cwd, so a CLI or ACP engine hidden turn threw BotFolderUnavailableError on every
// call unless the host supplied a bot real folder. These tests do NOT use fixtureLearningBot.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import type { ProviderInstance, RuntimeEvent, SendTurnInput } from "../contracts.ts";
import { closeDatabase, database } from "../database.ts";
import { withCliMemoryLearning } from "../drivers/cli-memory-learning.ts";
import { checkEngineReply } from "../engine-reply-check.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { openLearningGate } from "../testing/open-learning-gate.ts";
import { captureSource } from "./capture.ts";
import { captureWork } from "./chunks.ts";
import { consolidateMemorySource } from "./consolidate.ts";
import { extractCandidates, groundMemoryClaim } from "./extract.ts";
import { extractionOutcomes } from "./extraction-outcomes.ts";
import { resolveLearningConnection } from "./extractor-connections.ts";
import { setMemoryCaptureRoster } from "./capture-scope.ts";
import { setLearningBotFolder, withBotLearningFolder } from "./learning-folder.ts";
import { claimMemoryJob, publishMemoryWork, resetMemoryClaimCursor } from "./jobs.ts";
import { reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { storeAnchorMessage } from "./testing/anchor-message.ts";

const roots: string[] = [];
beforeEach(() => { extractionOutcomes.clear(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { extractionOutcomes.clear(); setLearningBotFolder(undefined); setMemoryCaptureRoster(null); for (const root of roots.splice(0)) removeTempDirSync(root); });
const realFolder = () => { const root = mkdtempSync(join(tmpdir(), "murage-learn-folder-")); roots.push(root); return root; };

/** The shape Codex and the ACP engines have, wrapped exactly as production wraps it (withCliMemoryLearning only, no fixture). */
function engine(replyFor: (prompt: string) => string) {
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const sent: SendTurnInput[] = [];
  const emit = (threadId: string, event: Record<string, unknown>) => listeners.forEach(l => l({ eventId: "e", provider: "codex", threadId, createdAt: "now", ...event } as RuntimeEvent));
  const adapter = {
    provider: "codex", capabilities: { sessionModelSwitch: "unsupported" },
    onEvent: (listener: (event: RuntimeEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    sendTurn: async (input: SendTurnInput) => {
      sent.push(input);
      emit(input.threadId, { type: "turn.started" });
      emit(input.threadId, { type: "item.completed", itemType: "assistant_text", origin: "engine", text: replyFor(input.text) });
      emit(input.threadId, { type: "turn.completed", ok: true });
      return { turnId: "turn" };
    },
    respondToRequest: async () => "rejected", interruptTurn: async () => undefined, resetSession: async () => undefined,
  };
  const instance = withCliMemoryLearning({ instanceId: "codex-prod", driverKind: "codex", displayName: "Codex", enabled: true, adapter, dispose: async () => undefined } as unknown as ProviderInstance);
  return { instance, sent };
}
const signal = () => new AbortController().signal;
const SOURCE = "The owner reads reports daily. Nothing else of note.";
const CANDIDATES = JSON.stringify([{ text: "The owner reads reports daily.", quote: "reads reports daily", startByte: 10, endByte: 29, claimType: "owner-statement" }]);
const contract = (prompt: string) => prompt.includes("Independently judge") ? JSON.stringify({ supported: true }) : CANDIDATES;
const connect = (instance: ProviderInstance, folder?: () => string | undefined) =>
  resolveLearningConnection({ selected: instance.instanceId, instances: [instance], readKey: () => null, defaultOn: true, ...(folder ? { folder } : {}) });

describe("learning launches in the bot folder on the production path (no fixture)", () => {
  it("extraction (what consolidate calls) reaches the engine in the resolved bot folder", async () => {
    const { instance, sent } = engine(contract), folder = realFolder();
    const result = await extractCandidates(SOURCE, connect(instance, () => folder).extractor, signal(), undefined, undefined, { fence: openLearningGate() });
    expect(result.status).toBe("complete");
    expect(sent).toHaveLength(1);
    expect(sent[0].cwd).toBe(folder);
  });
  it("grounding (a second consolidate call) launches in the same folder", async () => {
    const { instance, sent } = engine(contract), folder = realFolder();
    const result = await groundMemoryClaim({ text: SOURCE, quote: "reads reports daily", claimType: "owner-statement", speaker: "owner", outcome: "sent" }, connect(instance, () => folder).extractor, signal(), undefined, openLearningGate("grounding"));
    expect(result.supported).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].cwd).toBe(folder);
  });
  it("the Settings engine reply check launches in the folder too", async () => {
    const { instance, sent } = engine(() => "ready"), folder = realFolder();
    expect(await checkEngineReply(instance as never, 5000, folder)).toEqual({ result: "ready" });
    expect(sent[0].cwd).toBe(folder);
  });
  it("a dispatch that names its own folder keeps it", async () => {
    const { instance, sent } = engine(contract), own = realFolder(), other = realFolder();
    await connect(instance, () => other).extractor!("text", 500, signal(), { policyRevision: "t", messages: [{ role: "user", content: "x" }], cwd: own, fence: openLearningGate() });
    expect(sent[0].cwd).toBe(own);
  });
  it("no folder at all stays fail-closed: nothing reaches the engine (botFolderOrThrow is not weakened)", async () => {
    const { instance, sent } = engine(contract);
    const result = await extractCandidates(SOURCE, connect(instance, () => undefined).extractor, signal(), undefined, undefined, { fence: openLearningGate() });
    expect(result.status).not.toBe("complete");
    expect(sent).toHaveLength(0);
  });
});

describe("consolidate launches in the SOURCE bot's folder, never another bot's", () => {
  const roster = { bots: [{ id: "bot", threadId: "thread" }, { id: "other", threadId: "other-thread" }], groups: [] } as unknown as MemoryRoster;
  beforeEach(() => { setMemoryCaptureRoster(() => roster); reconcileMemoryRoster(roster); setMemoryMode("capture"); resetMemoryClaimCursor(); });
  function captured(text: string) {
    storeAnchorMessage(database(), "thread", "m-src", text);
    captureSource(database(), { id: "src", threadId: "thread", messageId: "m-src", origin: { kind: "attended" }, kind: "text", speaker: "owner", outcome: "recorded", text } as Parameters<typeof captureSource>[1]);
    const work = claimMemoryJob("w")!; publishMemoryWork(work, "w", captureWork(work));
    return work.id;
  }
  it("extraction and grounding of bot's words both launch in bot's folder, not the host default (another bot's)", async () => {
    const { instance, sent } = engine(contract), botFolder = realFolder(), otherBotsFolder = realFolder();
    const extractor = connect(instance, () => otherBotsFolder).extractor!;
    setLearningBotFolder(id => id === "bot" ? botFolder : otherBotsFolder);
    const result = await consolidateMemorySource(captured(SOURCE), extractor, signal());
    expect(result.status).toBe("complete");
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(sent.map(turn => turn.cwd)).toEqual(sent.map(() => botFolder));
  });
  it("a source bot with no usable folder launches nothing and never borrows the host default", async () => {
    const { instance, sent } = engine(contract), otherBotsFolder = realFolder();
    const extractor = connect(instance, () => otherBotsFolder).extractor!;
    setLearningBotFolder(() => undefined);
    const result = await consolidateMemorySource(captured(SOURCE), extractor, signal());
    expect(result.status).not.toBe("complete");
    expect(sent).toHaveLength(0);
  });
});

describe("the scope is per call", () => {
  it("two bots' calls in flight at once each land in their own folder, and the host default returns after", async () => {
    const { instance, sent } = engine(contract), a = realFolder(), b = realFolder(), host = realFolder();
    const extractor = connect(instance, () => host).extractor!;
    setLearningBotFolder(id => id === "a" ? a : b);
    const dispatch = () => ({ policyRevision: "t", messages: [{ role: "user", content: "x" }], fence: openLearningGate() });
    await Promise.all([
      withBotLearningFolder("a", () => extractor("one", 500, signal(), dispatch())),
      withBotLearningFolder("b", () => extractor("two", 500, signal(), dispatch())),
    ]);
    await extractor("three", 500, signal(), dispatch());
    expect(sent.map(turn => turn.cwd).sort()).toEqual([a, b, host].sort());
  });
});
