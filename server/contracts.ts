// Canonical harness contracts — ported from upstream
// (apps/server/src/provider/ProviderDriver.ts, Services/ProviderAdapter.ts,
// packages/contracts/src/{provider,providerInstance,providerRuntime}.ts),
// de-Effect-ed: Promises instead of Effect, listener callbacks instead of
// Stream. The shapes and names are kept so the two codebases stay mutually
// readable.

import type { ExecEnv, ExecEnvInfo, McpMountRecord } from "../shared/mount-identity.ts";
import type { EngineKind } from "../shared/app-action-grant.ts";
import type { LocalSetupFailure, ProviderErrorInfo } from "../shared/provider-error.ts";
import type { RuntimeErrorDiagnostic } from "../shared/error-diagnostic.ts";
import type { MemoryBundle } from "../shared/memory.ts";
import type { QuestionAnswer, QuestionSpec } from "../shared/questions.ts";
import type { AgentPlanEntry } from "../shared/agent-plan.ts";
import type { EngineCommand } from "../shared/engine-commands.ts";

export type DriverKind = string;
export type InstanceId = string;
export type ThreadId = string;
export type TurnId = string;
export type CloudBackend = "box" | "vps";

export type ProviderErrorCode =
  | "missing_cli"
  | "invalid_credentials"
  | "inactive_subscription"
  | "quota_or_region_restriction"
  | "upstream_outage"
  | "model_catalog_outage";

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;

  constructor(code: ProviderErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProviderError";
    this.code = code;
  }
}

/** Reasoning-effort levels, ascending. A union of everything any engine
 * accepts; each driver declares the subset its CLI will take. */
export const EFFORT_LEVELS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Narrow untrusted API/config input before it becomes a model selection. */
export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

// ── model selection ────────────────────────────────────────────────────
// "Which model" is a data value carried on the request, never a service
// binding (upstream ModelSelectionWire). instanceId is the routing key.
export interface ModelSelection {
  instanceId: InstanceId;
  model: string;
  /** Explicit provider account; absent preserves the engine's native route. */
  connectionId?: string;
  /** Optional: no effort means no flag, and the CLI keeps its own default. */
  effort?: EffortLevel;
}

// ── instance configuration envelope ────────────────────────────────────
// `driver` is any slug — NOT validated against known drivers; unknown
// drivers round-trip and surface as unavailable shadow snapshots so a
// config from a newer build downgrades safely.
export interface InstanceConfig {
  driver: DriverKind;
  displayName?: string;
  accentColor?: string;
  environment?: Record<string, string>;
  enabled?: boolean;
  config?: unknown;
}

export type InstanceConfigMap = Record<InstanceId, InstanceConfig>;

// ── canonical runtime events ───────────────────────────────────────────
// Subset of upstream's 49-member ProviderRuntimeEvent union — the ~12 types
// the recipe says to start with, sharing one base. `raw` carries the
// native protocol message when a consumer needs to see behind the
// normalization.
export interface RuntimeEventBase {
  eventId: string;
  provider: DriverKind;
  providerInstanceId?: InstanceId;
  threadId: ThreadId;
  createdAt: string;
  turnId?: TurnId;
  itemId?: string;
  requestId?: string;
  raw?: { source: string; payload: unknown };
}

/** One sub agent or background task of a running turn, in a shape no engine
 * owns. Times are epoch milliseconds. `toolCount` is the tool calls the task
 * has made so far (0 when the engine does not say). */
export type SubtaskStatus = "started" | "running" | "done" | "failed";
export interface Subtask {
  id: string;
  label: string;
  status: SubtaskStatus;
  startedAt: number;
  endedAt?: number;
  toolCount: number;
}

/** What became of a message steered into a running turn (ProviderAdapter.steer). */
export type SteerDelivery = "delivered" | "rejected" | "uncertain";

/** Who made an item: "engine" is something the provider's own turn produced (its reply text, a tool it started); "murage" is a line Murage wrote into the
 * stream itself (a cap note, a wait or wake chip). REQUIRED on the two kinds of item that can prove a hand-off ran, so every place that emits one has to
 * choose, and the compiler refuses the one that forgets. Only "engine" can become a provider reply (server/provider-reply.ts). */
export type ItemOrigin = "engine" | "murage";

