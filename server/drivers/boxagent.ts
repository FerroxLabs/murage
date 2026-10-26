import { NO_TOOL_SURFACE, renderMurageTurn } from "../murage-tool-surface.ts";
// Box agent driver — the purest form of the idea: the turn runs ON the
// bot's own cloud computer (box.ascii.dev), not on this machine. Uses the
// Box substrate's native agent facility:
//   POST /boxes/{id}/prompt   {provider: codex|claude-code, model, prompt}
//   GET  /boxes/{id}/prompts/{promptId}    run status
//   GET  /boxes/{id}/events                work events (polled)
//   POST /boxes/{id}/interrupt             stop running work
// The agent has the box's full desktop (Chrome, shell, disk) — the server
// separately polls screenshots so the chat shows the bot's screen live.
//
// The event payload shapes are tolerated liberally and teed verbatim to
// the native log — the same protocol-drift armor as every other driver.
import { createHash } from "node:crypto";
import { awaitIntake, isIntakeOpen } from "../harness/intake.ts";

import type {
  DriverCreateInput,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { appendNative } from "./native.ts";
import { BOX_AGENT_API, BOX_RUN_DONE, BOX_RUN_ENDED, CLOUD_COMPUTER_UNNAMED_TURN, cloudTurnFinished, cloudTurnStrict, sendCloudPrompt, stopCloudTurn } from "../cloud-computer-turns.ts";

const DRIVER_KIND = "boxAgent";
const BOX_API = BOX_AGENT_API;

const MODELS = {
  default: "claude-fable-5",
  options: [
    { id: "claude-fable-5-1", label: "Claude Fable 5.1 · on the box" },
    { id: "claude-fable-5", label: "Claude Fable 5 · on the box" },
    { id: "sonnet", label: "Claude Sonnet · on the box" },
    { id: "gpt-5.4", label: "GPT-5.4 (Codex) · on the box" },
  ],
};

/** Fields that name or time an event rather than say what happened. */
const EVENT_IDENTITY_KEYS = new Set(["id", "eventId", "ts", "timestamp", "time", "createdAt", "created_at"]);

const providerFor = (model: string) => (model.startsWith("gpt") ? "codex" : "claude-code");
/** An event's identity, the same for the snapshot before a prompt and the poll after it. */
const eventId = (ev: any): string => String(ev?.id ?? ev?.eventId ?? JSON.stringify(ev).slice(0, 120));
/** The prompt an event names, when it names one (CLOUD-COMPUTER-BOOT-105 section 6 item 4). */
const eventPrompt = (ev: any): string | undefined => {
  const named = ev?.promptId ?? ev?.promptRunId ?? ev?.data?.promptId ?? ev?.data?.promptRunId;
  return typeof named === "string" && named ? named : undefined;
};

export interface BoxAgentConfig {
  pollMs: number;
}

function decodeConfig(raw: unknown): BoxAgentConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  return { pollMs: typeof o.pollMs === "number" ? o.pollMs : 2500 };
}

