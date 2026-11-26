// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// In-process ProviderDriver for the QW question lane (1.0.4 Q1, Q1b, Q2): a turn that can stay live while a test answers a
// card, an engine that can or cannot be steered, and a reply that carries a ```murage-question fence. It hands the turn id
// back at once (turn.started) and runs the submission fence before replying, as the other fixture drivers do.
// Registered into BUILT_IN_DRIVERS by a verification fixture's instrumentation preload, configured in the instance `environment`:
//   FAKE_ASK_DIR     directory, shared by every instance:
//                    dump.jsonl        one JSON line per turn ({turnId, threadId, text, system}) and per steer ({steer: true, turnId, threadId, text}).
//                    agents-env.json   the agents integration's env of the latest turn that mounted it (its comms token and thread).
//                    hold              written by the test: the next turn takes it (it is removed) and stays live until `release`.
//                    live              the turn id of a held turn, while it is held.
//                    release           written by the test: the named turn takes it and finishes (empty retains the legacy any-turn signal).
//                    reply.txt         written by the test: the next turn to reply says this text (once; it is removed).
//                    limit             written by the test: the next turn to START refuses at its usage limit before doing anything (once; it is removed).
//                    refuse-steer      written by the test: the next steer is rejected and the held turn stays live (once; it is removed).
//                    refuse-steer-idle written by the test: the next steer ends the held turn (as `release` does), waits for it to settle, then is rejected,
//                                      so the server meets an idle bot on the way back from the refused steer (once; it is removed).
//   FAKE_ASK_TOOLS   "1": the engine mounts the agents server (agentsMcp), so ask_user is its tool. Otherwise it is text only.
//                    "switch": as "1", except while the test has written `no-tools` in FAKE_ASK_DIR: then it reports no tools (so an
//                    answered card's continuation is held), without the bot changing engines (which would end its HighLevel grant).
//   FAKE_ASK_NATIVE  "1": the engine writes the native trace a real engine writes: the turn's prompt as an `out` frame, and (a held turn on a
//                    tools instance, before any phone call can mark the thread) a claude-shaped `in` frame calling a phone tool with args.
//   tool-event.txt   written by the test (tools instances): the held turn, once released, first emits a started and a completed phoneJobs tool item
//                    whose input and result are this text (it is removed), so the event log's phone-tool withholding can be read from disk.
//   FAKE_ASK_STEER   "1": the engine takes a message mid-turn (queueing + steer), as Claude and Fuigo do. Otherwise, as Codex, it cannot.
// The files are one-shot and read by the engine, never the prompt (the prompt carries the conversation, so a marker in it would
// be seen again by later turns). Every other turn replies "Ask reply" and completes.
import { appendFileSync, existsSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AnyProviderDriver, DriverCreateInput, ProviderInstance, RuntimeEvent, RuntimeEventListener, SourceContext } from "../contracts.ts";
import { newEventId } from "../contracts.ts";
import { appendNative } from "../drivers/native.ts";

export const ASK_DRIVER_KIND = "fakeAsk";
export const ASK_REPLY = "Ask reply";

type EmittedEvent = RuntimeEvent extends infer Event
  ? Event extends RuntimeEvent ? Omit<Event, "eventId" | "provider" | "providerInstanceId" | "createdAt"> : never
  : never;

const waitForFile = (ready: () => boolean, stop: () => boolean): Promise<void> => new Promise((resolve) => {
  if (ready() || stop()) return resolve();
  const poll = setInterval(() => { if (!ready() && !stop()) return; clearInterval(poll); resolve(); }, 20);
  poll.unref?.();
});

