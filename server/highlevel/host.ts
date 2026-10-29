// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The native HighLevel host (GAP-HIGHLEVEL-109 sections 7, 9.2 and 13): one JSON-RPC entry for the bot's turn,
// adapted from OpenMausBot server/highlevel/host.ts and rpc.ts. Every call checks, in order: a `highlevel` turn
// capability that is still active, the owner audience, a live bot, the native grant and a browser-confirmed connection
// (access.ts). The same checks run again before a result is released, so a Stop, a revoked grant or a changed
// connection never hands a result to a turn that may no longer see it.
//
// Stop (H3): HighLevelTurnSignals holds one AbortController per turn generation. index.ts revokeInternalGeneration
// calls highlevelCalls.turnEnded(generation), which fires it: a call waiting for rate room, a Retry-After, its one
// read retry or the owner's review ends at once, nothing more is sent, and a change waiting to be sent is recorded
// not_applied with reason stopped_before_send. A change already sent is not recalled.
//
// Not in this slice: the /api/internal/highlevel/ route, engine mounts and the owner review route. The capability
// kind and the Stop hook are wired so those can attach without new authority paths.
import { isHighLevelHelperName, isHighLevelToolName, type HighLevelToolName } from "../../shared/highlevel.ts";
import type { InternalCapability } from "../internal-capabilities.ts";
import { authorizeHighLevelCall, nativeAccessFor, visibleHighLevelTools, type HighLevelAccessBot, type HighLevelDecision } from "./access.ts";
import { ActionRefused, type ActionContext, type ActionReview, type HighLevelActions } from "./actions.ts";
import { HighLevelError, HighLevelStopped, PAGE_MAX, type HighLevelCallContext, type HighLevelClient, type HighLevelLeaseSource } from "./client.ts";
import {
  advertisedTool,
  changedFields,
  changeProblem,
  checkToolArguments,
  highlevelErrorResult,
  highlevelOk,
  highlevelToolDefinition,
  runHighLevelTool,
  type HighLevelToolResult,
  type HighLevelWriteRecord,
} from "./tools.ts";

const TURN_LIMIT = 4_096;

/** One abort signal per turn generation, fired by Stop. */
export class HighLevelTurnSignals {
  readonly #turns = new Map<string, { threadId: string; botId: string; controller: AbortController }>();
  /** Generations already ended: a late call for one gets an aborted signal, never a fresh one. */
  readonly #ended = new Set<string>();

