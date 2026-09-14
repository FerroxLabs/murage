import { beforeEach, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { Store, type Message } from "./store.ts";
import * as mdb from "./message-db.ts";
import type { RuntimeErrorDiagnostic } from "../shared/error-diagnostic.ts";

const selection = () => ({ instanceId: "fixture", model: "fixture-model" });
const stored = (threadId: string) => mdb.readThread(threadId, join(DATA_DIR, `messages-${threadId}.json`));
const turnId = "eb22599e-c710-40e2-98b3-35b56a88a2e1";
const otherTurn = "eb22599e-c710-40e2-98b3-35b56a88a2e2";
const diagnostic: RuntimeErrorDiagnostic = {
  version: 1, diagnosticId: "ev-fixture-1", turnId,
  processGeneration: "c741da10-9e2c-4c72-86fd-75a145b63b11",
  rpcId: 4, method: "session/prompt", rpcCode: -32603, httpStatus: 500,
  terminalKind: "api", observedKind: "idle_timeout",
};
beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));
function fixture() {
  const store = new Store(selection);
  const bot = store.createBot({}, { seedMessages: false });
  return { store, threadId: bot.threadId };
}
const error = (value: unknown = diagnostic): Omit<Message, "id" | "at"> => ({
  role: "bot", kind: "activity", turnId,
  tool: { name: "error: Internal error", ok: false, errorDetails: "Existing details", diagnostic: value as RuntimeErrorDiagnostic },
});
it("persists exact diagnostic identity, turn and distinct terminal/observed facts through reload", () => {
  const { store, threadId } = fixture();
  const saved = store.appendMessage(threadId, error());
  expect(saved.tool?.diagnostic).toEqual(diagnostic);
  mdb.closeMessageDb();
  const reloaded = new Store(selection).messagesFor(threadId).find(message => message.id === saved.id);
  expect(reloaded?.turnId).toBe(turnId);
  expect(reloaded?.tool).toEqual(saved.tool);
  expect(reloaded?.tool?.diagnostic?.diagnosticId).toBe("ev-fixture-1");
});
it("non-index callers cannot persist private, malformed or mismatched diagnostic fields", () => {
  const { store, threadId } = fixture();
  const canary = "PRIVATE-DIAGNOSTIC-CANARY";
  for (const value of [{ ...diagnostic, body: canary }, { ...diagnostic, httpStatus: 999 }, { ...diagnostic, turnId: otherTurn }, { ...diagnostic, diagnosticId: canary }]) {
    const saved = store.appendMessage(threadId, error(value));
    expect(saved.tool?.diagnostic).toBeUndefined();
    expect(saved.tool?.errorDetails).toBe("Existing details");
    expect(JSON.stringify(stored(threadId).messages)).not.toContain(canary);
  }
});
it("patch validation uses the resulting turn and never retains stale or private facts", () => {
  const { store, threadId } = fixture();
  const saved = store.appendMessage(threadId, error());
  expect(store.patchMessage(threadId, saved.id, { turnId: otherTurn })?.tool?.diagnostic).toBeUndefined();
  const changed = { ...diagnostic, turnId: otherTurn };
  expect(store.patchMessage(threadId, saved.id, { tool: { ...saved.tool!, diagnostic: changed } })?.tool?.diagnostic).toEqual(changed);
  const privateValue = { ...changed, response: "PRIVATE-PATCH-CANARY" } as RuntimeErrorDiagnostic;
  expect(store.patchMessage(threadId, saved.id, { tool: { ...saved.tool!, diagnostic: privateValue } })?.tool?.diagnostic).toBeUndefined();
  expect(JSON.stringify(new Store(selection).messagesFor(threadId))).not.toContain("PRIVATE-PATCH-CANARY");
});
it("load drops invalid new metadata without rewriting stored rows or changing legacy messages", () => {
  const { store, threadId } = fixture();
  const legacy = store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: "error: old", errorDetails: "Legacy details" } });
  const saved = store.appendMessage(threadId, error());
  const malformed = { ...saved, tool: { ...saved.tool!, diagnostic: { ...diagnostic, body: "PRIVATE-RELOAD-CANARY" } as RuntimeErrorDiagnostic } };
  mdb.updateMessage(threadId, malformed);
  const reloaded = new Store(selection).messagesFor(threadId);
  expect(reloaded.find(message => message.id === legacy.id)).toEqual(legacy);
  expect(reloaded.find(message => message.id === saved.id)?.tool?.diagnostic).toBeUndefined();
  expect(reloaded.find(message => message.id === saved.id)?.tool?.errorDetails).toBe("Existing details");
  expect(stored(threadId).messages.find(message => message.id === saved.id)?.tool?.diagnostic).toEqual(malformed.tool.diagnostic);
});
