import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { newEventId, type AnyProviderDriver, type RuntimeEvent, type RuntimeEventListener } from "../contracts.ts";

/** In-process provider for server finalizer tests. No external consuming mount
 * is launched: the server's real capability is captured from its input. */
export function makeLedgerDriver(): AnyProviderDriver {
  return {
    driverKind: "fakeLedger", metadata: { displayName: "Ledger fixture" },
    models: { default: "ledger-1", options: [{ id: "ledger-1", label: "Ledger fixture" }] },
    decodeConfig: raw => raw ?? {}, defaultConfig: () => ({}),
    async create(input) {
      let serial = 0;
      const listeners = new Set<RuntimeEventListener>(), active = new Map<string, string>(), retired = new Map<string, string>();
      const note = (value: object) => appendFileSync(input.environment.FAKE_LEDGER_DUMP!, JSON.stringify(value) + "\n");
      const emit = (event: Record<string, unknown>) => {
        const full = { eventId: newEventId(), createdAt: new Date().toISOString(), provider: "fakeLedger", providerInstanceId: input.instanceId, ...event } as RuntimeEvent;
        for (const listener of listeners) listener(full);
      };
      const late = (threadId: string, turnId: string) => {
        const file = input.environment.FAKE_LEDGER_EVENTS;
        const kind = file && existsSync(file) ? readFileSync(file, "utf8") : "turn.completed";
        const fields = kind === "runtime.error" ? { message: "fixture late provider failure" }
          : kind === "content.delta" ? { streamKind: "assistant_text", delta: "fixture late provider content" }
          : kind === "session.exited" ? { reason: "fixture exit" } : { ok: true };
        emit({ type: kind, threadId, turnId, ...fields });
      };
      return {
        instanceId: input.instanceId, driverKind: "fakeLedger", displayName: input.displayName, enabled: input.enabled,
        models: { default: "ledger-1", options: [{ id: "ledger-1", label: "Ledger fixture" }] },
        snapshot: async () => ({ state: "available", version: "fixture" }),
        adapter: {
          provider: "fakeLedger", capabilities: { agentsMcp: true, sessionModelSwitch: "unsupported" },
          sendTurn: async turn => {
            const turnId = `ledger-${++serial}`;
            turn.beforeSubmit?.();
            active.set(turn.threadId, turnId);
            emit({ type: "turn.started", threadId: turn.threadId, turnId });
            note({ threadId: turn.threadId, turnId, token: turn.integrations?.agents?.env?.MURAGE_COMMS_TOKEN });
            const old = retired.get(turn.threadId);
            if (old) late(turn.threadId, old);
            return { turnId };
          },
          interruptTurn: async (threadId, turnId) => {
            const actual = active.get(threadId);
            if (!actual || turnId !== undefined && turnId !== actual) return { closeConfirmed: false, reason: "stop-failed" };
            active.delete(threadId); retired.set(threadId, actual);
            note({ threadId, stopped: actual });
            late(threadId, actual);
            emit({ type: "turn.completed", threadId, turnId: actual, ok: false, stopReason: "interrupted" });
            emit({ type: "turn.completed", threadId, turnId: actual, ok: true });
            return { closeConfirmed: true };
          },
          hasSession: () => false, resetSession: async () => {}, stopAll: async () => { active.clear(); },
          respondToRequest: async () => "unavailable",
          onEvent: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        },
        dispose: async () => { active.clear(); listeners.clear(); },
      };
    },
  };
}