  signalFor(claim: Pick<InternalCapability, "generation" | "threadId" | "botId">): AbortSignal {
    if (this.#ended.has(claim.generation)) return AbortSignal.abort();
    let turn = this.#turns.get(claim.generation);
    if (!turn || turn.threadId !== claim.threadId || turn.botId !== claim.botId) {
      if (turn) turn.controller.abort();
      turn = { threadId: claim.threadId, botId: claim.botId, controller: new AbortController() };
      this.#turns.set(claim.generation, turn);
      while (this.#turns.size > TURN_LIMIT) {
        const oldest = this.#turns.keys().next().value!;
        this.#turns.get(oldest)?.controller.abort();
        this.#turns.delete(oldest);
      }
    }
    return turn.controller.signal;
  }

  turnEnded(generation: string): void {
    this.#turns.get(generation)?.controller.abort();
    this.#turns.delete(generation);
    this.#ended.add(generation);
    while (this.#ended.size > TURN_LIMIT) this.#ended.delete(this.#ended.values().next().value!);
  }

  turnEndedForThread(threadId: string): void {
    for (const [generation, turn] of this.#turns) if (turn.threadId === threadId) this.turnEnded(generation);
  }

  turnEndedForBot(botId: string): void {
    for (const [generation, turn] of this.#turns) if (turn.botId === botId) this.turnEnded(generation);
  }

  turnEndedAll(): void {
    for (const generation of this.#turns.keys()) this.turnEnded(generation);
  }

  get size(): number { return this.#turns.size; }
}

export interface HighLevelHostDeps {
  capabilities: { isActive(claim: InternalCapability): boolean };
  signals: HighLevelTurnSignals;
  bot(botId: string): HighLevelAccessBot | undefined;
  leases: HighLevelLeaseSource;
  client: HighLevelClient;
  actions: HighLevelActions;
  /** A change is waiting for the owner (the card and notification attach here later). */
  onReview?: (claim: InternalCapability, review: ActionReview) => void;
  /** A change ran: ids and field names only. */
  onReceipt?: (claim: InternalCapability, receipt: HighLevelWriteRecord & { actionId: string; connectionId: string }) => void;
}

type JsonRpc = { jsonrpc?: string; id?: unknown; method?: unknown; params?: unknown };
type JsonRpcResponse = { jsonrpc: "2.0"; id: unknown; result?: unknown; error?: { code: number; message: string } };

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const STOPPED_TEXT = "Stopped. Nothing more was sent to the CRM.";

export class HighLevelHost {
  readonly #deps: HighLevelHostDeps;
  constructor(deps: HighLevelHostDeps) { this.#deps = deps; }

  /** Why this claim may not use HighLevel at all right now, or null. */
  #claimRefusal(claim: InternalCapability): string | null {
    if (claim.kind !== "highlevel") return "This capability cannot reach HighLevel.";
    if (!this.#deps.capabilities.isActive(claim)) return "This turn has ended.";
    if (claim.notOwnerAudience) return "HighLevel runs only in the owner's own conversations, not where others are speaking.";
    const bot = this.#deps.bot(claim.botId);
    if (!bot || bot.hidden) return "This bot is not available.";
    return null;
  }

  async handle(claim: InternalCapability, message: unknown): Promise<JsonRpcResponse> {
    const request: JsonRpc = object(message) ? message : {};
    const id = request.id ?? null;
    const refusal = this.#claimRefusal(claim);
    if (refusal) return { jsonrpc: "2.0", id, error: { code: -32001, message: refusal } };
    if (request.method === "initialize") return { jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "highlevel", version: "1" } } };
    if (request.method === "ping") return { jsonrpc: "2.0", id, result: {} };
    if (request.method === "tools/list") {
      const names = visibleHighLevelTools(this.#deps.bot(claim.botId));
      return { jsonrpc: "2.0", id, result: { tools: names.map((name) => advertisedTool(highlevelToolDefinition(name)!)) } };
    }
    if (request.method !== "tools/call" || !object(request.params)) return { jsonrpc: "2.0", id, error: { code: -32601, message: "Unsupported HighLevel request." } };
    const params = request.params;
    if (Object.keys(params).some((key) => !["name", "arguments", "_meta"].includes(key))) return { jsonrpc: "2.0", id, error: { code: -32602, message: "Unsupported request fields." } };
    return { jsonrpc: "2.0", id, result: await this.call(claim, params.name, params.arguments ?? {}) };
  }

  /** One tool call. Always answers with a tool result; a refusal is an error result in words. */
  async call(claim: InternalCapability, name: unknown, args: unknown): Promise<HighLevelToolResult> {
    const refusal = this.#claimRefusal(claim);
    if (refusal) return highlevelErrorResult(refusal);
    const problem = checkToolArguments(name, args);
    if (problem) return highlevelErrorResult(problem);
    const a = args as Record<string, unknown>;
    if (isHighLevelHelperName(name)) return this.#helper(claim, name, a);
    if (!isHighLevelToolName(name)) return highlevelErrorResult("Unknown HighLevel tool.");
    const decision = await this.#authorize(claim, name, a);
    if (!decision.ok) return highlevelErrorResult(decision.text, { code: decision.code });
    const signal = this.#deps.signals.signalFor(claim);
    if (signal.aborted) return highlevelErrorResult(STOPPED_TEXT, { stopped: true });
    return decision.write ? this.#change(claim, name, a, decision, signal) : this.#read(claim, name, a, decision, signal);
  }

  #authorize(claim: InternalCapability, tool: string, args: Record<string, unknown>): Promise<HighLevelDecision> {
    return authorizeHighLevelCall({
      bot: this.#deps.bot(claim.botId), tool,
      connectionId: typeof args.connectionId === "string" ? args.connectionId : undefined,
      connection: (connectionId) => this.#deps.leases.connection(connectionId),
    });
  }

  #context(claim: InternalCapability, decision: Extract<HighLevelDecision, { ok: true }>, signal: AbortSignal, onDispatch?: (attempt: number) => Promise<void>): HighLevelCallContext {
    return {
      connection: decision.connection,
      signal,
      assertActive: () => { if (signal.aborted || !this.#deps.capabilities.isActive(claim)) throw new HighLevelStopped(); },
      ...(onDispatch ? { onDispatch } : {}),
    };
  }

  /** The same authority as when the call started, checked again now (result release, dispatch). */
  async #stillAuthorized(claim: InternalCapability, tool: string, args: Record<string, unknown>, before: Extract<HighLevelDecision, { ok: true }>): Promise<Extract<HighLevelDecision, { ok: true }> | string> {
    if (this.#claimRefusal(claim)) return STOPPED_TEXT;
    const now = await this.#authorize(claim, tool, args);
    if (!now.ok) return now.text;
    if (now.grant.accountId !== before.grant.accountId || now.connection.epoch !== before.connection.epoch || now.connection.locationId !== before.connection.locationId
      || now.connection.companyId !== before.connection.companyId) {
      return "The HighLevel connection changed while this call ran. Run it again.";
    }
    // the asynchronous connection read above may have spanned a Stop
    if (this.#claimRefusal(claim)) return STOPPED_TEXT;
    return now;
  }

  async #read(claim: InternalCapability, tool: HighLevelToolName, args: Record<string, unknown>, decision: Extract<HighLevelDecision, { ok: true }>, signal: AbortSignal): Promise<HighLevelToolResult> {
    let value: unknown;
    try {
      ({ value } = await runHighLevelTool(this.#deps.client.crm(this.#context(claim, decision, signal)), tool, args));
    } catch (error) {
      if (error instanceof HighLevelStopped) return highlevelErrorResult(STOPPED_TEXT, { stopped: true });
      if (error instanceof HighLevelError) return highlevelErrorResult(error.message, { ...(error.status ? { status: error.status } : {}), ...(error.signedOut ? { reconnect: true } : {}) });
      throw error;
    }
    const release = await this.#stillAuthorized(claim, tool, args, decision);
    if (typeof release === "string") return highlevelErrorResult(release, release === STOPPED_TEXT ? { stopped: true } : {});
    return highlevelOk(value);
  }

  async #change(claim: InternalCapability, tool: HighLevelToolName, args: Record<string, unknown>, decision: Extract<HighLevelDecision, { ok: true }>, signal: AbortSignal): Promise<HighLevelToolResult> {
    const problem = changeProblem(tool, args);
    if (problem) return highlevelErrorResult(problem);
    const context = (d: Extract<HighLevelDecision, { ok: true }>): ActionContext => ({
      botId: claim.botId, threadId: claim.threadId, turnGeneration: claim.generation, connectionId: d.grant.accountId, connectionEpoch: d.connection.epoch,
      locationId: d.connection.locationId, companyId: d.connection.companyId, grantRevision: d.grant.revision, accessRevision: d.accessRevision,
      policyRevision: d.policyRevision, roleBinding: d.roleBinding,
    });
    const recordRefs = ["contactId", "opportunityId", "pipelineId", "stageId"].flatMap((key) => (typeof args[key] === "string" ? [`${key}:${args[key] as string}`] : []));
    let review: ActionReview;
    try {
      review = this.#deps.actions.propose(context(decision), tool, args, { recordRefs, fields: changedFields(tool, args) });
    } catch (error) {
      if (error instanceof ActionRefused) return highlevelErrorResult(error.message, { code: error.code });
      throw error;
    }
    const { actionId } = review;
    this.#deps.onReview?.(claim, review);
    let decided: "approved" | "denied" | "expired";
    try {
      decided = await this.#deps.actions.awaitDecision(actionId, signal);
    } catch (error) {
      if (!(error instanceof HighLevelStopped)) throw error;
      this.#deps.actions.notApplied(actionId, "stopped_before_send");
      return highlevelErrorResult(`${STOPPED_TEXT} The change was not made.`, { actionId, stopped: true, outcome: "not_applied" });
    }
    if (decided === "denied") return highlevelErrorResult("The owner declined this change. It was not made.", { actionId, outcome: "not_applied" });
    if (decided === "expired") return highlevelErrorResult("The review expired before the owner decided. The change was not made.", { actionId, outcome: "stale" });
    const current = await this.#stillAuthorized(claim, tool, args, decision);
    if (typeof current === "string") {
      if (signal.aborted || !this.#deps.capabilities.isActive(claim)) {
        this.#deps.actions.notApplied(actionId, "stopped_before_send");
        return highlevelErrorResult(`${STOPPED_TEXT} The change was not made.`, { actionId, stopped: true, outcome: "not_applied" });
      }
      this.#deps.actions.markStale(actionId, "authority_changed");
      return highlevelErrorResult(`${current} The approval no longer applies, so the change was not made.`, { actionId, outcome: "stale" });
    }
    let reviewed: Record<string, unknown>;
    try {
      ({ values: reviewed } = this.#deps.actions.beginDispatch(actionId, context(current)));
    } catch (error) {
      if (error instanceof ActionRefused) return highlevelErrorResult(error.message, { actionId, outcome: "stale" });
      throw error;
    }
    // Only the reviewed values are sent, with the connection the owner approved.
    const sendArgs: Record<string, unknown> = { ...reviewed, ...(typeof args.connectionId === "string" ? { connectionId: args.connectionId } : {}) };
    // Immediately before the send (after any rate or lease wait): the authority and approval as they are now.
    const onDispatch = async (attempt: number) => {
      const now = await this.#stillAuthorized(claim, tool, args, current);
      if (typeof now === "string") {
        if (now === STOPPED_TEXT) throw new HighLevelStopped();
        this.#deps.actions.markStale(actionId, "authority_changed");
        throw new ActionRefused("stale", `${now} The approval no longer applies, so the change was not made.`);
      }
      this.#deps.actions.recordAttempt(actionId, attempt, context(now));
    };
    let write: HighLevelWriteRecord | undefined;
    let value: unknown;
    try {
      ({ value, write } = await runHighLevelTool(this.#deps.client.crm(this.#context(claim, current, signal, onDispatch)), tool, sendArgs));
    } catch (error) {
      if (error instanceof HighLevelStopped) {
        if ((this.#deps.actions.get(actionId)?.dispatchAttempts ?? 0) > 0) {
          this.#deps.actions.outcomeUnknown(actionId, "stopped_after_send");
          return highlevelErrorResult(`${STOPPED_TEXT} The change may have reached HighLevel; use HIGHLEVEL_ACTION_STATUS or check the CRM. Murage will not send it again.`, { actionId, stopped: true, outcome: "outcome_unknown" });
        }
        this.#deps.actions.notApplied(actionId, "stopped_before_send");
        return highlevelErrorResult(`${STOPPED_TEXT} The change was not made.`, { actionId, stopped: true, outcome: "not_applied" });
      }
      if (error instanceof HighLevelError) {
        if (error.outcome === "outcome_unknown") {
          this.#deps.actions.outcomeUnknown(actionId, "possible_send");
          return highlevelErrorResult(`${error.message} Use HIGHLEVEL_ACTION_STATUS or check the CRM; Murage will not send it again.`, { actionId, outcome: "outcome_unknown" });
        }
        this.#deps.actions.notApplied(actionId, error.status ? `provider_${error.status}` : "refused");
        return highlevelErrorResult(error.message, { actionId, outcome: "not_applied", ...(error.signedOut ? { reconnect: true } : {}) });
      }
      if (error instanceof ActionRefused) {
        const phase = this.#deps.actions.get(actionId)?.phase;
        if (phase === "stale") return highlevelErrorResult(error.message, { actionId, outcome: "stale" });
        this.#deps.actions.notApplied(actionId, error.code);
        return highlevelErrorResult(error.message, { actionId, outcome: "not_applied" });
      }
      if ((this.#deps.actions.get(actionId)?.dispatchAttempts ?? 0) > 0) this.#deps.actions.outcomeUnknown(actionId, "internal_error_after_send");
      else this.#deps.actions.notApplied(actionId, "internal_error");
      throw error;
    }
    const receipt = { recordId: write?.recordId ?? "", fields: write?.fields ?? changedFields(tool, sendArgs) };
    this.#deps.actions.applied(actionId, receipt);
    if (write) this.#deps.onReceipt?.(claim, { ...write, actionId, connectionId: current.grant.accountId });
    const release = await this.#stillAuthorized(claim, tool, args, current);
    if (typeof release === "string") return highlevelErrorResult(`The change was made, but its result is not shown here: ${release}`, { actionId, outcome: "applied" });
    return highlevelOk({ actionId, outcome: "applied", result: value });
  }

  async #helper(claim: InternalCapability, name: "HIGHLEVEL_LIST_CONNECTIONS" | "HIGHLEVEL_ACTION_STATUS", args: Record<string, unknown>): Promise<HighLevelToolResult> {
    const bot = this.#deps.bot(claim.botId);
    if (!bot || bot.composio === false) return highlevelErrorResult("Connected apps are off for this bot, so it cannot use HighLevel.");
    if (name === "HIGHLEVEL_ACTION_STATUS") {
      const status = this.#deps.actions.statusFor(claim.botId, String(args.actionId));
      return status ? highlevelOk(status) : highlevelErrorResult("This bot has no HighLevel change with that id.");
    }
    const grants = nativeAccessFor(bot)?.grants ?? [];
    const start = typeof args.cursor === "string" ? Number(args.cursor) : 0;
    const limit = Math.min(PAGE_MAX, Math.max(1, typeof args.limit === "number" ? args.limit : 20));
    const page = grants.slice(start, start + limit);
    const connections = [];
    for (const grant of page) {
      const view = await this.#deps.leases.connection(grant.accountId);
      connections.push({ connectionId: grant.accountId, locationName: view?.locationName, state: view?.state ?? "disconnected", tools: [...grant.tools], ceiling: grant.ceiling });
    }
    return highlevelOk({ connections, ...(start + limit < grants.length ? { nextCursor: String(start + limit) } : {}) });
  }
}