export type RuntimeEvent = RuntimeEventBase &
  (
    | { type: "session.started"; sessionId: string | null; model?: string | null;
        /** The driver's session contract this session was made under (ProviderInstance.sessionContract). */
        sessionContract?: number }
    /** A sub agent or background task started, progressed or ended. `subtasks`
     * is the whole list for the turn after this change, so a client that joins
     * late renders from the latest event alone. Owner-only on every stream. */
    | { type: "turn.subtask"; subtask: Subtask; subtasks: Subtask[] }
    | { type: "session.exited"; reason?: string }
    | { type: "turn.started" }
    | {
        type: "turn.retrying";
        /** 1-based: the retry about to be launched (1 = first relaunch). */
        attempt: number;
        delayMs: number;
        /** Why this failure was judged retry-worthy (classifyError's reason). */
        reason: string;
        /** All attempts, the first try included, when the engine counts them itself. */
        maxAttempts?: number;
      }
    | {
        type: "turn.completed";
        ok: boolean;
        stopReason?: string | null;
        cost?: number | null;
        /** Actual provider-reported cost, distinct from subscription estimates. */
        charge?: number | null;
        denials?: string[];
        /** THIS turn's token total, as the provider reports it at the end.
         * The one figure the harness accumulates — thread.token-usage.updated
         * is a live indicator whose meaning differs per driver (a per-call
         * delta, a thread total, a per-step figure) and must never be summed. */
        usage?: { input: number; output: number; cachedInput?: number };
        /** Plain names ("connected apps", "memory") of required tools that had
         * not loaded when the turn's prompt was written; the bot was told so.
         * Degraded availability: a routine run records it, and fails only when
         * its task needed them (server/routines.ts). */
        toolsUnavailable?: string[];
        /** "unknown": the engine could not say whether the required tools were
         * up (it does not report per-server status); the bot was told they may
         * still be loading. Absent when they were checked. */
        mcpReadiness?: "unknown";
        /** The engine ended the prompt `cancelled` on its own right after a permission ask was denied, with no Stop or
         *  host interrupt: who denied it. The person did not press Stop, so the turn's line says why it ended instead. */
        deniedBy?: "user" | "timeout" | "system";
      }
    /** `summary` is a short human read of the tool's arguments, for engines
     * that hide the real call inside a wrapper tool — without it every chip
     * in the transcript is the same wrapper name. */
    | { type: "item.started"; itemType: "tool"; origin: ItemOrigin; title?: string; summary?: string; input?: unknown;
        /** Murage's own working line for a wait it names itself (origin "murage" only): shown beside the mascot even with Tool
         *  calls off, where the chip is hidden. */
        spoken?: string;
        /** Canonical tool kind and identity, separate from display text. */
        toolKind?: string; toolIdentity?: { namespace?: string; name?: string; kind?: string } }
    | { type: "item.started"; itemType: "reasoning"; title?: string; summary?: string; input?: unknown; toolKind?: string; toolIdentity?: { namespace?: string; name?: string; kind?: string } }
    | { type: "item.updated"; itemType: "tool" | "reasoning"; tokens?: number | null }
    /** `detail` is why the tool failed, as the engine reported it. It reaches
     * the person, not only the model's context. */
    | { type: "item.completed"; itemType: "tool"; ok: boolean; result?: unknown; detail?: string }
    /** `beforeItemId` names a tool item already shown that this text came
     * before (Fuigo hosted tools): the text is saved ahead of that row. */
    | { type: "item.completed"; itemType: "assistant_text"; origin: ItemOrigin; text: string; beforeItemId?: string }
    /** Provider-generated raster bytes. This event is folded into the
     * private attachment store and is never forwarded to renderer SSE: a
     * multi-megabyte base64 result belongs in one durable message URL, not
     * duplicated through every connected window. */
    | { type: "item.completed"; itemType: "assistant_image"; data: string; alt?: string }
    | { type: "content.delta"; streamKind: "assistant_text" | "reasoning_text"; delta: string }
    /** The engine is resending its request mid-stream: the assistant text
     * streamed since the last committed item (tool call or completed item) is
     * void. Tool rows already emitted stay. Live only; renderers drop the
     * in-progress bubble. With Fuigo's precise discard the driver re-sends
     * whatever text of that stream survives as a content.delta right after. */
    | { type: "content.reset"; streamKind: "assistant_text" | "reasoning_text" }
    /** The agent's to-do list for this turn, whole: each update replaces the
     * previous one (ACP `plan`). Live only — it is not a transcript message. */
    | { type: "plan.updated"; entries: AgentPlanEntry[] }
    /** The engine's own "/" commands, whole: each report replaces the last
     * (ACP `available_commands_update`, Claude's init `slash_commands`, the
     * Codex set this driver maps to app-server calls). Already filtered to
     * what can run without a terminal screen (server/engine-commands.ts).
     * Not a transcript message: the harness caches it per bot for the
     * composer's "/" menu. */
    | { type: "engine.commands"; commands: EngineCommand[] }
    /** A steer the driver reported "uncertain" was taken into the turn after
     * all (Fuigo echoed it late). Names the steer by the id the server sent with it. */
    | { type: "steer.confirmed"; interjectionId: string }
    /** QW Q3 (173): the engine asked the owner and kept working (Codex request_user_input_async). No adapter ask is
     * open: the server shows the answer-as-send question card, and the answer is the owner's next message. */
    | { type: "question.async"; questions: QuestionSpec[] }
    | {
        type: "request.opened";
        requestType: "permission" | "question";
        tool: string;
        summary: string;
        choices?: string[];
        approvalScope?: "local-computer";
        /** 0.1.52 ASK1 (additive): the driver's trusted signal that this ask
         * is a question to the owner even though it is filed as a permission
         * (Pi `select`; an ACP tool call named as a question tool). Policy
         * never auto-approves, remembers or AI-reviews such an ask. */
        questionTool?: true;
        /** 0.1.52 ASK2 (K0 amendment, additive): the structured questions of
         * a `question` request — header chip, options with descriptions,
         * multi-select, free text, secret. `summary` and `choices` stay the
         * first question's text and labels so older consumers (voice, older
         * clients) degrade gracefully. */
        questions?: QuestionSpec[];
        /** 0.1.52 FUIGOTRUST1 (additive): this question decides trust for a
         * folder. The server persists it on the card and, once the owner
         * answers, records the decision for the folder's trust key. */
        folderTrust?: { key: string; folder: string; sources: string[] };
        /** Additive: the file paths this permission acts on, read
         * from the ENGINE's structured tool input — never from `summary`,
         * which is display text composed from model output. Policy uses them
         * for one thing only: recognizing a bot writing inside its own managed
         * workspace and thread folders, which is Murage's own bookkeeping and
         * must not raise a card (server/own-workspace-approval.ts). A driver
         * that does not report them is unchanged — the card is raised exactly
         * as it is today, which is the safe direction for this to fail in. */
        filePaths?: string[];
        /** Additive: this turn's OWN tool-result folders, named by the driver
         * from the engine home it started and the session id the engine gave
         * it (Fuigo/Grok `sessions/<key>/<session>/mcp`, Claude
         * `projects/<key>/<session>/tool-results`). Policy uses them for one
         * thing: a read-only read of the bot's own saved tool result asks
         * nobody (server/own-tool-results.ts). Absent means unchanged. */
        toolResultDirs?: string[];
        /** Additive: the tool call as the ENGINE reported it: its own name
         * for the tool and its structured input (a shell command, an MCP
         * tool's arguments, a Composio call's slugs). Read by the stop line
         * (server/stop-line.ts) to tell where a delete lands, who a message
         * goes to and whether a call pays. Server-side only: it is stripped
         * before the event reaches any window. A driver that does not report
         * it leaves the stop line reading the card text, which for anything
         * but a shell command means it cannot tell and the card holds. */
        toolCall?: { name: string; input: unknown };
        /** Additive (0.1.63): the Claude engine's WHOLE tool input as JSON
         * text (credential values masked, about 16 KB, a cut marked with
         * "[truncated, N bytes more]"), so a card shows `method: "DELETE"`
         * and not only the url. Unlike `toolCall` it reaches the window,
         * and it becomes the card text; `summary` stays the one-line form
         * that policy keys read. Claude built-ins and mcp__ tools only. */
        toolInput?: string;
        /** Additive (0.1.63): the MODEL's own stated reason for the action
         * (Codex's `reason`). `summary` is the real target, the command or
         * the files; the card shows this under it, labelled as the model's. */
        reason?: string;
        /** Additive: the engine's STRUCTURED kind of the tool (ACP's
         * `toolCall.kind`: read, edit, delete, move, search, execute, think,
         * fetch, other), never display text. */
        toolKind?: string;
        /** Additive: the identity the engine stamped on the tool (Fuigo's
         * `_meta["fuigo/tool"]`: namespace, name, kind). A title can be any
         * text; this cannot come from the model. */
        toolIdentity?: { namespace: string; name: string; kind?: string };
        /** Additive (1.0.3), F4 (APP-GRANT-DESIGN-FINAL.AGREED-r10.md Rule 54):
         * the MCP servers this engine actually loads for this turn, each
         * recorded by the driver that mounted or enumerated it
         * (`{engineName, mountId, provenance}`). An MCP identity is proven
         * against these records by exact `engineName` and nothing else
         * (shared/app-action-grant.ts); one that fits no record, or more than
         * one, offers no grant and stops. Server-side only, stripped with
         * `toolCall`. */
        mcpMounts?: McpMountRecord[];
        /** Additive (1.0.3): which driver filed the ask, so its Rule 55
         * contract table applies (server/drivers/contracts.ts). */
        toolEngine?: EngineKind;
        /** Additive (1.0.3), F5: a field the driver's contract needs was
         * absent on the wire; the driver never substitutes one. */
        toolInputMissing?: string;
        /** Additive (1.0.4, 09-1): the driver's own gate held this call as a
         * key file (Pi's gate resolves links itself); the rule it named. It
         * only ever adds a hold. Server-side only. */
        localHold?: string;
        /** Additive (1.0.4, F1): the driver runs this command's text under
         * PowerShell (`powershell.exe -Command`, Codex and ACP on Windows),
         * so the gates read it as PowerShell whatever it starts with. */
        commandShell?: "pwsh";
        /** Additive (1.0.3), F12 (Rule 74): the exact environment the driver
         * handed the engine process, the names it removed, the command's
         * starting directory, the pinned shell form, and where the map came
         * from. Server-side only. */
        execEnv?: ExecEnv;
        /** Additive (1.0.3, Astra #9): the value-free projection of
         * `execEnv` (names, shell form, capture, provenance, managed names;
         * shared/mount-identity.ts envInfoOf), the one part of the F12
         * record that leaves the server (card, log). */
        envInfo?: ExecEnvInfo;
        /** Additive (1.0.3): the driver could not report the call whole (Pi's
         * gate sends a call past its size cap without its input). What the
         * card shows is then not the whole call: it offers no standing grant
         * and no mode answers it (server/auto-approve.ts unread-call). */
        toolInputTruncated?: boolean;
      }
    | {
        type: "request.resolved";
        behavior: "allow" | "deny" | "answer";
        /** who decided: a person, auto mode, the ask's own timeout, the
         * harness (turn ended / settings changed), or nobody — the answerer
         * was already gone and the action never ran */
        source: "user" | "auto" | "timeout" | "system" | "unavailable" | "peer";
        /** 1.0.5, served by the Inspector read only (thread-events.ts), never logged: the automatic rule that answered this ask, from
         * the decision log (own-workspace, auto-mode, always-allow, ...). The engine itself cannot tell a server's automatic answer
         * from a person's (it records both as `user`), so without this the Inspector said "allow · user" for answers nobody clicked. */
        decidedBy?: string;
        approvalScope?: "local-computer";
        /** 0.1.52 FUIGOTRUST2 (additive): a folder-trust card raised from
         * the engine's own request AFTER the engine had started (the
         * server's scan named nothing) closed without a decision — the turn
         * `finished` on its own, was `stopped`, `failed` (a spawn or rpc
         * error, an early exit — FUIGOTRUST3), or the ask hit its
         * `timeout` while the turn ran on. The engine ran this turn
         * untrusted either way; the card says which, never "the turn was
         * stopped because nobody decided". */
        folderTrustLate?: "finished" | "stopped" | "failed" | "timeout";
      }
    | { type: "thread.token-usage.updated"; input: number; output: number; cachedInput?: number }
    /** A Flux response named the model that served it (x-flux-routed-model) and the one asked for (x-flux-original-model), read at
     * the start of the response. The reply this turn writes next stores it (Message.servedModel). */
    | { type: "turn.served-model"; routed: string; requested: string }
    // `setup: true` marks a failure the user fixes by installing or
    // configuring something, not by retrying — the UI offers setup instead.
    | { type: "runtime.error"; message: string; details?: string; setup?: boolean; authRequired?: boolean; /** the installed Claude Code is too old for the model */ claudeUpdate?: boolean; errorKind?: string; /** the engine's own upper-case error code (OpenCode's QUOTA_EXCEEDED), read from the RPC error, never from text */ engineCode?: string; /** a reset time the engine reported as data (epoch ms), for limit detection */ limitResetsAt?: number; /** A device-side setup failure the chat words from its code (a bot's engine folder); localFailureEngine names the engine. */ localFailure?: LocalSetupFailure; localFailureEngine?: string; providerError?: ProviderErrorInfo; diagnostic?: RuntimeErrorDiagnostic }
  );

