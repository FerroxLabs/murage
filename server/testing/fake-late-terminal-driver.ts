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
//                            ({turnId, threadId, skillAuthoring}) so a test can
//                            count dispatches and see which ran with the
//                            skill-authoring tools (agentsMcp is declared, so a
//                            hop-0 turn takes the round's claim when the skill
//                            recorder feature is on; the agents integration is
//                            otherwise ignored here). browserMcp is declared
//                            too, so a bot with the browser on mints its
//                            capability before the room claim (RED2L); the
//                            browser integration is likewise ignored.
//   FAKE_LATE_AGENTS_ENV     path: overwritten per sendTurn with the agents
//                            integration's env as JSON (the turn's comms token
//                            and thread), so a test can act as that turn on
//                            /api/internal while the session gate holds it.
//   FAKE_LATE_HANDBACK       "1": sendTurn returns the turn id first and the
//                            prompt is submitted later, once the session gate
//                            exists (the ACP and Codex shape). The submission
//                            fence runs right before that write; refused, the
//                            turn settles failed (stopReason
//                            "submission_refused") with nothing written. Each
//                            write that happens appends {prompt: true, turnId}.
//   FAKE_LATE_GATE_EACH      "1" (with FAKE_LATE_HANDBACK): the session gate is
//                            taken by the turn that passes it (the gate and
//                            its `.waiting` file are removed), so every later
//                            turn waits for its own: a test can land a revoke
//                            before each attempt's late write.
//   FAKE_LATE_SESSION        "1" (with FAKE_LATE_HANDBACK): the engine reports its native session (session.started) after handing the
//                            id back and before the prompt is written, as ACP does: the turn's resume cursor when it resumes, a new
//                            session otherwise. The write waits a moment, so the harness folds the session first.
//   FAKE_LATE_MEMORY_MCP     "1": the engine declares memoryMcp, so the harness may mount the memory tools (memory_* and thread_*); each
//                            dump line then also says whether the turn carried that mount (`memory`) and the threadRecall flag.
//   FAKE_LATE_ENGINE_REFUSES "1" (with FAKE_LATE_HANDBACK): the engine itself refuses the late write (nothing written, stopReason
//                            "submission_refused") without the harness's fence having refused it: a refusal nothing re-dispatches.
//   FAKE_LATE_REFUSE_AFTER_FENCE "1" (with FAKE_LATE_HANDBACK): the harness's fence passes (the attempt is released), then the engine refuses the
//                            write without confirming it (stopReason "submission_refused"): the owner's blocked-rebuild NOTE path, a refusal after a released attempt.
//   FAKE_LATE_PLAIN_SESSION  "1" (without FAKE_LATE_HANDBACK): the engine reports its native session before it replies: the turn's resume
//                            cursor when it resumes, a new session otherwise (a long chat on an engine that keeps its session).
//   FAKE_LATE_DUMP_CONTEXT   "1": each dump line also says whether the turn carried a memory frame (`memoryContext`), the memory mount
//                            (`memory`), a session reset (`sessionReset`) and a resume cursor (`resumed`).
//   FAKE_LATE_TEARDOWN       "1": the adapter has awaitTurnTeardown, confirming the close 50 ms after the terminal event.
//   FAKE_LATE_TOOL_FIRST     "1" (with FAKE_LATE_HANDBACK): a tool starts and completes before the late write (a later round's
//                            submission, as openai-chat runs one per round), so a refusal there must card the turn, never rebuild it.
//   FAKE_LATE_PRE_HANDBACK_GATE path (with FAKE_LATE_HANDBACK): sendTurn hands the id back only once this file exists (writes
//                            `<path>.waiting` while held): the window between the adapter call and acceptance, where a revoke
//                            refuses the turn at acceptance with nothing written (DELETE-REVOKE-SCOPE (a)).
//   FAKE_LATE_FENCED_WRITES  "1": the adapter declares fencedWrites (true here: its only write is the late one behind beforeSubmit).
//   FAKE_LATE_IGNORE_STOP    "1" (with FAKE_LATE_HANDBACK): the late write is still attempted after a stop; each refused write then
//                            appends {refused: true, turnId} (only in this mode: other tests count the dump's rows).
//   FAKE_LATE_DUMP_FRAME     "1": each prompt line also carries the memory frame's text as the engine would receive it (`frame`).
//                            Without FAKE_LATE_HANDBACK it also writes that prompt line, once the fence has passed.
//   FAKE_LATE_TWO_FENCES     "1" (without FAKE_LATE_HANDBACK): the Claude and Antigravity shape (1.0.19 D3). The launch fence runs and the
//                            process starts, sending no prompt bytes: the launch attempt is reported notWritten by id. The session gate
//                            holds the turn, then the prompt's own second fence runs. Refused there, sendTurn THROWS (nothing handed back,
//                            nothing written). Passed, the prompt is written: one {prompt: true} dump row and the usual reply.
//   FAKE_LATE_ACCEPTED_RELAUNCH "1" (with FAKE_LATE_HANDBACK): the Claude shape on an ACCEPTED turn (1.0.19 D2b/R3): after the id is handed back
//                            the engine relaunches: the launch fence passes (a fenced attempt, no prompt bytes), the session gate holds the turn,
//                            then the prompt's own second fence runs. The driver settles the launch attempt (attemptSettled) BEFORE that fence and
//                            attemptNotWritten after it, in claude.ts's order. Refused there, the turn is entirely unwritten and must rebuild.
// An uninterrupted turn replies "Hello from late" and completes on its own.
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type {
  AnyProviderDriver,
  DriverCreateInput,
  ProviderInstance,
  RuntimeEvent,
  RuntimeEventListener,
} from "../contracts.ts";
import { newEventId } from "../contracts.ts";
import { fencedSubmit } from "../drivers/engine-input.ts";

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

