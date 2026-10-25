// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// In-process ProviderDriver for the QW question lane (1.0.4 Q1, Q1b, Q2): a turn that can stay live while a test answers a
// card, an engine that can or cannot be steered, and a reply that carries a ```murage-question fence. It hands the turn id
// back at once (turn.started) and runs the submission fence before replying, as the other fixture drivers do.
// Registered into BUILT_IN_DRIVERS by a verification fixture's instrumentation preload, configured in the instance `environment`:
//   FAKE_ASK_DIR     directory, shared by every instance:
//                    dump.jsonl        one JSON line per turn ({turnId, threadId, text}) and per steer ({steer: true, turnId, threadId, text}).
//                    agents-env.json   the agents integration's env of the latest turn that mounted it (its comms token and thread).
//                    hold              written by the test: the next turn takes it (it is removed) and stays live until `release`.
//                    live              the turn id of a held turn, while it is held.
//                    release           written by the test: the held turn takes it (it is removed) and finishes.
//                    reply.txt         written by the test: the next turn to reply says this text (once; it is removed).
//   FAKE_ASK_TOOLS   "1": the engine mounts the agents server (agentsMcp), so ask_user is its tool. Otherwise it is text only.
//   FAKE_ASK_STEER   "1": the engine takes a message mid-turn (queueing + steer), as Claude and Fuigo do. Otherwise, as Codex, it cannot.
// The files are one-shot and read by the engine, never the prompt (the prompt carries the conversation, so a marker in it would
// be seen again by later turns). Every other turn replies "Ask reply" and completes.
import { appendFileSync, existsSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AnyProviderDriver, DriverCreateInput, ProviderInstance, RuntimeEvent, RuntimeEventListener } from "../contracts.ts";
import { newEventId } from "../contracts.ts";

export const ASK_DRIVER_KIND = "fakeAsk";
export const ASK_REPLY = "Ask reply";

type EmittedEvent = RuntimeEvent extends infer Event
  ? Event extends RuntimeEvent ? Omit<Event, "eventId" | "provider" | "providerInstanceId" | "createdAt"> : never
  : never;

const waitForFile = (path: string, stop: () => boolean): Promise<void> => new Promise((resolve) => {
  if (existsSync(path) || stop()) return resolve();
  const poll = setInterval(() => { if (!existsSync(path) && !stop()) return; clearInterval(poll); resolve(); }, 20);
  poll.unref?.();
});

export function makeAskDriver(): AnyProviderDriver {
  let counter = 0;
  return {
    driverKind: ASK_DRIVER_KIND,
    metadata: { displayName: "Ask fixture" },
    models: { default: "ask-1", options: [{ id: "ask-1", label: "Ask one" }] },
    decodeConfig: (raw: unknown) => (raw ?? {}) as Record<string, unknown>,
    defaultConfig: () => ({}),
    async create(input: DriverCreateInput<Record<string, unknown>>): Promise<ProviderInstance> {
      const dir = input.environment.FAKE_ASK_DIR ?? "";
      const tools = input.environment.FAKE_ASK_TOOLS === "1";
      const steers = input.environment.FAKE_ASK_STEER === "1";
      const note = (row: Record<string, unknown>) => { if (dir) appendFileSync(join(dir, "dump.jsonl"), `${JSON.stringify(row)}\n`); };
      const listeners = new Set<RuntimeEventListener>();
      const emit = (event: EmittedEvent) => {
        const full = { eventId: newEventId(), provider: ASK_DRIVER_KIND, providerInstanceId: input.instanceId, createdAt: new Date().toISOString(), ...event } as RuntimeEvent;
        for (const listener of Array.from(listeners)) listener(full);
      };
      const active = new Map<string, { turnId: string; interrupted: boolean }>();
      const adapter: ProviderInstance["adapter"] = {
        provider: ASK_DRIVER_KIND,
        capabilities: { sessionModelSwitch: "unsupported", ...(tools ? { agentsMcp: true } : {}), ...(steers ? { queueing: true } : {}) },
        sendTurn: async (turn) => {
          const turnId = `ask-turn-${++counter}`;
          note({ turnId, threadId: turn.threadId, text: turn.text });
          if (dir && turn.integrations?.agents) writeFileSync(join(dir, "agents-env.json"), JSON.stringify(turn.integrations.agents.env));
          const entry = { turnId, interrupted: false };
          active.set(turn.threadId, entry);
          emit({ type: "turn.started", threadId: turn.threadId, turnId });
          try { turn.beforeSubmit?.(); } catch {
            active.delete(turn.threadId);
            emit({ type: "turn.completed", ok: false, stopReason: "submission_refused", threadId: turn.threadId, turnId });
            return { turnId };
          }
          void (async () => {
            const gone = () => entry.interrupted || active.get(turn.threadId) !== entry;
            const held = Boolean(dir) && existsSync(join(dir, "hold"));
            if (held) {
              rmSync(join(dir, "hold"), { force: true });
              writeFileSync(join(dir, "live"), turnId);
              await waitForFile(join(dir, "release"), gone);
              rmSync(join(dir, "release"), { force: true });
              rmSync(join(dir, "live"), { force: true });
            } else {
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
            if (gone()) return;
            let text = ASK_REPLY;
            const replyPath = join(dir, "reply.txt");
            if (dir && existsSync(replyPath)) { text = readFileSync(replyPath, "utf8"); rmSync(replyPath, { force: true }); }
            emit({ type: "item.completed", itemType: "assistant_text", origin: "engine", text, threadId: turn.threadId, turnId });
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
          if (dir) rmSync(join(dir, "live"), { force: true });
          emit({ type: "turn.completed", ok: false, stopReason: "interrupted", threadId, turnId: entry.turnId });
        },
        // no native session is kept between turns: an authorized replay has nothing to end
        resetSession: async () => {},
        respondToRequest: async () => "unavailable" as const,
        hasSession: () => false,
        stopAll: async () => { active.clear(); },
        onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      };
      if (steers) {
        adapter.steer = async (threadId, text, beforeWrite) => {
          const entry = active.get(threadId);
          if (!entry || entry.interrupted) return "rejected";
          try { beforeWrite?.(); } catch { return "rejected"; }
          note({ steer: true, turnId: entry.turnId, threadId, text });
          return "delivered";
        };
      }
      return {
        instanceId: input.instanceId,
        driverKind: ASK_DRIVER_KIND,
        displayName: input.displayName,
        enabled: input.enabled,
        models: { default: "ask-1", options: [{ id: "ask-1", label: "Ask one" }] },
        snapshot: async () => ({ state: "available", version: "0.0.0-ask" }),
        adapter,
        dispose: async () => { listeners.clear(); active.clear(); },
      };
    },
  };
}