export type RuntimeEventListener = (event: RuntimeEvent) => void;

/** Close-confirmed stop (0.1.52 K0 contract for A2 / R1-T2). `true` only
 * after the provider child was observed to close; a requested kill or an
 * acknowledged session/cancel is not closure. */
export type ProviderStopResult =
  | { closeConfirmed: true }
  | { closeConfirmed: false; reason: "timeout" | "stop-failed" };

/** `undefined` for legacy drivers that return void (not observed). */
export function stopCloseConfirmed(result: void | ProviderStopResult): boolean | undefined {
  return result && typeof result === "object" ? result.closeConfirmed === true : undefined;
}

/** What became of an answer to an ask. `allowed-once` grants only the
 * asked-about action — broadening ("always allow") stays a separate,
 * explicit step. `unavailable` is the fail-closed default: no answerer,
 * no action. */
export type RequestOutcome = "allowed-once" | "rejected" | "answered" | "unavailable"
  /** Rule 72: a narrowing denial a driver held back for the owner (the third
   * identical one in a turn); the ask stays open and the card decides. */
  | "card";

// ── adapter contract (upstream ProviderAdapterShape, promise-flavored) ──
// The conversation runtime every provider is flattened into. streamEvents
// becomes onEvent(listener) → unsubscribe; sessions start implicitly on
// the first turn (the agentcal per-turn-process model) with resumeCursor
// carrying the provider-native continuation (e.g. a claude session id).
/** The server side of an engine send (DESIGN-WRITETIME 2, Enforcement (a)): the engine input of a turn is a BuiltPrompt (memory/prompt-parts.ts),
 * never a bare string; assembling one added every part's lineage to the running turn. drivers/engine-input.ts (fencedTurnInput, sendBuiltTurn)
 * is the only place it becomes SendTurnInput.text, right behind the send fence. The driver side below keeps the engine's bytes. */