/** Positive checked-write fixtures opt in; raw and unknown-action fixtures keep
 * their original unknown-submission posture. */
export function makeLateTerminalDriver(options: { fencedDefaults?: boolean } = {}): AnyProviderDriver {
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
      const agentsEnvPath = input.environment.FAKE_LATE_AGENTS_ENV;
      const listeners = new Set<RuntimeEventListener>();
      const sources = new Map<string, import("../contracts.ts").SourceContext>();
      const emit = (event: EmittedEvent) => {
        const full = { eventId: newEventId(), provider: LATE_TERMINAL_DRIVER_KIND, providerInstanceId: input.instanceId, createdAt: new Date().toISOString(), ...event } as RuntimeEvent;
        // Snapshot: a listener may unsubscribe while the event is delivered.
        const snapshot = Array.from(listeners);
        for (const listener of snapshot) listener(full, sources.get(full.turnId ?? ""));
        if (full.type === "turn.completed") sources.delete(full.turnId ?? "");
      };
      const active = new Map<string, { turnId: string; interrupted: boolean }>();
      // FAKE_LATE_ASK_GATE: a held turn raises one native ask (request.opened) each time the file's text changes (a round name).
      // (The test that sets it records the answers itself, by wrapping this adapter's respondToRequest: other tests rewrite that line
      // of this file by its exact text.) The ask's input is nested deeper than the decision core's bounded projection
      // reads (32 levels) and ends in a passive probe (a Proxy that only records). The bus's own input accounting
      // (harness/event-charge.ts) stops at a Proxy with types.isProxy and never enumerates it; a raw copy of the whole input
      // (decision/wipe-input.ts, Object.keys to depth 128) does. Each enumeration is appended to `<path>.rawread` with the module
      // that did it (`by`, from the call stack).
      const askGate = input.environment.FAKE_LATE_ASK_GATE;
      const asking = new Map<string, string>();
      const watchAsk = (threadId: string, turnId: string) => {
        if (!askGate) return;
        asking.set(threadId, turnId);
        let last = "";
        const timer = setInterval(() => {
          if (asking.get(threadId) !== turnId) { clearInterval(timer); return; }
          let round = "";
          try { round = readFileSync(askGate, "utf8"); } catch { return; }
          if (!round || round === last) return;
          last = round;
          const enumeratedBy = () => (new Error().stack ?? "").split("\n").map(frame => /([\w.-]+\.ts):\d+:\d+/.exec(frame)?.[1]).find(file => file && file !== "fake-late-terminal-driver.ts") ?? "unknown";
          let deep: unknown = new Proxy({}, { ownKeys: () => { appendFileSync(`${askGate}.rawread`, `${JSON.stringify({ round, threadId, by: enumeratedBy() })}\n`); return []; } });
          for (let level = 0; level < 40; level++) deep = { next: deep };
          emit({ type: "request.opened", requestType: "permission", requestId: `ask-${round}-${turnId}`, tool: "Bash", summary: "Run a command", toolCall: { name: "Bash", input: { command: "echo fixture-native-ask", deep } }, threadId, turnId } as EmittedEvent);
        }, 25);
        timer.unref();
      };
      return {
        instanceId: input.instanceId,
        driverKind: LATE_TERMINAL_DRIVER_KIND,
        displayName: input.displayName,
        enabled: input.enabled,
        models: { default: "late-1", options: [{ id: "late-1", label: "Late one" }] },
        snapshot: async () => ({ state: "available", version: "0.0.0-late" }),
        adapter: {
          provider: LATE_TERMINAL_DRIVER_KIND,
          capabilities: { sessionModelSwitch: "unsupported", agentsMcp: true, browserMcp: true, ...(input.environment.FAKE_LATE_MEMORY_MCP === "1" ? { memoryMcp: true } : {}), ...((input.environment.FAKE_LATE_FENCED_WRITES === "1" || options.fencedDefaults && input.environment.FAKE_LATE_UNKNOWN_ACTION !== "1") ? { fencedWrites: true } : {}) },
          sendTurn: async (turn) => {
            const turnId = `late-turn-${++turnCounter}`;
            if (turn.sourceContext) sources.set(turnId, turn.sourceContext);
            const skillAuthoring = turn.integrations?.agents?.env.MURAGE_SKILL_AUTHORING_ENABLED === "1";
            const memoryMount = input.environment.FAKE_LATE_MEMORY_MCP === "1" ? { memory: Boolean(turn.integrations?.memory), threadRecall: turn.threadRecall === true } : {};
            const context = input.environment.FAKE_LATE_DUMP_CONTEXT === "1" ? { memoryContext: turn.memoryContext !== undefined, memory: Boolean(turn.integrations?.memory), sessionReset: turn.sessionReset === true, resumed: typeof turn.resumeCursor === "string" } : {};
            if (dump) appendFileSync(dump, `${JSON.stringify({ turnId, threadId: turn.threadId, skillAuthoring, ...memoryMount, ...context })}\n`);
            if (agentsEnvPath && turn.integrations?.agents) writeFileSync(agentsEnvPath, JSON.stringify(turn.integrations.agents.env));
            if (input.environment.FAKE_LATE_HANDBACK === "1") {
              const entry = { turnId, interrupted: false };
              active.set(turn.threadId, entry);
              emit({ type: "turn.started", threadId: turn.threadId, turnId });
              // the late write starts only after the id is handed back, as ACP's does
              const preGate = input.environment.FAKE_LATE_PRE_HANDBACK_GATE;
              if (preGate && !existsSync(preGate)) {
                writeFileSync(`${preGate}.waiting`, turnId);
                await waitForFile(preGate, 25);
              }
              void (async () => {
                // as ACP's handshake: the write comes after the harness has heard the id (its acceptance runs first)
                const relaunch = input.environment.FAKE_LATE_ACCEPTED_RELAUNCH === "1";
                await new Promise(resolve => setTimeout(resolve, 20));
                let launchAttempt: number | void = undefined;
                if (relaunch) launchAttempt = turn.beforeSubmit?.();
                if (sessionGate && !existsSync(sessionGate)) {
                  writeFileSync(`${sessionGate}.waiting`, turnId);
                  await waitForFile(sessionGate, 25);
                }
                if (sessionGate && input.environment.FAKE_LATE_GATE_EACH === "1") for (const file of [sessionGate, `${sessionGate}.waiting`]) rmSync(file, { force: true });
                // FAKE_LATE_IGNORE_STOP: a misbehaving engine that still tries its write after it was stopped (the seal must refuse it)
                if (input.environment.FAKE_LATE_IGNORE_STOP !== "1" && (entry.interrupted || active.get(turn.threadId) !== entry)) return;
                if (input.environment.FAKE_LATE_SESSION === "1") {
                  const resumed = !turn.sessionReset && typeof turn.resumeCursor === "string" ? turn.resumeCursor : undefined;
                  emit({ type: "session.started", sessionId: resumed ?? `late-session-${turnCounter}-${turn.threadId.slice(0, 8)}`, model: "late-1", threadId: turn.threadId, turnId });
                  await new Promise(resolve => setTimeout(resolve, 60));
                  if (entry.interrupted || active.get(turn.threadId) !== entry) return;
                }
                if (input.environment.FAKE_LATE_ENGINE_REFUSES === "1") {
                  active.delete(turn.threadId);
                  emit({ type: "turn.completed", ok: false, stopReason: "submission_refused", threadId: turn.threadId, turnId });
                  return;
                }
                if (input.environment.FAKE_LATE_TOOL_FIRST === "1") {
                  if (dump) appendFileSync(dump, `${JSON.stringify({ tool: true, turnId, threadId: turn.threadId })}\n`);
                  emit({ type: "item.started", itemType: "tool", origin: "engine", itemId: `tool-${turnId}`, title: "write_file", threadId: turn.threadId, turnId });
                  emit({ type: "item.completed", itemType: "tool", itemId: `tool-${turnId}`, ok: true, result: "written", threadId: turn.threadId, turnId });
                }
                if (relaunch) turn.attemptSettled?.(launchAttempt);
                let writing = false;
                try {
                  turn.beforeSubmit?.();
                  if (relaunch) turn.attemptNotWritten?.(launchAttempt);
                  if (input.environment.FAKE_LATE_REFUSE_AFTER_FENCE !== "1") fencedSubmit(turn, () => {
                    writing = true;
                    if (dump) appendFileSync(dump, `${JSON.stringify({ prompt: true, turnId, threadId: turn.threadId, ...(input.environment.FAKE_LATE_DUMP_FRAME === "1" ? { frame: `${turn.system ?? ""}\n${JSON.stringify(turn.memoryContext ?? null)}\n${turn.text ?? ""}` } : {}) })}\n`);
                  }, turn.text);
                } catch (error) {
                  if (writing) throw error;
                  if (relaunch) turn.attemptNotWritten?.(launchAttempt);
                  if (dump && input.environment.FAKE_LATE_IGNORE_STOP === "1") appendFileSync(dump, `${JSON.stringify({ refused: true, turnId, threadId: turn.threadId })}\n`);
                  if (active.get(turn.threadId) === entry) active.delete(turn.threadId);
                  emit({ type: "turn.completed", ok: false, stopReason: "submission_refused", threadId: turn.threadId, turnId });
                  return;
                }
                // A released attempt without a confirmed write stays uncertain.
                if (input.environment.FAKE_LATE_REFUSE_AFTER_FENCE === "1") {
                  active.delete(turn.threadId);
                  emit({ type: "turn.completed", ok: false, stopReason: "submission_refused", threadId: turn.threadId, turnId });
                  return;
                }
                turn.onEngineWrite?.();
                emit({ type: "item.completed", itemType: "assistant_text", origin: "engine", text: "Hello from late", threadId: turn.threadId, turnId });
                active.delete(turn.threadId);
                emit({ type: "turn.completed", ok: true, threadId: turn.threadId, turnId });
              })();
              return { turnId };
            }
            const beforeHandback = (write?: () => void) => {
              try { const attempt = turn.beforeSubmit?.(); write?.(); return attempt; }
              catch (error) { sources.delete(turnId); throw error; }
            };
            const twoFences = input.environment.FAKE_LATE_TWO_FENCES === "1";
            if (twoFences) {
              const attempt = beforeHandback();
              // the launch attempt is settled, not withdrawn: the prompt's own fence follows on the same binding (antigravity.ts, attemptSettled)
              turn.attemptSettled?.(attempt);
            }
            watchAsk(turn.threadId, turnId);
            if (sessionGate && !existsSync(sessionGate)) {
              writeFileSync(`${sessionGate}.waiting`, turnId);
              await waitForFile(sessionGate, 25);
            }
            if (twoFences) {
              // the prompt's own second fence: a refusal throws, the engine has handed nothing back and written nothing (the Claude shape)
              beforeHandback(() => {
                fencedSubmit(turn, () => {
                  if (dump) appendFileSync(dump, `${JSON.stringify({ prompt: true, turnId, threadId: turn.threadId })}\n`);
                }, turn.text);
                turn.onEngineWrite?.();
              });
            }
            // Before handback a refused write throws to the caller; there is
            // no native turn id or terminal event for the harness to bind.
            if (!twoFences && input.environment.FAKE_LATE_UNKNOWN_ACTION !== "1") {
              beforeHandback(() => {
                fencedSubmit(turn, () => {}, turn.text);
                turn.onEngineWrite?.();
              });
            }
            // FAKE_LATE_DUMP_FRAME without FAKE_LATE_HANDBACK: the fence passed, so these are the bytes the engine is given (a refused attempt threw above)
            if (!twoFences && input.environment.FAKE_LATE_UNKNOWN_ACTION !== "1" && dump && input.environment.FAKE_LATE_DUMP_FRAME === "1") appendFileSync(dump, `${JSON.stringify({ prompt: true, turnId, threadId: turn.threadId, frame: `${turn.system ?? ""}\n${JSON.stringify(turn.memoryContext ?? null)}\n${turn.text ?? ""}` })}\n`);
            const entry = { turnId, interrupted: false };
            active.set(turn.threadId, entry);
            emit({ type: "turn.started", threadId: turn.threadId, turnId });
            if (input.environment.FAKE_LATE_UNKNOWN_ACTION === "1" && dump) {
              // A real local fixture side effect before sendTurn resolves.
              appendFileSync(dump, `${JSON.stringify({ prompt: true, action: true, turnId, threadId: turn.threadId })}\n`);
            }
            // The reply follows acceptance on a later tick, so a stop issued
            // inside the acceptance hook is seen before anything is said.
            setTimeout(() => {
              if (entry.interrupted || active.get(turn.threadId) !== entry) return;
              if (input.environment.FAKE_LATE_PLAIN_SESSION === "1") {
                const resumed = !turn.sessionReset && typeof turn.resumeCursor === "string" ? turn.resumeCursor : undefined;
                emit({ type: "session.started", sessionId: resumed ?? `plain-session-${turnCounter}-${turn.threadId.slice(0, 8)}`, model: "late-1", threadId: turn.threadId, turnId });
              }
              emit({ type: "item.completed", itemType: "assistant_text", origin: "engine", text: "Hello from late", threadId: turn.threadId, turnId });
              active.delete(turn.threadId);
              emit({ type: "turn.completed", ok: true, threadId: turn.threadId, turnId });
            }, 25);
            return { turnId };
          },
          interruptTurn: async (threadId) => {
            asking.delete(threadId);
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
          // FAKE_LATE_TEARDOWN: the engine ends a turn by closing its child, confirmed a moment after the terminal event.
          ...(input.environment.FAKE_LATE_TEARDOWN === "1" ? { awaitTurnTeardown: async () => {
            await new Promise(resolve => setTimeout(resolve, 50));
            return { closeConfirmed: true as const };
          } } : {}),
          respondToRequest: async () => "unavailable" as const,
          hasSession: () => false,
          stopAll: async () => { active.clear(); },
          onEvent: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
        dispose: async () => { listeners.clear(); active.clear(); sources.clear(); },
      };
    },
  };
}
