// Murage's own MCP servers that a turn cannot do its job without, and the
// bounded wait for them before the prompt is sent.
//
// Claude Code connects MCP servers in the background. Run with an explicit
// --mcp-config it holds the FIRST prompt for every pending server up to
// MCP_TIMEOUT (30 s by default), then sends it with whatever has connected:
// a server still pending is left out with no word to the model (measured on
// 2.1.280 and 2.1.296 with a fake server that never answers: `init` lists it
// as "pending" and the request carries none of its tools). A reused process
// has no hold at all. So the driver asks the CLI itself (`mcp_status`) before
// it writes the prompt, reconnects a failed required server (`mcp_reconnect`,
// all of them together, under one deadline per turn), and tells the bot
// plainly when one is still missing.

/** Servers the turn needs when they are mounted: connected apps, memory and
 * the bot-to-bot tools. Everything else (computer, browser, phone, custom
 * servers) is optional and never holds a turn past MCP_OPTIONAL_WAIT_MS. */
export const REQUIRED_MCP_SERVERS: Readonly<Record<string, string>> = {
  // murage_connectors is the mount; composio is the name releases before 1.0.2 mounted it
  // under, still mounted for a session one of them started (shared/connected-app-names.ts).
  murage_connectors: "connected apps",
  composio: "connected apps",
  "murage-memory": "memory",
  agents: "messaging other bots",
};

/** How long a turn waits for a required server that is still connecting,
 * measured from the first status check. Murage's own servers answer in about
 * half a second on an idle Mac; connected apps took 5.3 s on a busy one
 * (Sable's Grok sessions), and a load average near 19 on a 10-core Mac
 * stretches process start-up by roughly 3x. 15 s covers that with room. */
export const MCP_REQUIRED_WAIT_MS = 15_000;
/** The ONE recovery deadline of a turn, across every server: the wait above
 * and every reconnect (sent together, in parallel) end by it, so three missing
 * servers cost what one does. Far below the 60 s stall watchdog. */
export const MCP_TURN_RECOVERY_MS = 20_000;
/** The CLI's own connect bound (MCP_TIMEOUT), which also ends its reconnect. Process-wide for
 * the CLI, custom servers included, so it stays at 15 s: the connector bridge's absolute list
 * deadline (CONNECTOR_LIST_DEADLINE_MS, 8 s) plus its margin is still below it. */
export const MCP_RECONNECT_WAIT_MS = 15_000;
/** Optional servers: never hold the turn longer than this. */
export const MCP_OPTIONAL_WAIT_MS = 3_000;
/** When the wait becomes visible: a chip says what the turn is waiting for. */
export const MCP_WAIT_CHIP_AFTER_MS = 1_500;
/** A reconnect is only started with at least this much of the deadline left. */
const MIN_RECONNECT_WINDOW_MS = 1_000;
const POLL_MS = 250;
export const MCP_STATUS_ANSWER_MS = 3_000;
/** How long a fresh engine's FIRST status answer is waited for. A Claude CLI on
 * Windows takes longer to start reading its control requests: on the 1.0.3 gate
 * (CLI 2.1.307, Vultr and a second Windows box) no first answer came within 3 s on any new
 * process, so the turn went ahead unchecked with the CLI's own start-up hold
 * off, and two such turns marked the build unsupported. There the first answer
 * gets the whole required-server wait. The same CLI answers within 3 s on Linux
 * and macOS, where a build that never answers keeps costing only 3 s. */
export function mcpFirstAnswerMs(platform: NodeJS.Platform = process.platform): number {
  return platform === "win32" ? Math.max(MCP_STATUS_ANSWER_MS, mcpRequiredWaitMs()) : MCP_STATUS_ANSWER_MS;
}