export type BuiltSendTurnInput = Omit<SendTurnInput, "text"> & { readonly prompt: import("./memory/lineage-types.ts").BuiltPrompt };
/** The server side of an adapter's turn and steer calls: both take a BuiltPrompt (drivers/engine-input.ts sendBuiltTurn / steerBuilt implement
 * it over a ProviderAdapter, with the send fence before every write). */
export interface BuiltEngineInput {
  sendTurn(input: BuiltSendTurnInput): Promise<TurnStartResult>;
  steer(threadId: ThreadId, prompt: import("./memory/lineage-types.ts").BuiltPrompt, beforeWrite?: () => void, interjectionId?: string): Promise<boolean | SteerDelivery>;
}
export interface SendTurnInput {
  /** Routine, scheduled or memory work: not user activity. The warm pool
   * releases this turn's engine as soon as it finishes and never keeps it as a spare. */
  background?: boolean;
  /** Driver-internal: this is an intent warm (prewarm), not a turn. The engine is
   * started and parked idle; nothing is sent, no turn events are emitted. */
  prewarm?: boolean;
  /** Load browser tools at turn start when the browser is the place. */
  preloadBrowserTools?: boolean;
  /** Inspection observes what the model receives. `mounts` is what the SYSTEM
   * text names (the stable memory label when F4b normalizes it); `body` carries
   * the concrete per-turn mounts used for the message text and the per-turn
   * binding line that rides in front of it. */
  onToolSurface?: (surface: import("./murage-tool-surface.ts").McpToolSurface, mounts: import("./murage-tool-surface.ts").MurageToolMounts, body?: { mounts: import("./murage-tool-surface.ts").MurageToolMounts; binding: string; askRules?: string }) => void;
  /** Server-only synchronous submission fence, the one validation contract
   * every adapter honours: called immediately before EVERY engine prompt
   * write of this turn (a relaunch's write too), with no await between the
   * call and the write, and called again each time (the server validates
   * every call; only its delivery bookkeeping is idempotent). On refusal
   * (it throws), write nothing. Before sendTurn resolved, either throw or
   * return the addressable turnId for cleanup; after it resolved, settle the
   * turn failed without writing, and the server re-runs it once on a reset
   * session. */
  beforeSubmit?: () => void;
  /** Server-only: the adapter says that the write the last `beforeSubmit` released did not happen (the process never started, the
   * connection failed before any answer, the write failed whole). BOTADDED-DESIGN-V3 r6 invariant I14 reads "released to the
   * engine's write", so the server withdraws the delivery bookkeeping that call made; a later write's `beforeSubmit` makes it again.
   * Optional and best effort: an adapter whose fence sits right before a write that cannot fail first need not call it. */
  notWritten?: () => void;
  /** Server-authorized reference bundle; the shared adapter consumes it once. */
  memoryContext?: MemoryBundle;
  /** Flux memory envelope (lane 2.2), set by the memory adapter when this turn
   *  goes through Flux with "Use Flux memory" on: the driver puts it in the
   *  request metadata and reports Flux's x-flux-memory answer to
   *  `onFluxMemory`. Set only for drivers that declare `fluxEnvelope`. */
  fluxMemory?: import("./flux-memory-envelope.ts").FluxMemoryEnvelope;
  onFluxMemory?: (report: import("./flux-memory-envelope.ts").FluxMemoryReport) => void;
  threadId: ThreadId;
  /** Who this turn runs for, stamped by the harness. A driver that keeps an
   * engine process warm across turns keys reuse on it, so a process is never
   * shared between bots or between the owner and any other audience. */
  warmIdentity?: { botId: string; audience: "owner" | "non-owner"; decidedOwner?: boolean; humanPrincipal?: string };
  /** The thread holds a bank, card or id number (flux-capture-hold.ts), or this turn's text does: Flux Memory capture off, inject on.
   * Set by the server where the turn is sent (index.ts sendProjectUsageTurn). */
  fluxCaptureHold?: boolean;
  /** What this turn is for, on the x-flux-feature usage tag of its Flux requests (flux-usage-tags.ts). Stamped by the server where
   * the turn is dispatched; absent = "chat", or "other" for background work. */
  usageFeature?: import("./flux-usage-tags.ts").FluxFeature;
  text: string;
  model?: string;
  /** Exact server-authorized incoming bytes; never resolve paths in drivers. */
  images?: Array<{ mimeType: string; data: string }>;
  /** Server custody only; never serialized into bot settings or the renderer. */
  providerRoute?: import("./provider-routing.ts").ProviderTurnRoute;
  effort?: EffortLevel;
  resumeCursor?: unknown;
  /** Start without the previous native context, including a retained idle
   * process. Takes precedence over resumeCursor. Set whenever the harness
   * rebuilt or cleared the conversation's cursor (an edit, a branch switch,
   * a cwd or engine change, a memory refresh): the rebuilt history travels
   * in `text`/`transcript`, and replaying it on top of the old context would
   * hand the engine both branches (upstream #1562). */
  sessionReset?: boolean;
  replayMetadata?: string;
  /** Prior turns for transcript-replay providers (API-backed drivers). */
  transcript?: Array<{ role: "user" | "assistant"; text: string;
    /** Run header (turn-context.ts runHeaders): on the first reply of a run written on an engine, the line saying so. */
    header?: string }>;
  /** Bot persona (name/title/description) as a system prompt. */
  system?: string;
  /** This turn is one of the engine's own "/" commands, picked or typed by
   * the owner. The driver sends `engineCommandText(engineCommand)` as the
   * whole prompt (or the app-server call it maps to): no persona or memory
   * prefix, because an engine only reads a command that starts its first
   * text block with "/". `text` still carries the same command. */
  engineCommand?: { name: string; args: string };
  /** Thread recall (r6 rule 22): this turn reaches the thread tools through its memory mount, so renderMurageTurn says so once in the turn text. */
  threadRecall?: boolean;
  /** Per-bot integrations the driver may hand to the agent as tools. */
  integrations?: {
    memory?: { command: string; args: string[]; env: Record<string, string> };
    /** A local stdio bridge owns the remote Composio transport. Keeping the
     * bridge harness-controlled lets it turn connection requests into trusted
     * chat cards consistently across provider CLIs. */
    composio?: { command: string; args: string[]; env: Record<string, string> };
    /** Cloud computer, reached through Murage's REST-to-MCP adapter.
     * `control` is the harness's loopback who-is-driving endpoint: the
     * adapter consults it so a person who takes the wheel in the panel
     * pauses the bot's hands mid-turn instead of typing over them. */
    computer?: {
      kind?: "box";
      boxId: string;
      token: string;
      control?: { url: string; token: string };
    };
    /** Direct stdio connection to a Cua Driver MCP server (host, sandbox, or
     * VPS). `scope` is set only for the user's host desktop; isolated and
     * remote computers intentionally omit it so host-only approval rules
     * cannot change their semantics. */
    localComputer?: {
      command: string;
      args: string[];
      env: Record<string, string>;
      platform?: "darwin" | "linux" | "win32";
      generation?: string;
      scope?: "local-computer";
    };
    /** Peer-agent comms: an MCP proxy (list_bots / ask_bot) that routes back
     * through the harness so this bot can message other bots. The harness
     * owns turns, permissions, and recursion limits; the proxy only forwards. */
    agents?: { command: string; args: string[]; env: Record<string, string>;
      /** The MCP server name to mount it under (default "agents"): the Chief's
       * proposal turn on Fuigo/Grok Build uses a per-turn alias. */
      serverName?: string };
    /** Physical Android phone tools over authorized USB debugging. */
    phone?: { command: string; args: string[]; env: Record<string, string> };
    /** The owner's own phone (calendar, reminders, ...) through the harness, only for a turn that holds a live phone authority (1.0.9).
     * Mounted under the server name "phoneJobs"; never the ADB "phone" server above. */
    phoneJobs?: { command: string; args: string[]; env: Record<string, string> };
    /** The app's built-in browser: an MCP proxy (server/drivers/browser-proxy)
     * that forwards to the Electron-owned WebContentsView the Browser tab
     * shows. One tab per bot, in its own persistent session partition. */
    browser?: { command: string; args: string[]; env: Record<string, string> };
    /** dweb network daemon: an MCP proxy exposing dweb status, repo, and
     * opencode model access as tools. url is the dweb HTTP base. */
    dweb?: { url: string };
    /** User-configured MCP servers (config.json `mcpServers`), already
     * validated and normalized by customMcpServers(), plus link servers as a
     * proxy mount (server/custom-mcp-mounts.ts). `env` is the owner's and is
     * refused if it names a Murage variable; `harnessEnv` is Murage's and is
     * merged after that check. Mounted WITHOUT any pre-allow: their tools ride
     * each driver's normal permission flow. */
    custom?: Record<string, { command: string; args: string[]; env: Record<string, string>; harnessEnv?: Record<string, string> }>;
  };
  cwd?: string;
  /** Extra folders the owner granted this bot, already validated and made
   * canonical by the server. The Claude driver passes them as `--add-dir` so
   * reads there need no ask. Set only where the bot's mode already approves
   * work for itself (Auto, Full access, No limits), never in Ask mode, and
   * never from a project's write-leased roots. */
  addDirs?: string[];
  /** 0.1.52 FUIGOTRUST1 (additive): Murage's folder-trust record for `cwd`,
   * handed only to drivers whose engine gates repo-local sources behind a
   * trust decision (`capabilities.folderTrust`). `decision` is the remembered
   * answer for the folder's trust key; absent means nobody has decided yet,
   * and the driver raises a question card before the engine starts when
   * `sources` names anything the folder would contribute. */
  folderTrust?: FolderTrustTurnInput;
  /** The bot is on Murage's Full access, which still stops before deleting
   * outside its folder, paying and messaging someone new (server/stop-line.ts).
   * The engine must send its permission asks to Murage for that to hold, so a
   * driver whose instance is set to skip them (Claude `bypassPermissions`,
   * Codex `approvalPolicy: never`, an ACP engine's `fullAuto`, Antigravity's
   * `--dangerously-skip-permissions`) asks for this turn instead, and Murage
   * answers everything else at once. Also set on No limits, which drops the
   * stop line but keeps the key guard: that guard holds only if Murage sees
   * the asks. When both stopLine and routeAsks are absent, the instance's
   * own setting stands. */
  stopLine?: true;
  /** Ask and Auto turns must reach Murage's permission broker. For this turn
   * only, replace a skip-all instance setting with its asking mode; preserve
   * every other instance mode. Full access and No limits use stopLine above.
   * Engines without a permission setting have nothing to override. */
  routeAsks?: true;
  /** The bot is at Ask for this turn (a routine run's effective level included); sent with routeAsks. An engine
   * that cannot ask before every change (Cursor, OpenClaw, Antigravity) runs read-only on this turn: it may read
   * and plan, and every file change or command is refused before it runs (server/drivers/ask-stop.ts). Engines
   * that ask for every change ignore it. */
  askLevel?: true;
  /* Permission cards carry no deadline on any turn (Sean 10-29, LONGWORK H4): a card waits until the owner answers
   * it or the turn stops, on every engine, direct chat and routine alike. A routine run still ends as "waiting on
   * you" at its run limit (RoutineManager.enforceRunLimits). */
  holdProjectAsks?: true;
  /** The Chief's hidden New project proposal turn (lane N/N2): it answers
   * with a proposal block in its reply; where the turn mounts the agents
   * server, project_propose is the one Murage tool it may use. A driver that
   * can narrow the engine further does: pi's gate asks before every other
   * tool, reads included; Codex runs with no shell tool, no web search, no
   * ChatGPT apps and a read-only sandbox. Sent together with `stopLine`. */
  proposalOnly?: true;
  /** The bot is draft-only (server/draft-only.ts): it writes drafts for the owner and has no route that sends. Only a
   *  qualifying engine mode ever receives it (draftOnlyQualifies, enforced by harness/draft-only-adapter.ts on every engine
   *  call): Claude, launched with `--tools ""`, only Murage's connected-app relay, no broker, hooks off and an empty private
   *  folder, re-judged before every spawn; or a chat-completions driver, whose request carries no tools. */
  draftOnly?: true;
}