export const BoxAgentDriver: ProviderDriver<BoxAgentConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Computer", supportsMultipleInstances: false },
  models: MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<BoxAgentConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const token = input.environment.BOX_TOKEN ?? process.env.BOX_TOKEN ?? "";
    const listeners = new Set<RuntimeEventListener>();
    const active = new Map<string, { cancel: () => void; turnId: string; boxId: string }>();

    const emit = (event: RuntimeEvent) => {
      for (const l of [...listeners]) l(event);
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });

    const api = async (path: string, opts: RequestInit = {}) => {
      const res = await fetch(`${BOX_API}${path}`, {
        ...opts,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...opts.headers },
        signal: (opts as any).signal ?? AbortSignal.timeout(30_000),
      });
      const body: any = await res.json().catch(() => null);
      if (!res.ok || body?.ok === false) {
        throw new Error(body?.code ?? body?.error ?? `box HTTP ${res.status}`);
      }
      return body;
    };

    const sendTurn = async (turn: SendTurnInput) => {
    turn = renderMurageTurn(turn, NO_TOOL_SURFACE, {});
      const { threadId } = turn;
      const computer = turn.integrations?.computer;
      const boxId = computer && (!computer.kind || computer.kind === "box") ? computer.boxId : undefined;
      if (!token) throw new Error("Cloud VM is not connected yet. Add your Box key in App Settings → Computer & browser.");
      if (!boxId) {
        throw new Error("this bot has no computer yet: open the Computer panel and provision one");
      }
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      const turnId = newId();
      const model = turn.model || MODELS.default;

      const prompt = [
        turn.system,
        "You are working on your own cloud computer: its desktop, Chrome, and shell are yours.",
        "",
        turn.text,
      ]
        .filter((s) => s !== undefined)
        .join("\n");

      // CLOUD-COMPUTER-BOOT-105 C3: the send runs under the box's lock. Work a restart or a failed Stop left on this box is confirmed
      // stopped first (or the send is refused), the events listed now are taken as seen, and the prompt is on disk before it is sent.
      // The submission fence (SendTurnInput.beforeSubmit) is called right before the POST's fetch, with no await between them: a refusal
      // throws, nothing is sent.
      const sent = await sendCloudPrompt({
        turnId, boxId, threadId, token,
        ...(turn.beforeSubmit ? { beforeSubmit: turn.beforeSubmit } : {}),
        events: async () => { const listed: any = await api(`/boxes/${boxId}/events`); return listed?.events ?? listed?.items ?? []; },
        post: async () => {
          const res = await fetch(`${BOX_API}/boxes/${boxId}/prompt`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ provider: providerFor(model), model, prompt }),
            signal: AbortSignal.timeout(30_000),
          });
          return { status: res.status, body: await res.json().catch(() => null) };
        },
      });
      const started: any = sent.body;
      appendNative(threadId, { dir: "out", source: "box.prompt", msg: { model, prompt, response: started } });
      // real shape (2026-08): {type:"prompt.queued", promptId, promptRun:{id,…},
      // id:<box id>} — never fall back to the bare id, it's the box's
      const promptId = sent.promptId;
      // section 7.2 E1: a 2xx that names no prompt cannot be told apart from any other work on the box. Nothing of it is read; the entry is
      // fenced (the next send clears it by the no-id rule) and the turn ends here, saying so.
      if (!promptId) {
        cloudTurnFinished(turnId, "unproven");
        emit({ ...base(threadId, turnId), type: "turn.started" });
        emit({ ...base(threadId, turnId), type: "runtime.error", message: CLOUD_COMPUTER_UNNAMED_TURN });
        emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "error", cost: null });
        return { turnId };
      }

      let cancelled = false;
      // Stop ends every wait of this turn at once, including the wait for room on the bus
      const stopped = new AbortController();
      const unlessStopped = (wait: Promise<void>): Promise<void> => stopped.signal.aborted ? Promise.resolve() : new Promise<void>((resolve, reject) => {
        const onStop = () => resolve();
        stopped.signal.addEventListener("abort", onStop, { once: true });
        wait.then(() => { stopped.signal.removeEventListener("abort", onStop); resolve(); }, (error: unknown) => { stopped.signal.removeEventListener("abort", onStop); reject(error); });
      });
      active.set(threadId, {
        turnId,
        boxId,
        cancel: () => {
          cancelled = true;
          stopped.abort();
          // C5, section 8: no interrupt from here. The interrupt is box-wide, so it is sent only by stopCloudTurn, under the box lock, when no
          // other turn on the box still needs it; the Stop is confirmed by the prompt's own status, or the box is fenced until it is cleared
          void stopCloudTurn(turnId, token).catch((error) => console.error("cloud computer: the Stop could not be confirmed", error));
        },
      });
      emit({ ...base(threadId, turnId), type: "turn.started" });
      emit({ ...base(threadId, turnId), type: "session.started", sessionId: promptId, model });

      // poll events + run status until the prompt settles
      (async () => {
        // C3: what the box listed before this prompt is never this turn's work
        const seen = new Set<string>(sent.before.map(eventId));
        /** Waits for the bus to have room for this thread before the next poll or the next emitted event. */
        const gate = async () => { if (!cancelled && !isIntakeOpen(threadId)) await unlessStopped(awaitIntake(threadId)); };
        // No clock of its own (0.1.61): every new box event reaches the
        // thread as activity, and the thread's silence watch (the owner's
        // room setting in a room) stops a run that goes quiet, through
        // interruptTurn, like every other engine's turn.
        let lastText = "";
        let pendingText = "";
        /** Emit unflushed deltas as assistant_text and reset pendingText. */
        const flushAssistantText = () => {
          const text = pendingText;
          pendingText = "";
          if (!text.trim()) return;
          emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", origin: "engine", text });
        };
        /** Stream a full-text snapshot as a delta and accumulate it for flush. */
        const ingest = (text: string) => {
          const delta = text.startsWith(lastText) ? text.slice(lastText.length) : text;
          lastText = text;
          if (!delta) return;
          pendingText += delta;
          emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta });
        };
        // Only an event that says something new is work. A heartbeat (a
        // fresh id or time around the same content) or a resent snapshot is
        // not, so a box stuck sending them still goes quiet for the watch.
        const shownContents = new Set<string>();
        const working = (ev: Record<string, unknown>) => {
          // at any depth: a heartbeat's time can sit inside its data
          const content = JSON.stringify(ev, (name, value) => (EVENT_IDENTITY_KEYS.has(name) ? undefined : value)) ?? "";
          const key = createHash("sha256").update(content).digest("base64");
          if (shownContents.has(key)) return;
          if (shownContents.size >= 1_000) shownContents.clear();
          shownContents.add(key);
          emit({ ...base(threadId, turnId), type: "item.updated", itemType: "reasoning", tokens: null });
        };
        try {
          for (;;) {
            if (cancelled) break;
            // the bus is full for this thread: stop polling until it has room, so a box that keeps producing cannot grow it
            await gate();
            if (cancelled) break;
            await unlessStopped(new Promise<void>((r) => setTimeout(r, config.pollMs)));
            await gate();
            if (cancelled) break;
            const events: any = await api(`/boxes/${boxId}/events`, { signal: AbortSignal.any([stopped.signal, AbortSignal.timeout(30_000)]) }).catch(() => null);
            // a Stop that landed while the events call was in flight: nothing from it is processed or emitted
            if (cancelled) break;
            const list: any[] = events?.events ?? events?.items ?? [];
            for (const ev of list) {
              await gate();
              if (cancelled) break;
              const id = eventId(ev);
              if (seen.has(id)) continue;
              seen.add(id);
              // section 7.2 E2: an event that names another prompt is not this turn's
              const named = eventPrompt(ev);
              if (named !== undefined && named !== promptId) continue;
              // E3: on a box that was not clean at the send, an event that names no prompt may be earlier work: activity only, never text,
              // a tool row, an end or a line in this thread's native trace (the reply is this prompt's own status result)
              if (named === undefined && cloudTurnStrict(turnId)) { working(ev); continue; }
              appendNative(threadId, { dir: "in", source: "box.events", msg: ev });
              const kind = String(ev.type ?? ev.kind ?? "");
              // "response" events carry the agent's text at data.content —
              // the FULL text so far, not a chunk. Clients accumulate
              // deltas, so forward only the growth; a drifted (non-prefix)
              // event re-sends whole and the settled message replaces the
              // stream anyway.
              const text = ev.text ?? ev.message ?? ev.data?.text ?? ev.data?.content ?? null;
              if (/assistant|message|output|response/i.test(kind) && typeof text === "string" && text.trim()) {
                ingest(text);
              } else if (/tool|command|exec|browse/i.test(kind)) {
                flushAssistantText();
                emit({
                  ...base(threadId, turnId),
                  type: "item.started",
                  itemType: "tool",
                  origin: "engine",
                  itemId: id,
                  title: String(ev.title ?? ev.command ?? kind).slice(0, 80),
                });
              } else {
                // work the chat does not show is still work
                working(ev);
              }
            }
            if (cancelled) break;
            {
              await gate();
              if (cancelled) break;
              const status: any = await api(`/boxes/${boxId}/prompts/${promptId}`, { signal: AbortSignal.any([stopped.signal, AbortSignal.timeout(30_000)]) }).catch(() => null);
              // same for the status call: a stopped turn never settles ok:true with fresh text
              if (cancelled) break;
              appendNative(threadId, { dir: "in", source: "box.prompt.status", msg: status });
              // real shape (2026-08): {promptRun:{status:"finished",…}} —
              // flat fallbacks kept for drift
              const run: any = status?.promptRun ?? status?.prompt ?? status ?? {};
              const state = String(run?.status ?? "");
              if (BOX_RUN_DONE.test(state)) {
                const result = run?.result ?? run?.output ?? lastText;
                if (typeof result === "string" && result.trim() && result !== lastText) {
                  ingest(result);
                }
                // a run with no output at all is shown as finished: that line is Murage's own (the status said so), never the engine's reply, so it proves nothing about the run
                const silent = !pendingText.trim() && !lastText.trim();
                flushAssistantText();
                if (silent) emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", origin: "murage", text: "(finished)" });
                active.delete(threadId);
                cloudTurnFinished(turnId, "ended");
                emit({ ...base(threadId, turnId), type: "turn.completed", ok: true, stopReason: null, cost: null });
                return;
              }
              if (BOX_RUN_ENDED.test(state)) {
                flushAssistantText();
                active.delete(threadId);
                cloudTurnFinished(turnId, "ended");
                // A box run that ended because Murage interrupted it is the
                // user's Stop, not a failure (STOP1); a box that stopped on
                // its own keeps its own state as the failure reason.
                if (cancelled) emit({ ...base(threadId, turnId), type: "turn.completed", ok: true, stopReason: "cancelled", cost: null });
                else emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: state, cost: null });
                return;
              }
            }
          }
          // Murage stopped the turn: the shared cancelled state every driver
          // settles a user Stop with (STOP1), not an engine failure.
          flushAssistantText();
          active.delete(threadId);
          cloudTurnFinished(turnId, "ended", { terminal: false }); // marked stopping by the Stop: left to its confirmation; no status read, so a quarantine stays
          emit({ ...base(threadId, turnId), type: "turn.completed", ok: true, stopReason: "cancelled", cost: null });
        } catch (e) {
          flushAssistantText();
          active.delete(threadId);
          cloudTurnFinished(turnId, "lost");                  // nothing watches the prompt now: fenced (C6)
          emit({ ...base(threadId, turnId), type: "runtime.error", message: (e as Error).message });
          emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "error", cost: null });
        }
      })();

      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      if (!token) {
        return { state: "unavailable", reason: "No Box key yet. Add one in App Settings → Computer & browser." };
      }
      try {
        await api("/me");
        return { state: "available", authenticated: true, version: null };
      } catch (e) {
        return { state: "unavailable", reason: `box API unreachable: ${(e as Error).message}` };
      }
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      models: MODELS,
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        mcpToolSurface: NO_TOOL_SURFACE,
        capabilities: { sessionModelSwitch: "in-session" },
        sendTurn,
        interruptTurn: async (threadId) => active.get(threadId)?.cancel(),
        respondToRequest: async () => "unavailable" as const, // this engine has no asks to answer
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => {
          for (const { cancel } of active.values()) cancel();
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      dispose: async () => {
        for (const { cancel } of active.values()) cancel();
        listeners.clear();
      },
    };
  },
};