const envMs = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 && process.env[name] !== undefined && process.env[name] !== "" ? value : fallback;
};
export const mcpRequiredWaitMs = (): number => envMs("MURAGE_MCP_REQUIRED_WAIT_MS", MCP_REQUIRED_WAIT_MS);
export const mcpRecoveryMs = (): number => envMs("MURAGE_MCP_RECOVERY_MS", MCP_TURN_RECOVERY_MS);
export const mcpReconnectWaitMs = (): number => envMs("MURAGE_MCP_RECONNECT_WAIT_MS", MCP_RECONNECT_WAIT_MS);
export const mcpOptionalWaitMs = (): number => envMs("MURAGE_MCP_OPTIONAL_WAIT_MS", MCP_OPTIONAL_WAIT_MS);

/** The plain name of a required server, or null for an optional one. */
export function requiredMcpLabel(name: string): string | null {
  return Object.hasOwn(REQUIRED_MCP_SERVERS, name) ? REQUIRED_MCP_SERVERS[name]! : null;
}

export function splitMcpServers(names: Iterable<string>): { required: string[]; optional: string[] } {
  const required: string[] = [];
  const optional: string[] = [];
  for (const name of names) (requiredMcpLabel(name) ? required : optional).push(name);
  return { required, optional };
}

/** The labels of the missing servers, deduplicated, in a stable order. */
export function unavailableLabels(missing: Iterable<string>): string[] {
  return [...new Set([...missing].map((name) => requiredMcpLabel(name) ?? name))];
}

function joinLabels(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

/** "connected apps were", "memory was". */
function wasOrWere(labels: string[]): string {
  return labels.length > 1 || labels[0] === "connected apps" ? "were" : "was";
}

/** The words a bot starts its reply with when its task needed tools that were
 * not there. A routine run whose reply starts with them is not "Completed". */
export const NOT_DONE_PREFIX = "Not done:";
/** Whether a reply opens with NOT_DONE_PREFIX: any case, leading whitespace and
 * markdown emphasis or a quote/heading marker around it ("**Not done:** ...",
 * "> _not done_: ..."). */
export function startsWithNotDone(text: string): boolean {
  return /^[\s*_~`>#-]*not\s+done[\s*_~`]*:/i.test(text);
}

/** What the bot does about it, by whether its task needs the tools. */
function ifNeeded(list: string, verb: string): string {
  return `If this task does not need ${list}, do it as usual and report it as you normally would. If it does, do not guess or search for those tools again: start your reply with "${NOT_DONE_PREFIX}", tell the user plainly that ${list} ${verb} not ready, and do the parts of the task you can without them.`;
}

/** The note that rides in front of the turn's own text when a required server
 * did not load: the bot reports it instead of guessing, only when it matters. */
export function toolsUnavailableNotice(labels: string[]): string {
  const list = joinLabels(labels);
  return `[Murage: the tools for ${list} did not finish loading for this turn, so they are not available right now. ${ifNeeded(list, wasOrWere(labels))}]`;
}

/** The engine could not say which servers had loaded (the ACP engines report
 * only that not every server settled; a Claude Code that does not answer a
 * status request): the same instruction, for tools that may still load. */
export function toolsMayBeLoadingNotice(labels: string[]): string {
  const list = joinLabels(labels);
  return `[Murage: ${list} ${wasOrWere(labels)} may still be loading when this turn started. If the tools for ${list} are there, use them as usual. ${ifNeeded(list, wasOrWere(labels))}]`;
}

/** The routine outcome for a run whose task needed tools that were not there. */
export function toolsUnavailableRunError(labels: string[]): string {
  if (!labels.length) return "The tools this run needed were not ready when it started.";
  const list = joinLabels(labels);
  const first = list.charAt(0).toUpperCase() + list.slice(1);
  const plural = wasOrWere(labels) === "were";
  return `${first} ${plural ? "were" : "was"} not ready when this run started, and the run needed ${plural ? "them" : "it"}.`;
}

/** The chip shown while the turn waits. */
export function mcpWaitChipTitle(labels: string[]): string {
  return `Loading ${joinLabels(labels)}`;
}

export type McpServerState = "connected" | "pending" | "failed" | "needs-auth" | "disabled" | "unknown";
/** What the turn knows about its required tools when its prompt goes out:
 * all connected, some missing, or the engine could not say. */
export type McpReadiness = "ready" | "degraded" | "unknown";

/** Servers that keep failing are not waited for or reconnected again on every
 * turn: after a failed recovery a server is skipped for a while (1 min, then
 * doubling to 15 min), still checked once per turn, and cleared the moment it
 * reports connected. Keyed by whatever the caller scopes it to (a thread). */
export class McpBackoff {
  private readonly entries = new Map<string, { failures: number; until: number; probedAt: number }>();
  private readonly now: () => number;
  private readonly baseMs: number;
  private readonly maxMs: number;
  // Plain fields, not parameter properties: the server runs under Node's type stripping.
  constructor(now: () => number = Date.now, baseMs = 60_000, maxMs = 15 * 60_000) {
    this.now = now;
    this.baseMs = baseMs;
    this.maxMs = maxMs;
  }
  blocked(key: string): boolean {
    const entry = this.entries.get(key);
    return !!entry && this.now() < entry.until;
  }
  failed(key: string): void {
    const failures = (this.entries.get(key)?.failures ?? 0) + 1;
    this.entries.set(key, { failures, until: this.now() + Math.min(this.maxMs, this.baseMs * 2 ** (failures - 1)), probedAt: this.now() });
  }
  /** True once per base window for a server that is backed off: the caller
   * sends one cheap reconnect in the background, so a backend that recovered
   * is not hidden for the whole backoff. */
  probeDue(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry || this.now() >= entry.until || this.now() - entry.probedAt < this.baseMs) return false;
    entry.probedAt = this.now();
    return true;
  }
  succeeded(key: string): void { this.entries.delete(key); }
  clear(): void { this.entries.clear(); }
}