/** See `SendTurnInput.folderTrust`. `sources` are display names from the
 * server's scan (server/folder-trust.ts): "AGENTS.md", ".mcp.json", …. */
export interface FolderTrustTurnInput {
  key: string;
  folder: string;
  decision?: "trust" | "reject";
  sources: string[];
  /** 0.1.52 FUIGOTRUST2 (additive): the user's own Fuigo install already
   * trusts this workspace (`<FUIGO_HOME>/trusted_folders.toml`), so the
   * engine will run the turn trusted whatever `decision` says and never
   * ask: the driver raises no card and shows no "untrusted folder" chip.
   * Only ever set for a native-login turn; a provider-routed turn runs
   * under a per-turn temporary home that trusts nothing. */
  upstreamTrusted?: true;
}

export interface TurnStartResult {
  turnId: TurnId;
}

/** What `ProviderAdapter.holdIdle` returns: how to let the adapter keep or warm engines again, and whether every idle one is gone. */
export interface IdleHold { release: () => void; confirmed: boolean }

export interface ProviderAdapter {
  readonly provider: DriverKind;
  readonly mcpToolSurface?: import("./murage-tool-surface.ts").McpToolSurface;
  readonly capabilities: {
    memoryDelivery?: "prefixed-reference" | "unavailable";
    memoryMcp?: boolean;
    /** True when the driver sends `turn.fluxMemory` as request metadata on a Flux request. */
    fluxEnvelope?: boolean;
    sessionModelSwitch: "in-session" | "unsupported";
    /** True when the driver mounts turn.integrations.agents as MCP tools —
     * the harness only offers agents tooling (and prompts about it) to
     * drivers that can actually hand it to the agent. */
    agentsMcp?: boolean;
    /** True when the driver mounts turn.integrations.computer (the box's
     * screenshot/click tools). Same rule as agentsMcp: a bot must never be
     * told it has a computer whose tools its driver cannot mount — it
     * burns turns hunting for tools that aren't there. */
    computerMcp?: boolean;
    /** True when the driver mounts turn.integrations.composio (the user's
     * connected apps). Same rule again: a key in the config says the user
     * HAS those connections, not that this driver can reach them. */
    composioMcp?: boolean;
    /** True when the engine runs on its OWN tools and its OWN approvals: Murage
     * mounts nothing into it (it does not take Murage's MCP servers) and
     * Murage's approval cards and stop-line never see what it runs. The primer
     * and the permission menu say so instead of promising either. */
    runsOnOwnTools?: boolean;
    /** True when the driver can mount the first-party physical-phone MCP. */
    phoneMcp?: boolean;
    /** True when the driver can mount the built-in browser MCP. Same rule:
     * a bot must never be told it has a browser its driver cannot hand it. */
    browserMcp?: boolean;
    /** True when this engine accepts images in the prompt — gates image
     * paste in the composer. Same rule as computerMcp: never offer an
     * attachment an engine cannot open (a bot told it has an image it
     * cannot read burns the turn). */
    images?: boolean;
    /** True when the DRIVER puts the picture into the prompt itself, so the
     * model sees it without opening anything. `images` is the looser
     * question the composer asks ("can this engine deal with an attachment
     * at all"); this is the one the turn asks ("was it shown, or handed a
     * path"). They differ: pi and Antigravity take an attachment as the
     * `<attached-image path=…>` reference in the text and open it with a
     * read tool — Antigravity's stream-json input accepts exactly one
     * content-block type and it is not an image — while Claude, Codex and
     * the ACP engines carry the bytes. A driver that does not consume
     * `turn.images` must leave this unset, or its bots are told they can
     * already see a picture that was never sent. */
    imagesInline?: boolean;
    /** Effort levels this driver can pass to its CLI, ascending. Absent =
     * the driver cannot set effort, so the app never offers the control —
     * same rule as computerMcp: never show a knob the driver cannot turn. */
    effortLevels?: readonly EffortLevel[];
    /** True when the driver keeps a live session across turns and can take
     * a user message MID-TURN (delivered before the model's next call —
     * "steer"). The composer stays open during a turn on such an engine;
     * others keep the queue-one-and-wait behaviour. Same rule as the other
     * flags: never show a control the driver cannot honour. */
    queueing?: boolean;
    /** True only when local MCP calls can reach the human approval channel.
     * Full-auto/bypass provider instances must leave this false. */
    localComputerMcp?: boolean;
    /** True when the driver mounts turn.integrations.custom (the user's own
     * MCP servers from config). Same rule as composioMcp: an entry in the
     * config says the servers exist, not that this engine can reach them. */
    customMcp?: boolean;
    /** True when the engine gates a folder's repo-local sources (AGENTS.md,
     * .mcp.json, skills, hooks) behind a per-folder trust decision that the
     * driver takes from `SendTurnInput.folderTrust` (Fuigo 1.0.13). The
     * server scans the folder and hands the record only to such drivers. */
    folderTrust?: boolean;
    /** True when the adapter implements textOnlyTurn (PIP reflection): one
     * tool-free structured call, no tools or MCP servers mounted. */
    textOnlyTurn?: true;
  };
  /** PIP reflection: one text-only structured call. Absent unless
   * capabilities.textOnlyTurn is set. Settles only after the transport is
   * confirmed closed. */
  textOnlyExecutable?(): string;
  prepareTextOnlyTurn?(model: string, providerRoute?: import("./provider-routing.ts").ProviderTurnRoute): { model: string; turn(input: import("./memory/pip-transport.ts").TextOnlyTurnInput): Promise<import("./memory/pip-transport.ts").TextOnlyTurnResult> };
  textOnlyTurn?(input: import("./memory/pip-transport.ts").TextOnlyTurnInput): Promise<import("./memory/pip-transport.ts").TextOnlyTurnResult>;
  sendTurn(input: SendTurnInput): Promise<TurnStartResult>;
  /** Intent warm: start this thread's engine from the spawn inputs of its last real
   * turn (held in memory only), park it idle and hold it for one activity window.
   * True when an engine was started; false when nothing was remembered, one is
   * already live, or the thread is busy. Optional: drivers without a warm pool omit it. */
  prewarm?(threadId: ThreadId): Promise<boolean>;
  /** Request a stop. A driver that can observe teardown resolves with a
   * ProviderStopResult (A2); `void` is the legacy "requested, not observed". */
  interruptTurn(threadId: ThreadId, turnId?: TurnId): Promise<void | ProviderStopResult>;
  /** Optional (A2): resolves once the provider process that served this
   * turn has closed after its terminal event, or `closeConfirmed:false` at
   * the driver's bounded deadline. Drivers that deliberately retain a live
   * session across turns omit it. Callers keep resource ownership until a
   * confirmed close.
   *
   * 0.1.52 coverage (U-18): the shared ACP core (every ACP harness, Fuigo
   * included) and Pi resolve interruptTurn only after child close, reject at
   * the deadline, and implement this method. Codex already closes its child
   * before emitting turn.completed and rejects an unconfirmed stop. Claude
   * retains sessions. Antigravity and BoxAgent are NOT covered: their
   * interruptTurn still means "requested, not observed".
   *
   * 0.1.59 (#1575): an ACP harness with `pooledSessions` (Fuigo) may hand a
   * cleanly finished turn's child to its idle pool instead of closing it; that
   * turn's wait then resolves confirmed at once, as Claude's retained session
   * does. interruptTurn and resetSession close the idle child and confirm its
   * exit. */
  awaitTurnTeardown?(threadId: ThreadId, turnId?: TurnId): Promise<ProviderStopResult>;
  /** Resolves when the exact turn's child has closed, however late, observed
   * only by its confirmed close and never by a timer; a child that never
   * closes leaves it pending. Call it before awaitTurnTeardown: the adapter
   * forgets a child once it closed. A retained direct run is released by it. */
  awaitTurnClose?(threadId: ThreadId, turnId?: TurnId): Promise<void>;
  /** Retire retained native state for exactly this thread, including idle
   * sessions. Resolves after retirement; callers must omit stale resume cursors.
   * Unlike interruptTurn, this must prevent implicit reuse on the next turn. */
  resetSession?(threadId: ThreadId): Promise<void>;
  /** Close every pooled or retained IDLE engine process this adapter holds and keep it from starting a warm one (a prewarm, a
   * process parked after a turn) until the returned release is called. Running turns are never touched. Used while Murage removes
   * a deleted conversation from the engine's own files (conversation-deletion.ts), so no process of ours writes to them then.
   * `confirmed` is true only when every idle process (and every prewarm that was starting) is known to have exited; a close that
   * could not be confirmed says false and the caller leaves that engine's files alone. */
  holdIdle?(): Promise<IdleHold>;
  /** An engine configured to run Murage's host-computer mount without asking
   * (it cannot name those calls by more than a title): Murage's computer
   * service asks through here before each call reaches the computer, with the
   * exact tool and arguments. Resolves "allow" or "deny" once the card (or
   * Murage's level) answers; null when this thread's running turn does not
   * ask this way, and the service then asks nothing (the engine asked). */
  askHostAction?(threadId: ThreadId, call: { name: string; arguments?: unknown }, signal?: AbortSignal): Promise<"allow" | "deny" | null>;
  /** Answer a pending ask. Resolves with what actually happened — never
   * throws for an ask that is no longer there: `unavailable` means nobody
   * could take the answer (the turn ended, the broker died, the driver
   * has no asks), and the caller treats it as a deny. Callers branch on the
   * outcome, not on prose. */
  respondToRequest(
    threadId: ThreadId,
    requestId: string,
    /** 0.1.52 ASK2 (additive): `answers` carries the owner's validated
     * per-question picks for a structured question; `message` is the same
     * answer as plain text for drivers that only read one string. A `deny`
     * on a question is an honest "no answer" (skipped), never a refusal. */
    decision: {
      behavior: "allow" | "deny" | "answer"; message?: string; answers?: QuestionAnswer[];
      /** Rule 72: a narrowing denial; `message` is the reason the engine reads. */
      source?: "narrow";
      /** Rules 69e, 73d: the call as judged, or the narrowed call, to run in place of the one asked. */
      updatedInput?: Record<string, unknown>;
    },
  ): Promise<RequestOutcome>;
  /** Deliver a user message into the RUNNING turn on this thread. Resolves
   * false or "rejected" when there is no live turn to steer (the caller then
   * sends it as a normal turn), true or "delivered" when the turn took it, and
   * "uncertain" when the engine neither confirmed nor refused it in time: it
   * may still arrive, so the caller must not send a copy (a later
   * `steer.confirmed` event says it did). Only drivers with
   * `capabilities.queueing` implement it.
   * `beforeWrite` is the same fence as SendTurnInput.beforeSubmit for this
   * message: called immediately before its write, however late (a steer
   * queued until the engine is ready); when it throws, nothing is written
   * and the steer resolves false or "rejected". */
  steer?(threadId: ThreadId, text: string, beforeWrite?: () => void, interjectionId?: string): Promise<boolean | SteerDelivery>;
  hasSession(threadId: ThreadId): boolean;
  stopAll(): Promise<void>;
  onEvent(listener: RuntimeEventListener): () => void;
}