export function makeAskDriver(kind: string = ASK_DRIVER_KIND): AnyProviderDriver {
  let counter = 0;
  return {
    driverKind: kind,
    metadata: { displayName: "Ask fixture" },
    models: { default: "ask-1", options: [{ id: "ask-1", label: "Ask one" }] },
    decodeConfig: (raw: unknown) => (raw ?? {}) as Record<string, unknown>,
    defaultConfig: () => ({}),
    async create(input: DriverCreateInput<Record<string, unknown>>): Promise<ProviderInstance> {
      const dir = input.environment.FAKE_ASK_DIR ?? "";
      const switchable = input.environment.FAKE_ASK_TOOLS === "switch";
      const tools = input.environment.FAKE_ASK_TOOLS === "1" || switchable;
      const steers = input.environment.FAKE_ASK_STEER === "1";
      const nativeTrace = input.environment.FAKE_ASK_NATIVE === "1";
      const note = (row: Record<string, unknown>) => { if (dir) appendFileSync(join(dir, "dump.jsonl"), `${JSON.stringify(row)}\n`); };
      const listeners = new Set<RuntimeEventListener>();
      const sources = new Map<string, SourceContext | undefined>();
      const emit = (event: EmittedEvent) => {
        const full = { eventId: newEventId(), provider: kind, providerInstanceId: input.instanceId, createdAt: new Date().toISOString(), ...event } as RuntimeEvent;
        // A provider frame carries the host admission captured for its exact
        // turn, including the terminal frame after active work is removed.
        for (const listener of Array.from(listeners)) listener(full, full.turnId ? sources.get(full.turnId) : undefined);
        if (full.type === "turn.completed" && full.turnId) sources.delete(full.turnId);
      };
      const active = new Map<string, { turnId: string; interrupted: boolean }>();
      const adapter: ProviderInstance["adapter"] = {
        provider: kind,
        capabilities: switchable
          ? Object.defineProperty({ sessionModelSwitch: "unsupported", fencedWrites: true, ...(steers ? { queueing: true } : {}) }, "agentsMcp", { enumerable: true, get: () => !existsSync(join(dir, "no-tools")) })
          : { sessionModelSwitch: "unsupported", fencedWrites: true, ...(tools ? { agentsMcp: true } : {}), ...(steers ? { queueing: true } : {}) },
        sendTurn: async (turn) => {
          const turnId = `ask-turn-${++counter}`;
          sources.set(turnId, turn.sourceContext);
          if (dir && turn.integrations?.agents) writeFileSync(join(dir, "agents-env.json"), JSON.stringify(turn.integrations.agents.env));
          if (dir && turn.integrations?.phoneJobs) writeFileSync(join(dir, "phone-jobs-env.json"), JSON.stringify(turn.integrations.phoneJobs.env));
          const entry = { turnId, interrupted: false };
          active.set(turn.threadId, entry);
          emit({ type: "turn.started", threadId: turn.threadId, turnId });
          if (dir && existsSync(join(dir, "limit"))) {
            // A provider limit is one attempted turn; ordinary turns are recorded only at prompt ingress below.
            note({ turnId, threadId: turn.threadId, text: turn.text, system: turn.system ?? "", ...(turn.integrations?.phoneJobs ? { phoneJobs: { tools: turn.integrations.phoneJobs.env.MURAGE_PHONE_TOOLS ?? "", hasToken: Boolean(turn.integrations.phoneJobs.env.MURAGE_CONTROL_TOKEN) } } : {}) });
            rmSync(join(dir, "limit"), { force: true });
            active.delete(turn.threadId);
            emit({ type: "turn.completed", ok: false, stopReason: "usage limit reached", threadId: turn.threadId, turnId });
            return { turnId };
          }
          let attempt: number | void = undefined;
          let enteredWrite = false;
          try {
            attempt = turn.beforeSubmit?.();
            // This append is the fixture engine's actual prompt ingress. A receipt
            // follows its synchronous acceptance, never allocation or validation.
            enteredWrite = true;
            note({ turnId, threadId: turn.threadId, text: turn.text, system: turn.system ?? "", ...(turn.integrations?.phoneJobs ? { phoneJobs: { tools: turn.integrations.phoneJobs.env.MURAGE_PHONE_TOOLS ?? "", hasToken: Boolean(turn.integrations.phoneJobs.env.MURAGE_CONTROL_TOKEN) } } : {}) });
            if (nativeTrace) appendNative(turn.threadId, { dir: "out", source: "fakeAsk", msg: { type: "user", prompt: turn.text, turnId } });
            turn.attemptWritten?.(attempt);
            turn.onEngineWrite?.();
          } catch {
            if (enteredWrite) turn.attemptUncertain?.(attempt);
            else turn.attemptNotWritten?.(attempt);
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
              if (nativeTrace && tools) appendNative(turn.threadId, { dir: "in", source: "fakeAsk", msg: { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_first", name: "mcp__phoneJobs__phone_calendar_read", input: { start: "2026-10-26T09:00:00Z", note: "FIRST-CALL-ARGS-CANARY" } }] } } });
              const releasePath = join(dir, "release"), livePath = join(dir, "live");
              const released = () => {
                try { const target = readFileSync(releasePath, "utf8"); return target === "" || target === turnId; }
                catch { return false; }
              };
              await waitForFile(released, gone);
              if (released()) rmSync(releasePath, { force: true });
              if (existsSync(livePath) && readFileSync(livePath, "utf8") === turnId) rmSync(livePath, { force: true });
              const toolEventPath = join(dir, "tool-event.txt");
              if (tools && !gone() && existsSync(toolEventPath)) {
                const words = readFileSync(toolEventPath, "utf8");
                rmSync(toolEventPath, { force: true });
                const itemId = `ask-tool-${turnId}`;
                emit({ type: "item.started", itemType: "tool", origin: "engine", title: "phone_calendar_read", input: words, toolKind: "mcp", toolIdentity: { namespace: "phoneJobs", name: "phone_calendar_read" }, threadId: turn.threadId, turnId, itemId } as unknown as EmittedEvent);
                emit({ type: "item.completed", itemType: "tool", ok: true, result: words, threadId: turn.threadId, turnId, itemId } as unknown as EmittedEvent);
              }
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
          const livePath = join(dir, "live");
          if (dir && existsSync(livePath) && readFileSync(livePath, "utf8") === entry.turnId) rmSync(livePath, { force: true });
          emit({ type: "turn.completed", ok: false, stopReason: "cancelled", threadId, turnId: entry.turnId });
        },
        // no native session is kept between turns: an authorized replay has nothing to end
        resetSession: async () => {},
        respondToRequest: async () => "unavailable" as const,
        hasSession: () => false,
        stopAll: async () => { active.clear(); sources.clear(); },
        onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      };
      if (steers) {
        adapter.steer = async (threadId, text, beforeWrite) => {
          const entry = active.get(threadId);
          if (!entry || entry.interrupted) return "rejected";
          if (dir && existsSync(join(dir, "refuse-steer"))) { rmSync(join(dir, "refuse-steer"), { force: true }); return "rejected"; }
          if (dir && existsSync(join(dir, "refuse-steer-idle"))) {
            rmSync(join(dir, "refuse-steer-idle"), { force: true });
            writeFileSync(join(dir, "release"), "");
            await new Promise<void>((resolve) => { const poll = setInterval(() => { if (active.get(threadId) !== entry) { clearInterval(poll); resolve(); } }, 10); poll.unref?.(); });
            await new Promise((resolve) => setTimeout(resolve, 300));
            return "rejected";
          }
          try { beforeWrite?.(); } catch { return "rejected"; }
          note({ steer: true, turnId: entry.turnId, threadId, text });
          return "delivered";
        };
      }
      return {
        instanceId: input.instanceId,
        driverKind: kind,
        displayName: input.displayName,
        enabled: input.enabled,
        models: { default: "ask-1", options: [{ id: "ask-1", label: "Ask one" }] },
        snapshot: async () => ({ state: "available", version: "0.0.0-ask" }),
        adapter,
        dispose: async () => { listeners.clear(); active.clear(); sources.clear(); },
      };
    },
  };
}