/** A status answer: the states, "unsupported" (the engine refused the request
 * as one it does not know), or null (no answer within the bound). */
export type McpStatusAnswer = Map<string, McpServerState> | "unsupported" | null;

export interface McpGateIo {
  status: (timeoutMs: number) => Promise<McpStatusAnswer>;
  /** Reconnect one server; resolves when the engine answers or the bound passes. */
  reconnect: (name: string, timeoutMs: number) => Promise<void>;
  /** The turn was stopped: the gate ends at once. */
  stopped: () => boolean;
  /** Called once when the wait has lasted long enough to show. */
  onSlow?: (waitingFor: string[]) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Per-server backoff and the key it files a server under. */
  backoff?: { store: McpBackoff; key: (name: string) => string };
}

export interface McpGateResult {
  /** Required servers that are still not connected when the turn starts. */
  missing: string[];
  /** Required servers a reconnect was sent for. */
  reconnected: string[];
  /** Required servers skipped (not waited for, not reconnected) under backoff. */
  backedOff: string[];
  /** The engine never answered a status request: nothing was checked. */
  unchecked: boolean;
  /** Why it was unchecked: the request is unknown to it, or no answer came. */
  uncheckedReason?: "unsupported" | "no-answer";
  readiness: McpReadiness;
  waitedMs: number;
  stopped: boolean;
}

/** Wait (bounded) for the turn's required servers, reconnect the failed ones
 * (all at once), and report which are still missing. One deadline covers the
 * whole recovery; optional servers are waited for only within the optional
 * budget and never reconnected. A server still connecting is not reconnected
 * (that would restart its connect): it is reported missing at the deadline. */