// ── provider snapshot (upstream ServerProviderShape, reduced) ────────────
export interface ProviderSnapshot {
  state: "available" | "unavailable";
  /** Packaged engine exists by contract but requires application repair, not a CLI install. */
  setupAction?: "repair";
  reason?: string;
  authenticated?: boolean;
  version?: string | null;
  /** A line shown beside the detected version (OpenClaw below its Ask floor: ASK_STOP_OPENCLAW_OLD_NOTE). */
  versionNote?: string;
  /** How this instance is paid for, when the driver can tell: a reported
   * cost on a subscription is notional and the UI labels it as such. */
  billing?: "metered" | "subscription";
  /** Cloud home: the engine's sign-in should be renewed (Claude's token expires within 30 days or
   * is no longer accepted). The UI offers the sign-in again. */
  renewSignIn?: boolean;
}

// ── engine install descriptor ───────────────────────────────────────────
// How a user gets this engine onto their machine. Declared by the driver so
// that adding a provider stays "one file in drivers/ plus a registration":
// onboarding, the model picker, and settings all render from this instead of
// hardcoding per-engine copy in the UI.
//
// Installing is rarely the whole job — most CLIs then need an interactive
// sign-in, which is why signInCommand exists and why the UI sends people to a
// terminal rather than trying to shell out silently.
export interface EngineInstall {
  /** One-liner per platform. Omit a platform that has no such command —
   * the UI falls back to docsUrl rather than offering something that
   * cannot work there (a curl|bash line is not a Windows command). */
  command?: Partial<Record<"darwin" | "win32" | "linux", string>>;
  /** The OS of the computer running the server (set by the registry when it describes the engine), so the setup card shows the command for the machine that will run it, not for the browser device viewing it. */
  platform?: "darwin" | "win32" | "linux";
  /** Docs or download page. The only route for GUI-installed engines. */
  docsUrl?: string;
  /** Interactive sign-in run after installing, when install isn't enough. */
  signInCommand?: string;
  /** `command` needs npm on PATH, so the UI can say so when Node is absent. */
  needsNode?: boolean;
}

