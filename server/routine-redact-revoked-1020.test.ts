// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.20 redact-1020. Owners: redact-1020 builder owns the routine presentation (owner-display.ts routinePresentation, its index.ts call
// and routines.ts applyRunEvent); the harness owns the collector (harness/audience-collector.ts) and the claude driver its relay seal.
//
// Live shape (owner report, scheduled run at 23:00Z): a routine's turn had its memory context revoked mid-turn; the ledger refusal sealed
// the mount relay (claude.ts relay.attach), and the driver ended the turn with the "memory was not ready" error from a relay callback, not
// owned by the turn's source. The collector projects an unowned event as the bare marker (audience-collector.ts !valid). The owner's error
// row already reads his own clean words (shownErrorReason), but the routine stored the projection as its error, so the run card in the
// owner's chat showed «redacted». Real bus and collector, real routine manager and card; no mock of the decision under test.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { ProviderInstance, RuntimeEvent, RuntimeEventListener } from "./contracts.ts";
import { mountStoppedLine } from "./drivers/stop-copy.ts";
import { EventBus } from "./harness/bus.ts";
import * as ownerDisplay from "./owner-display.ts";
import { RoutineManager, routineRunCard } from "./routines.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const MARKER = "«redacted»";
const THREAD = "routine-execution-thread";
const MEMORY_LINE = mountStoppedLine("Claude", { kind: "memory", code: "memory-fence:pending" });

/** The engine's event as the bus publishes it, and what the collector projected for it. */
function unownedThroughBus(events: Array<Partial<RuntimeEvent>>) {
  let listener: RuntimeEventListener | null = null;
  const instance = {
    instanceId: "claude-fixture", driverKind: "claude", displayName: "Claude", enabled: true, models: { default: "m", options: [] },
    adapter: { provider: "claude", onEvent: (l: RuntimeEventListener) => { listener = l; return () => {}; } },
  } as unknown as ProviderInstance;
  const bus = new EventBus(() => {});
  bus.attach([instance]);
  const published: RuntimeEvent[] = [];
  bus.subscribe(event => { published.push(event); });
  // no source: the relay-seal callback runs outside the turn's emission context
  for (const event of events) listener!({ eventId: `e-${published.length}`, provider: "claude", threadId: THREAD, turnId: "routine-turn",
    createdAt: new Date().toISOString(), ...event } as unknown as RuntimeEvent);
  return published.map(event => ({ event, displayed: bus.audienceFor(event).map(e => e.event).find(e => e.type === event.type) as unknown as RuntimeEvent | undefined }));
}

async function routineRun(ownerOnly: boolean, events: Array<Partial<RuntimeEvent>>) {
  const dir = mkdtempSync(join(tmpdir(), "redact-1020-routine-"));
  const sent: string[] = [];
  const manager = new RoutineManager({ file: join(dir, "routines.json"), botState: () => "ready", createTask: () => ({ threadId: THREAD }),
    startTurn: async (_bot, _thread, text) => { sent.push(text); }, interruptTurn: async () => {}, emit: () => {} });
  try {
    const routine = manager.create({ name: "Operators Table sweep", prompt: "Sweep the operators table.", botId: "bot", target: "bot", runOn: "ember",
      enabled: false, schedule: { type: "interval", everyMinutes: 30, anchorAt: Date.now() } });
    manager.runNow(routine.id);
    await expect.poll(() => sent.length).toBe(1);
    manager.handleRuntimeEvent({ type: "turn.started", threadId: THREAD, turnId: "routine-turn" } as never);
    for (const { event, displayed } of unownedThroughBus(events)) {
      // the collector withheld this unowned event: only the marker reached the display copy
      expect(JSON.stringify(displayed ?? {})).not.toContain("memory was not ready");
      // index.ts: routines.handleRuntimeEvent(event, routinePresentation(event, displayEvent, ownerView))
      manager.handleRuntimeEvent(event, ownerDisplay.routinePresentation(event, displayed, ownerOnly));
    }
    const run = manager.listRuns()[0]!;
    return { run, card: routineRunCard(run) };
  } finally { manager.stop(); removeTempDirSync(dir); }
}

it("REDACT-1020-1 a routine whose memory context was revoked mid-turn: its card in the owner's chat never reads «redacted»", async () => {
  // the refused turn's own completion is rejected at the bus (refuseTurn terminated its source): the live run's card carries this error
  const { run, card } = await routineRun(true, [
    { type: "runtime.error", message: MEMORY_LINE, details: `${MEMORY_LINE}\nCause code: memory-fence:pending` },
  ]);
  expect(run.status).toBe("running");
  // the owner reads the turn's real reason (the same words as his error row), not the marker
  expect(run.error).toBe(MEMORY_LINE);
  expect(card.error).toBe(MEMORY_LINE);
  expect(JSON.stringify(card)).not.toContain(MARKER);
});

it("REDACT-1020-1b the same error kept by a generic failed completion: the failed card names the reason, not the marker", async () => {
  const { run, card } = await routineRun(true, [
    { type: "runtime.error", message: MEMORY_LINE },
    { type: "turn.completed", ok: false, stopReason: "error" },
  ]);
  expect(run.status).toBe("failed");
  expect(card.error).toBe(MEMORY_LINE);
  expect(JSON.stringify(card)).not.toContain(MARKER);
});

it("REDACT-1020-2 a withheld reply never becomes the run's output: the completed card has no «redacted» summary", async () => {
  const { run, card } = await routineRun(true, [
    { type: "item.completed", itemType: "assistant_text", itemId: "a1", text: "Swept 14 operators; 2 need follow-up." },
    { type: "turn.completed", ok: true, stopReason: null },
  ]);
  expect(run.status).toBe("completed");
  expect(run.output ?? "").not.toContain(MARKER);
  expect(JSON.stringify(card)).not.toContain(MARKER);
  // the collector withheld the unowned reply: its words never reach the run either
  expect(JSON.stringify(card)).not.toContain("Swept 14 operators");
});

it("REDACT-1020-2b a shared audience: the engine's words stay withheld and the reason says so plainly, never the bare marker", async () => {
  const { run, card } = await routineRun(false, [
    { type: "runtime.error", message: MEMORY_LINE },
    { type: "turn.completed", ok: false, stopReason: "error" },
  ]);
  expect(run.error).toBe(ownerDisplay.ERROR_REASON_WITHHELD);
  expect(JSON.stringify(card)).not.toContain(MARKER);
  expect(JSON.stringify(card)).not.toContain("memory was not ready");
});

it("REDACT-1020-3 privacy: an error that carries a secret stays redacted even for the owner", async () => {
  const secret = "api_key=" + "FIXTURESECRET123456";
  const { run, card } = await routineRun(true, [
    { type: "runtime.error", message: `request failed ${secret}` },
    { type: "turn.completed", ok: false, stopReason: "error" },
  ]);
  expect(run.status).toBe("failed");
  expect(JSON.stringify(run)).not.toContain("FIXTURESECRET123456");
  expect(JSON.stringify(card)).not.toContain("FIXTURESECRET123456");
});