export async function awaitRequiredMcp(
  servers: { required: string[]; optional: string[] },
  io: McpGateIo,
  budgets: { requiredMs?: number; optionalMs?: number; recoveryMs?: number; firstAnswerMs?: number } = {},
): Promise<McpGateResult> {
  const now = io.now ?? Date.now;
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref?.(); }));
  const recoveryMs = budgets.recoveryMs ?? mcpRecoveryMs();
  const requiredMs = Math.min(budgets.requiredMs ?? mcpRequiredWaitMs(), recoveryMs);
  const optionalMs = Math.min(budgets.optionalMs ?? mcpOptionalWaitMs(), recoveryMs);
  const started = now();
  const deadline = started + recoveryMs;
  const backoffKey = (name: string) => io.backoff?.key(name) ?? name;
  const backedOff = io.backoff ? servers.required.filter((name) => io.backoff!.store.blocked(backoffKey(name))) : [];
  const live = servers.required.filter((name) => !backedOff.includes(name));
  const result = (fields: Partial<McpGateResult> & { missing: string[] }): McpGateResult => {
    const unchecked = fields.unchecked ?? false;
    return {
      reconnected: [], backedOff, unchecked, stopped: false,
      readiness: unchecked ? "unknown" : fields.missing.length ? "degraded" : "ready",
      ...fields, waitedMs: now() - started,
    };
  };
  if (!servers.required.length && !servers.optional.length) return result({ missing: [] });
  let states: Map<string, McpServerState> | null = null;
  // Until the engine first answers, it may still be starting (mcpFirstAnswerMs).
  const firstAnswerMs = Math.max(MCP_STATUS_ANSWER_MS, Math.min(budgets.firstAnswerMs ?? MCP_STATUS_ANSWER_MS, requiredMs));
  const statusNow = () => io.status(Math.max(1, Math.min(states ? MCP_STATUS_ANSWER_MS : firstAnswerMs, deadline - now())));
  let slowShown = false;
  const reconnecting = new Map<string, Promise<void>>();
  for (;;) {
    if (io.stopped()) return result({ missing: [], stopped: true });
    const asking = statusNow();
    // A long wait for the first answer shows the same chip as a wait for a server.
    if (!states && !slowShown && io.onSlow && firstAnswerMs > MCP_STATUS_ANSWER_MS) {
      let answered = false;
      void asking.finally(() => { answered = true; }).catch(() => {});
      await Promise.race([asking, sleep(MCP_WAIT_CHIP_AFTER_MS)]).catch(() => {});
      if (!answered && !io.stopped()) { slowShown = true; io.onSlow([...live, ...servers.optional]); }
    }
    const answer = await asking;
    if (io.stopped()) return result({ missing: [], stopped: true });
    if (answer === null || answer === "unsupported") {
      if (!states) return result({ missing: [], unchecked: true, uncheckedReason: answer === null ? "no-answer" : "unsupported" });
      break; // it answered before: keep the last states, the deadline is near
    }
    states = answer;
    const at = now();
    // A failed required server is reconnected the moment it is seen failed,
    // all of them together, each bounded by what is left of the deadline.
    for (const name of live) {
      if (states.get(name) !== "failed" || reconnecting.has(name)) continue;
      const left = deadline - at;
      if (left < MIN_RECONNECT_WINDOW_MS) continue;
      reconnecting.set(name, io.reconnect(name, left).catch(() => {}));
    }
    const requiredPending = live.filter((name) => states!.get(name) === "pending" && !reconnecting.has(name));
    const optionalPending = servers.optional.filter((name) => states!.get(name) === "pending");
    const waitRequired = requiredPending.length > 0 && at - started < requiredMs;
    const waitOptional = optionalPending.length > 0 && at - started < optionalMs;
    if (!waitRequired && !waitOptional) break;
    if (!slowShown && at - started >= MCP_WAIT_CHIP_AFTER_MS) {
      slowShown = true;
      io.onSlow?.([...(waitRequired ? requiredPending : []), ...(waitOptional ? optionalPending : [])]);
    }
    await sleep(Math.max(0, Math.min(POLL_MS, deadline - at)));
  }
  const notConnected = (map: Map<string, McpServerState>) => servers.required.filter((name) => map.get(name) !== "connected");
  if (reconnecting.size) {
    let settled = false;
    const all = Promise.all(reconnecting.values()).then(() => { settled = true; });
    // A reconnect long enough to notice shows the same chip as a wait.
    if (!slowShown) {
      await Promise.race([all, sleep(Math.max(0, Math.min(started + MCP_WAIT_CHIP_AFTER_MS, deadline) - now()))]);
      if (!settled && !io.stopped()) {
        slowShown = true;
        io.onSlow?.([...reconnecting.keys()]);
      }
    }
    if (!settled) await Promise.race([all, sleep(Math.max(0, deadline - now()))]);
    if (io.stopped()) return result({ missing: notConnected(states!), reconnected: [...reconnecting.keys()], stopped: true });
    const after = deadline - now() > 0 ? await statusNow() : null;
    // No answer after a reconnect: the engine is still busy with it, so
    // nothing it reconnected can be counted on for this turn.
    if (after instanceof Map) states = after;
    else for (const name of reconnecting.keys()) states!.set(name, "failed");
  }
  const missing = notConnected(states!);
  if (io.backoff && !io.stopped()) {
    // A backed-off server the engine still reports failed gets one background
    // reconnect per backoff window; a recovery clears its backoff.
    const store = io.backoff.store;
    for (const name of backedOff) {
      if (states!.get(name) !== "failed" || !store.probeDue(backoffKey(name))) continue;
      void io.reconnect(name, mcpReconnectWaitMs())
        .then(() => io.status(MCP_STATUS_ANSWER_MS))
        .then((after) => { if (after instanceof Map && after.get(name) === "connected") store.succeeded(backoffKey(name)); })
        .catch(() => {});
    }
  }
  if (io.backoff) {
    for (const name of servers.required) {
      if (states!.get(name) === "connected") io.backoff.store.succeeded(backoffKey(name));
      else if (!backedOff.includes(name)) io.backoff.store.failed(backoffKey(name));
    }
  }
  return result({ missing, reconnected: [...reconnecting.keys()] });
}