// ── driver SPI (upstream ProviderDriver — a plain record, not a service) ─
// `create` owns ALL per-instance state; two create calls share nothing.
// Failures must reject, never throw synchronously — the registry downgrades
// a rejection to an unavailable shadow snapshot.
export interface ModelCatalog {
  default: string;
  /** "live" only when this catalog came from a successful list by the engine's
   * own CLI in this process; a fallback or built-in list is "static" (or absent).
   * Nothing may rewrite a saved model off a catalog that is not "live". */
  source?: "live" | "static";
  options: Array<{
    id: string;
    label: string;
    custom?: boolean;
    loaded?: boolean;
    /** upstream provider id (e.g. "zai", "nous") when the engine can report
     * it — the picker shows it as a muted badge so BYOK duplicates of the
     * same model id stay distinguishable. */
    provider?: string;
    /** total context window in tokens, when the driver knows it — sizes
     * the model-facing rebuild (server/context-rebuild.ts). Unknown falls
     * back to a pattern table over the model id, then a conservative default. */
    contextWindow?: number;
    /** Local models only: the server this model is served by, already in the
     * form the picker shows ("llama.cpp on seanbeast"). Spec V3. */
    localServer?: string;
    /** Local models only: how the last Local models tool test came out, so the
     * picker can mark a model that answers but cannot call tools. Absent means
     * never tested. Spec V3. */
    localTools?: "pass" | "partial" | "failed";
  }>;
}

