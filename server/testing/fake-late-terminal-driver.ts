// In-process ProviderDriver whose interruptTurn returns BEFORE the stopped
// turn's terminal event — the "requested, not observed" stop the adapter
// contract still allows (Claude retains sessions; Antigravity and BoxAgent
// interrupt without watching the close). The harness must stay correct when
// that late terminal event lands while a replacement turn is being prepared
// on the same thread (RED2I).
//
// Registered into BUILT_IN_DRIVERS by a verification fixture's
// instrumentation preload, then configured like any engine, with gates in
// the instance `environment`:
//   FAKE_LATE_SESSION_GATE   path: sendTurn resolves only once this file exists
//                            (writes `<path>.waiting` while held, polls every
//                            20 ms) — the same window the fake pi engine's
//                            FAKE_PI_SESSION_GATE gives a test: the harness has
//                            called sendTurn, the provider has not accepted.
//   FAKE_LATE_TERMINAL_GATE  path: an interrupted turn's turn.completed is
//                            emitted only once this file exists (writes
//                            `<path>.emitted` afterwards). interruptTurn itself
//                            resolves at once, with no stop result.
//   FAKE_LATE_DUMP           path: append one JSON line per sendTurn
//                            ({turnId, threadId}) so a test can count dispatches.
// An uninterrupted turn replies "Hello from late" and completes on its own.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import type {
  AnyProviderDriver,
  DriverCreateInput,
  ProviderInstance,
  RuntimeEvent,
  RuntimeEventListener,
} from "../contracts.ts";
import { newEventId } from "../contracts.ts";

export const LATE_TERMINAL_DRIVER_KIND = "fakeLateTerminal";

/** Omit over each member of the event union, not over the union as a whole. */
type EmittedEvent = RuntimeEvent extends infer Event
  ? Event extends RuntimeEvent ? Omit<Event, "eventId" | "provider" | "providerInstanceId" | "createdAt"> : never
  : never;

const waitForFile = (path: string, everyMs = 20): Promise<void> =>
  new Promise((resolve) => {
    if (existsSync(path)) return resolve();
    const poll = setInterval(() => {
      if (!existsSync(path)) return;
      clearInterval(poll);
      resolve();
    }, everyMs);
    poll.unref?.();
  });

export function makeLateTerminalDriver(): AnyProviderDriver {
  let turnCounter = 0;
  return {
    driverKind: LATE_TERMINAL_DRIVER_KIND,
    metadata: { displayName: "Late-terminal fixture" },
    models: { default: "late-1", options: [{ id: "late-1", label: "Late one" }] },
    decodeConfig: (raw: unknown) => (raw ?? {}) as Record<string, unknown>,
    defaultConfig: () => ({}),
    async create(input: DriverCreateInput<Record<string, unknown>>): Promise<ProviderInstance> {
      const sessionGate = input.environment.FAKE_LATE_SESSION_GATE;
      const terminalGate = input.environment.FAKE_LATE_TERMINAL_GATE;
      const dump = input.environment.FAKE_LATE_DUMP;
      const listeners = new Set<RuntimeEventListener>();
      const emit = (event: EmittedEvent) => {
        const full = { eventId: newEventId(), provider: LATE_TERMINAL_DRIVER_KIND, providerInstanceId: input.instanceId, createdAt: new Date().toISOString(), ...event } as RuntimeEvent;
        // Snapshot: a listener may unsubscribe while the event is delivered.
        const snapshot = Array.from(listeners);
        for (const listener of snapshot) listener(full);
      };
      const active = new Map<string, { turnId: string; interrupted: boolean }>();
      return {
        instanceId: input.instanceId,
        driverKind: LATE_TERMINAL_DRIVER_KIND,
        displayName: input.displayName,
        enabled: input.enabled,
        models: { default: "late-1", options: [{ id: "late-1", label: "Late one" }] },
        snapshot: async () => ({ state: "available", version: "0.0.0-late" }),
        adapter: {
          provider: LATE_TERMINAL_DRIVER_KIND,
          capabilities: { sessionModelSwitch: "unsupported" },
          sendTurn: async (turn) => {
            const turnId = `late-turn-${++turnCounter}`;
            if (dump) appendFileSync(dump, `${JSON.stringify({ turnId, threadId: turn.threadId })}\n`);
            if (sessionGate && !existsSync(sessionGate)) {
              writeFileSync(`${sessionGate}.waiting`, turnId);
              await waitForFile(sessionGate, 25);
            }
            const entry = { turnId, interrupted: false };
            active.set(turn.threadId, entry);
            emit({ type: "turn.started", threadId: turn.threadId, turnId });
            // The reply follows acceptance on a later tick, so a stop issued
            // inside the acceptance hook is seen before anything is said.
            setTimeout(() => {
              if (entry.interrupted || active.get(turn.threadId) !== entry) return;
              emit({ type: "item.completed", itemType: "assistant_text", text: "Hello from late", threadId: turn.threadId, turnId });
              active.delete(turn.threadId);
              emit({ type: "turn.completed", ok: true, threadId: turn.threadId, turnId });
            }, 25);
            return { turnId };
          },
          interruptTurn: async (threadId) => {
            const entry = active.get(threadId);
            if (!entry || entry.interrupted) return;
            entry.interrupted = true;
            active.delete(threadId);
            // Requested, not observed: the terminal event comes later, when
            // the test says so — the process-close of a real driver.
            void (async () => {
              if (terminalGate) await waitForFile(terminalGate);
              emit({ type: "turn.completed", ok: false, stopReason: "interrupted", threadId, turnId: entry.turnId });
              if (terminalGate) writeFileSync(`${terminalGate}.emitted`, entry.turnId);
            })();
          },
          respondToRequest: async () => "unavailable" as const,
          hasSession: () => false,
          stopAll: async () => { active.clear(); },
          onEvent: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
        dispose: async () => { listeners.clear(); active.clear(); },
      };
    },
  };
}