/** Whether an engine build answers the per-server status request, per
 * executable identity (path and version). A build that refuses it as unknown
 * is unsupported at once; one that never answers is counted unsupported after
 * SILENT_LIMIT silent turns in a row, and a build that has answered once is
 * supported from then on (a later silence is a transient failure, and that
 * turn's readiness is "unknown"). An unsupported build is not asked again, so
 * it pays nothing per turn; the caller falls back to the engine's own bounded
 * start-up hold and tells the bot its tools may still be loading. */
export class McpStatusSupport {
  static readonly SILENT_LIMIT = 2;
  private readonly entries = new Map<string, { verdict: "supported" | "unsupported" | "probing"; silent: number }>();
  get(identity: string): "supported" | "unsupported" | "probing" {
    return this.entries.get(identity)?.verdict ?? "probing";
  }
  observe(identity: string, outcome: "answered" | "unsupported" | "no-answer"): void {
    const entry = this.entries.get(identity) ?? { verdict: "probing" as const, silent: 0 };
    if (outcome === "answered") this.entries.set(identity, { verdict: "supported", silent: 0 });
    else if (outcome === "unsupported") { if (entry.verdict !== "supported") this.entries.set(identity, { verdict: "unsupported", silent: 0 }); }
    else if (entry.verdict === "probing") {
      const silent = entry.silent + 1;
      this.entries.set(identity, { verdict: silent >= McpStatusSupport.SILENT_LIMIT ? "unsupported" : "probing", silent });
    }
  }
  clear(): void { this.entries.clear(); }
}

/** A control answer refusing a request the engine does not know. */
export function isUnsupportedAnswer(error: unknown): boolean {
  return typeof error === "string" && /not supported|unsupported|unknown (control )?(request|subtype)|unrecognized|invalid (control )?request|method not found/i.test(error);
}

/** Parse the CLI's `mcp_status` answer into name -> state. */
export function parseMcpStatus(response: unknown): Map<string, McpServerState> | null {
  const list = (response as { mcpServers?: unknown } | null)?.mcpServers;
  if (!Array.isArray(list)) return null;
  const states = new Map<string, McpServerState>();
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const { name, status } = entry as { name?: unknown; status?: unknown };
    if (typeof name !== "string") continue;
    states.set(name, status === "connected" || status === "pending" || status === "failed" || status === "needs-auth" || status === "disabled" ? status : "unknown");
  }
  return states;
}