export interface DriverCreateInput<Config> {
  instanceId: InstanceId;
  displayName: string | undefined;
  environment: Record<string, string>;
  enabled: boolean;
  config: Config;
}

/** `manual`: a person asked (picker open, Check again), so a catalog may skip
 *  its failure wait. Periodic and startup refreshes leave it unset. */
export interface ModelRefreshOptions {
  readonly manual?: boolean;
}

export interface ProviderInstance {
  readonly instanceId: InstanceId;
  readonly driverKind: DriverKind;
  readonly displayName: string | undefined;
  readonly enabled: boolean;
  readonly models: ModelCatalog;
  /** The version of what this engine's native sessions are made under (Claude: the isolation
   * contract, claude.ts CLAUDE_ISOLATION_CONTRACT). A cursor recorded under another version, or
   * with none, is never resumed: the harness starts a fresh session and replays the thread.
   * Absent for an engine with no such contract. */
  readonly sessionContract?: number;
  /** Plan usage (GAP-PLAN-LIMITS): "native-rpc" when this engine reports plan windows over its own
   * running process (server/plan-usage.ts). Absent means observation-only: Murage shows the limits
   * the engine reports on refusal, and plan usage reads as not available. Never a credential reader. */
  readonly planUsageReporter?: "native-rpc";
  /** True when this engine tracks a refused key itself (keyed by the key, so a new key starts clean); the harness then does not also mark it signed out from its failed turns. */
  readonly tracksKeyRejection?: boolean;
  /** Refresh a live catalog without recreating the provider instance. */
  readonly refreshModels?: (options?: ModelRefreshOptions) => Promise<void>;
  readonly adapter: ProviderAdapter;
  snapshot(): Promise<ProviderSnapshot>;
  /** Cheap one-shot text call (upstream TextGeneration) — titles, summaries. */
  generateText?(prompt: string, botId?: string): Promise<string>;
  /** One non-persisted owner proposal with tools and hooks disabled. */
  /** `botId` is the bot the call is made for: on a Cloud home the launcher refuses an engine run that names none. */
  proposeProject?(prompt: string, signal: AbortSignal, model: string, botId?: string): Promise<string>;
  /** Explicitly qualified tool-free bounded memory extraction. Absence means
   * unavailable; never infer it from chat, MCP, or generic text generation. */
  groundMemory?(input: import("./memory/extract.ts").MemoryGroundingInput, maximumOutputTokens: number, signal: AbortSignal): Promise<string>;
  extractMemory?(text: string, maximumOutputTokens: number, signal: AbortSignal, dispatch?: import("./memory/extract.ts").MemoryExtractionDispatch): Promise<string>;
  /** Isolated, tool-free permission review on this same provider. Kept
   * separate from generateText so the UI never infers a security capability
   * from a generic helper that may expose prompts in argv or lack approvals. */
  reviewPermission?(prompt: string, signal?: AbortSignal, botId?: string): Promise<string>;
  dispose(): Promise<void>;
}

/** How an engine is presented in the picker rail.
 *  `subscription` — first-party cloud catalog; Custom is extra.
 *  `custom` — no subscription catalog; Custom is the product. */
export type EngineAccess = "subscription" | "custom";

export interface ProviderDriver<Config = unknown> {
  readonly driverKind: DriverKind;
  readonly metadata: {
    displayName: string;
    supportsMultipleInstances?: boolean;
    access?: EngineAccess;
  };
  /** How to get this engine installed. Omit for engines that need no local
   * binary (API-key drivers), which is what makes it optional. */
  readonly install?: EngineInstall;
  /** Decode the opaque config envelope; throw on invalid (→ shadow). */
  decodeConfig(raw: unknown): Config;
  defaultConfig(): Config;
  readonly models: ModelCatalog;
  create(input: DriverCreateInput<Config>): Promise<ProviderInstance>;
}

export type AnyProviderDriver = ProviderDriver<any>;

let eventCounter = 0;
export const newEventId = () => `ev-${Date.now().toString(36)}-${(eventCounter++).toString(36)}`;
export const newId = () => crypto.randomUUID();
