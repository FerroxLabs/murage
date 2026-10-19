// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// In-process ProviderDriver that really keeps its sessions: one native session per thread, holding every prompt written into it, reused by
// the next turn until the harness ends it (sessionReset on the turn, or resetSession). It reports the session (session.started) after
// handing the turn id back and before the write, as ACP does, so the harness folds the session before the submission fence runs.
// Registered into BUILT_IN_DRIVERS by a verification fixture's instrumentation preload, configured in the instance `environment`:
//   FAKE_KEEP_DUMP   path: one JSON line per write ({threadId, session, fresh, prompt, context}), per refused write ({threadId, session,
//                    refused: true}) and per reset ({threadId, reset: true}). `context` is everything the session holds, this prompt included.
//   FAKE_KEEP_HOLD   directory: while `<dir>/arm` exists, the next turn takes it, writes `<dir>/waiting` (its thread) once its prompt is
//                    built and before its session is reported, and waits for `<dir>/go`, so a test can land a revoke at that point.
//   FAKE_KEEP_REPORT_ONCE  "1": the session is reported only when it starts; turns that continue it report nothing (as an engine that
//                    resumes an idle process silently does).
// Each turn replies "Kept reply".
import { appendFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AnyProviderDriver, DriverCreateInput, ProviderInstance, RuntimeEvent, RuntimeEventListener } from "../contracts.ts";
import { newEventId } from "../contracts.ts";

export const KEEPING_DRIVER_KIND = "fakeKeeping";
export const KEPT_REPLY = "Kept reply";

type EmittedEvent = RuntimeEvent extends infer Event
  ? Event extends RuntimeEvent ? Omit<Event, "eventId" | "provider" | "providerInstanceId" | "createdAt"> : never
  : never;

const waitForFile = (path: string): Promise<void> => new Promise((resolve) => {
  if (existsSync(path)) return resolve();
  const poll = setInterval(() => { if (!existsSync(path)) return; clearInterval(poll); resolve(); }, 20);
  poll.unref?.();
});

export function makeKeepingDriver(): AnyProviderDriver {
  let counter = 0;
  return {
    driverKind: KEEPING_DRIVER_KIND,
    metadata: { displayName: "Keeping fixture" },
    models: { default: "keep-1", options: [{ id: "keep-1", label: "Keep one" }] },
    decodeConfig: (raw: unknown) => (raw ?? {}) as Record<string, unknown>,
    defaultConfig: () => ({}),
    async create(input: DriverCreateInput<Record<string, unknown>>): Promise<ProviderInstance> {
      const dump = input.environment.FAKE_KEEP_DUMP;
      const hold = input.environment.FAKE_KEEP_HOLD;
      const note = (row: Record<string, unknown>) => { if (dump) appendFileSync(dump, `${JSON.stringify(row)}\n`); };
      const listeners = new Set<RuntimeEventListener>();
      const emit = (event: EmittedEvent) => {
        const full = { eventId: newEventId(), provider: KEEPING_DRIVER_KIND, providerInstanceId: input.instanceId, createdAt: new Date().toISOString(), ...event } as RuntimeEvent;
        for (const listener of Array.from(listeners)) listener(full);
      };
      const sessions = new Map<string, { id: string; context: string[] }>();
      const active = new Map<string, { turnId: string; interrupted: boolean }>();
      return {
        instanceId: input.instanceId,
        driverKind: KEEPING_DRIVER_KIND,
        displayName: input.displayName,
        enabled: input.enabled,
        models: { default: "keep-1", options: [{ id: "keep-1", label: "Keep one" }] },
        snapshot: async () => ({ state: "available", version: "0.0.0-keep" }),
        adapter: {
          provider: KEEPING_DRIVER_KIND,
          capabilities: { sessionModelSwitch: "unsupported" },
          sendTurn: async (turn) => {
            const turnId = `keep-turn-${++counter}`;
            if (turn.sessionReset) sessions.delete(turn.threadId);
            const entry = { turnId, interrupted: false };
            active.set(turn.threadId, entry);
            emit({ type: "turn.started", threadId: turn.threadId, turnId });
            void (async () => {
              if (hold && existsSync(join(hold, "arm"))) {
                rmSync(join(hold, "arm"), { force: true });
                writeFileSync(join(hold, "waiting"), turn.threadId);
                await waitForFile(join(hold, "go"));
                for (const file of ["go", "waiting"]) rmSync(join(hold, file), { force: true });
              }
              if (entry.interrupted || active.get(turn.threadId) !== entry) return;
              const kept = sessions.get(turn.threadId);
              const session = kept ?? { id: `keep-session-${counter}-${turn.threadId.slice(0, 8)}`, context: [] };
              if (!kept || input.environment.FAKE_KEEP_REPORT_ONCE !== "1") emit({ type: "session.started", sessionId: session.id, model: "keep-1", threadId: turn.threadId, turnId });
              await new Promise(resolve => setTimeout(resolve, 60));
              if (entry.interrupted || active.get(turn.threadId) !== entry) return;
              try { turn.beforeSubmit?.(); } catch {
                note({ threadId: turn.threadId, session: session.id, refused: true });
                active.delete(turn.threadId);
                emit({ type: "turn.completed", ok: false, stopReason: "submission_refused", threadId: turn.threadId, turnId });
                return;
              }
              session.context.push(turn.text);
              sessions.set(turn.threadId, session);
              note({ threadId: turn.threadId, session: session.id, fresh: !kept, prompt: turn.text, context: session.context });
              emit({ type: "item.completed", itemType: "assistant_text", origin: "engine", text: KEPT_REPLY, threadId: turn.threadId, turnId });
              active.delete(turn.threadId);
              emit({ type: "turn.completed", ok: true, threadId: turn.threadId, turnId });
            })();
            return { turnId };
          },
          interruptTurn: async (threadId) => {
            const entry = active.get(threadId);
            if (!entry || entry.interrupted) return;
            entry.interrupted = true;
            active.delete(threadId);
            emit({ type: "turn.completed", ok: false, stopReason: "interrupted", threadId, turnId: entry.turnId });
          },
          resetSession: async (threadId) => { sessions.delete(threadId); note({ threadId, reset: true }); },
          respondToRequest: async () => "unavailable" as const,
          hasSession: (threadId) => sessions.has(threadId),
          stopAll: async () => { active.clear(); },
          onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
        },
        dispose: async () => { listeners.clear(); active.clear(); sessions.clear(); },
      };
    },
  };
}
