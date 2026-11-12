import {finalDecision} from '../../shared/no-limits-decision.ts';
import {CONNECTED_APPS_OFF} from '../feature-off.ts';
import { upgradeHighLevelAction } from './policy-upgrade.ts';
import { destructiveName, mcpBulkWipe } from '../no-limits-wipe-mcp.ts';
import { serviceNoLimits } from '../service-no-limits.ts';
import { inertBot } from "../store.ts";
import { InvoiceReviewRefused } from './errors.ts';
import { operationExtension } from './operation-extension.ts';
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
// HL-WRITES-1019: index.ts installs the desktop review and policy hooks. Operation families use the frozen registry;
// C1 owns the stored grant view and owner-turn mount gate. With no connection source, no credential is requested.
import { requestChanged, dispatchAdmissions, recheckAdmissions, noLimitsForContext } from './request-change.ts';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalBindingJson } from './binding-json.ts';
import { runRpcApprovedWrite, type RpcApprovalBinding, type RpcApprovalJournal } from './rpc-approval-replay.ts';
import { prepareTagReturnedIdentitySchema } from './returned-confirmation.ts';
import { validTagSet } from './returned-confirmation-state.ts';
import { HIGHLEVEL_RETURNED_CONFIRMATION_SCHEMAS } from './operations/returned-confirmation-schemas.ts';
import { prepareContactConfirmation } from './contact-confirmation.ts';
import { contactRecoveryPlan, prepareContactRecovery, saveContactRecovery, reconcileContactEffect } from './contact-recovery.ts';
import { prepareOpportunityRecovery } from './opportunity-recovery-plan.ts';
import { opportunityReplayBinding, reconcileOpportunityEffect } from './opportunity-replay.ts';
import { parseIntent } from './journal-file.ts';
import { z } from "zod";
import { toolCallActionId, heldToolCallActions } from './tool-call-binding.ts';
import { runApprovedWrite, type ApprovalJournal, type ApprovalOutcome } from './approval-idempotency.ts';
import { prepareWriteRecovery, captureRecoveryPreState, saveWriteRecovery, loadWriteRecoveryForSpec, readWriteRecovery, compareWriteRecovery, type WriteRecoveryPlan } from './write-recovery.ts';
import { readReconciliation } from './reconciliation-read.ts';
import { reconciliationReadsFor } from './operations/reconciliation.ts';
import { runApprovedInvocation } from './approval-invocations.ts';
import { prepareReturnedIdentitySchema, bindReturnedIdentities } from './returned-identities.ts';
import { HIGHLEVEL_FAMILIES, HIGHLEVEL_FAMILY_TOOLS, LEGACY_TOOL_TO_OPERATION, type Family, type Risk, type OperationId } from "../../shared/highlevel.ts";
import { accessRoleBinding, botAccessPolicy } from "../bot-access-role.ts";
import { operationSpec, familyOperations } from "./operations/registry.ts";
import { providerOperation } from "./provider-manifest.ts";
import { argumentsDigest, type ActionIntent, type ApprovalBasis } from "./actions.ts";
import { createPreflightRequester } from "./client.ts";
import { HighLevelEscalation } from "./escalation-state.ts";
import type { Escalation } from "./escalation.ts";
import { prepareWorkspaceUpload, type PreparedUpload } from "./uploads.ts";
import type { OperationSpec, MutationSpec, ReadSpec, RequestDraft } from './operations/registry.ts';
import { HeldRequest, sendFrozen, sendFrozenRead } from './held-request.ts';
import { isHighLevelHelperName, isHighLevelToolName } from "../../shared/highlevel.ts";
import { markTurnEmailDerived } from "../email/external-marks.ts";
import type { InternalCapability } from "../internal-capabilities.ts";
import { authorizeHighLevelCall, nativeAccessFor, visibleHighLevelTools, type HighLevelAccessBot, type HighLevelDecision } from "./access.ts";
import { ActionRefused, reviewDigestFor, type ActionContext, type ActionReview, type HighLevelActions } from "./actions.ts";
import { UserCreateIdentityClaims, userCreateInventoryClear, type UserCreateClaim } from './users-create-identity.ts';
import { usersCreateRecipientVerified, USER_CREATE_HANDOFF, USER_CREATE_OPEN, USER_CREATE_URL } from './users-create-policy.ts';
import { HighLevelError, HighLevelStopped, PAGE_MAX, type HighLevelCallContext, type HighLevelClient, type HighLevelLeaseSource } from "./client.ts";
import {
  advertisedTool,
  checkToolArguments,
  fenceHighLevelText,
  highlevelCrmResult,
  highlevelErrorResult,
  highlevelOk,
  highlevelToolDefinition,
  type HighLevelToolResult,
  type HighLevelWriteRecord,
} from "./tools.ts";

// The preflight snapshot belongs to the exact held request; it is never derived
// from the write response or mutable replay arguments.
const recoveryPlans = new WeakMap<HeldRequest, WriteRecoveryPlan>();
const userCreateClaims = new WeakMap<HeldRequest, UserCreateClaim>();

/** Section 3: only an owner No limits lane supplies a policy basis. Unknown facts card. */
export function highlevelDenyRuleMatches(tool: string, operation: string, risk: Risk, rules: readonly string[] = [], send = false): boolean {
  return rules.some(rule => ((rule === 'HIGHLEVEL:SEND' || rule === 'HIGHLEVEL:S') && send) || rule === tool || rule === operation || rule === `HIGHLEVEL:${operation}` || rule === `HIGHLEVEL:${risk}`);
}
export function highlevelApprovalBasis(facts: { risk: Risk; noLimits?: boolean; attended?: boolean; tool?: string; operation?: string; denyRules?: readonly string[]; send?: boolean }): ApprovalBasis {
  // The caller supplies authenticated turn policy. Saved permission denies
  // never narrow an eligible No limits turn; capability availability is separate.
  const basis: ApprovalBasis = facts.noLimits !== true ? "owner_exact_review"
    : facts.risk === "D" ? "owner_no_limits_attended" : "owner_no_limits";
  return finalDecision([], facts.tool ?? 'HighLevel', {kind:'base',verdict:basis});
}

export function highlevelAttended(startedAt: number | undefined, desktopConnected: boolean, now = Date.now()): boolean {
  return desktopConnected && startedAt !== undefined && now >= startedAt && now - startedAt <= 15 * 60_000;
}

export interface HighLevelOutcomeRecord {
  actionId: string; operation: OperationId; risk: Risk; basis: string;
  outcome: "applied" | "not_applied" | "outcome_unknown" | "stale" | "read_done" | "read_withheld";
  status?: number; /** IDs named in the approved review. */ recordIds: string[];
  /** Validated IDs actually returned by the provider; never inferred from approval. */ approvedRecordIds?: string[]; providerRecordIds?: string[]; fields: string[];
}

interface PreparedContactWrite {
  binding: Omit<RpcApprovalBinding, 'rpcId' | 'rpcDigest'>;
  dispatch(): Promise<ApprovalOutcome>;
  status(): number | undefined;
  reconcile(binding: RpcApprovalBinding): Promise<ApprovalOutcome>;
}
type CaptureContactWrite = (prepared: PreparedContactWrite) => void;

type Authorized = Extract<HighLevelDecision, { ok: true }>;
const covers = (level: unknown, risk: Risk) => level === "full" || (level === "change" && risk !== "D") || (level === "read" && risk === "R");

// Extension specs retain the generic durable recovery adapter. The shared send
// boundary and journal are identical for native families and extension specs.
const nativeRecovery = (spec: OperationSpec) => spec.risk !== 'R' && spec.prepare === (operationSpec(spec.id) as MutationSpec | undefined)?.prepare;
const TURN_LIMIT = 4_096;

/** One abort signal per turn generation, fired by Stop. */
export class HighLevelTurnSignals {
  readonly #turns = new Map<string, { threadId: string; botId: string; controller: AbortController }>();
  /** Generations already ended: a late call for one gets an aborted signal, never a fresh one. */
  readonly #ended = new Set<string>();
  readonly #endListeners = new Set<(threadId: string, generation: string) => void>();
  onEnd(listener: (threadId: string, generation: string) => void): void { this.#endListeners.add(listener); }

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
    const turn = this.#turns.get(generation);
    turn?.controller.abort();
    if (turn) for (const listener of this.#endListeners) listener(turn.threadId, generation);
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
  /** Trusted direct-owner desktop provenance, independent of native password UI. */
  userCreateOwner?: (claim: InternalCapability) => boolean;
  userCreateClaims?: UserCreateIdentityClaims;
  /** Durable F0.2 journals. Missing storage holds contact writes. */
  approvalJournal?: RpcApprovalJournal;
  callJournal?: ApprovalJournal;
  /** Test/family extension seam uses the frozen operation contract. */
  operationSpec?: (id: string) => OperationSpec | undefined;
  familyOperations?: (family: Family) => readonly OperationSpec[];
  /** Integration dependency: C1 supplies checked token scopes until connection metadata carries them. */
  operationScopes?: (connectionId: string) => readonly string[] | undefined;
  workspaceRoot?: (claim: InternalCapability) => string | undefined;
  ownerDenyRule?: (claim: InternalCapability, spec: OperationSpec, risk: Risk) => boolean;
  capabilities: { isActive(claim: InternalCapability): boolean };
  signals: HighLevelTurnSignals;
  bot(botId: string): HighLevelAccessBot | undefined;
  leases: HighLevelLeaseSource;
  client: HighLevelClient;
  actions: HighLevelActions;
  /** A change is waiting for the owner (the card and notification attach here later). */
  onReview?: (claim: InternalCapability, review: ActionReview & { title?: string; catastrophe?: boolean }) => void;
  /** The review ended (decided, Stop, expiry or a refusal): its card closes and can approve nothing. */
  onReviewClosed?: (actionId: string) => void;
  /** A change ran: ids and field names only. */
  onReceipt?: (claim: InternalCapability, receipt: HighLevelWriteRecord & { actionId: string; connectionId: string }) => void;
}

type PrepareOpportunity = (intent: ActionIntent, held: HeldRequest, dispatch: () => Promise<ApprovalOutcome>) => Promise<HighLevelToolResult>;

type JsonRpc = { jsonrpc?: string; id?: unknown; method?: unknown; params?: unknown };
type JsonRpcResponse = { jsonrpc: "2.0"; id: unknown; result?: unknown; error?: { code: number; message: string } };

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const STOPPED_TEXT = "Stopped. Nothing more was sent to the CRM.";
export class HighLevelHost {
  readonly #deps: HighLevelHostDeps;
  readonly #escalation = new HighLevelEscalation();
  readonly #pendingReviews = new Map<string, { botId: string; recheck: () => Promise<void> }>();

  /** Settings changes must reach the native action queue as well as engine approvals. */
  async onLevelChange(botId: string): Promise<void> {
    for (const pending of this.#pendingReviews.values()) {
      if (pending.botId === botId) await pending.recheck();
    }
  }
  /** C1 owns runtime construction. Install C2 callbacks without changing its grant/mount code. */
  configureReview(hooks: Pick<HighLevelHostDeps, "onReview" | "onReviewClosed" | "approvalBasis" | "onOutcome" | "ownerDenyRule" | "workspaceRoot">): void { Object.assign(this.#deps, hooks); }
  #basis(claim: InternalCapability, spec: OperationSpec, risk: Risk): ApprovalBasis {
    if (serviceNoLimits(claim.generation, claim.threadId, claim.botId)) {
      const tool=HIGHLEVEL_FAMILY_TOOLS[spec.family];
      return highlevelApprovalBasis({risk,noLimits:true,tool,operation:spec.id,denyRules:this.#denyMatched(claim,spec,risk)?[tool]:[]});
    }
    if (spec.id === 'users.create') return 'owner_exact_review';
    try {
      if (this.#denyMatched(claim, spec, risk)) return "owner_exact_review";
      const basis = this.#deps.approvalBasis?.(claim, spec, risk);
      return basis === "owner_no_limits_attended" || (basis === "owner_no_limits" && risk !== "D") ? basis : "owner_exact_review";
    }
    catch { return "owner_exact_review"; }
  }
  constructor(deps: HighLevelHostDeps) {
    this.#deps = deps;
    deps.signals.onEnd((threadId, generation) => { this.#escalation.drop(`${threadId}\0${generation}`); });
  }

  /** Provider error text is released under the same authority check as a successful body. */
  #errorText(claim: InternalCapability, error: HighLevelError): string {
    const detail = error.providerDetail;
    if (!detail) return error.message;
    markTurnEmailDerived(claim.threadId);
    return error.message.endsWith(detail) ? `${error.message.slice(0, error.message.length - detail.length)}${fenceHighLevelText(detail)}` : fenceHighLevelText(error.message);
  }

  /** Why this claim may not use HighLevel at all right now, or null. */
  #claimRefusal(claim: InternalCapability): string | null {
    if (claim.kind !== "highlevel") return "This capability cannot reach HighLevel.";
    if (!this.#deps.capabilities.isActive(claim)) return "This turn has ended.";
    if (claim.notOwnerAudience) return "HighLevel runs only in the owner's own conversations, not where others are speaking.";
    const bot = this.#deps.bot(claim.botId);
    if (!bot || inertBot(bot)) return "This bot is not available.";
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
      const bot = this.#deps.bot(claim.botId);
      const tools: unknown[] = [];
      for (const family of HIGHLEVEL_FAMILIES) {
        const specs = ((this.#deps.familyOperations ?? familyOperations)(family) as unknown as readonly OperationSpec[]).filter(spec => this.#operationGrant(claim, bot, spec, spec.risk));
        if (!specs.length) continue;
        tools.push({ name: HIGHLEVEL_FAMILY_TOOLS[family], description: `Manage HighLevel ${family}. Changes are handled by Murage.`,
          inputSchema: { type: "object", additionalProperties: false, required: ["operation", "args"], properties: {
            operation: { type: "string", enum: specs.map(spec => spec.id) }, connectionId: { type: "string" }, args: { type: "object" },
          }, oneOf: specs.map(spec => ({ properties: { operation: { const: spec.id }, args: z.toJSONSchema(spec.args, { io: "output", unrepresentable: "any" }) } })) } });
      }
      const names = visibleHighLevelTools(bot).filter(isHighLevelHelperName);
      if (tools.length && !names.length) names.push("HIGHLEVEL_LIST_CONNECTIONS", "HIGHLEVEL_ACTION_STATUS");
      return { jsonrpc: "2.0", id, result: { tools: [...tools, ...names.map(name => advertisedTool(highlevelToolDefinition(name)!))] } };
    }
    if (request.method !== "tools/call" || !object(request.params)) return { jsonrpc: "2.0", id, error: { code: -32601, message: "Unsupported HighLevel request." } };
    const params = request.params;
    if (!((typeof id === 'string' && id.length > 0 && id.length <= 512) || (typeof id === 'number' && Number.isSafeInteger(id))))
      return { jsonrpc: '2.0', id, error: { code: -32602, message: 'A stable tool-call identity is required.' } };
    if (Object.keys(params).some((key) => !["name", "arguments", "_meta"].includes(key))) return { jsonrpc: "2.0", id, error: { code: -32602, message: "Unsupported request fields." } };
    if (typeof params.name === "string" && LEGACY_TOOL_TO_OPERATION[params.name]) {
      const operation = LEGACY_TOOL_TO_OPERATION[params.name]!;
      const family = operation.split(".")[0] as Family;
      return { jsonrpc: "2.0", id, result: highlevelErrorResult(`This HighLevel tool was renamed. Use ${HIGHLEVEL_FAMILY_TOOLS[family]} with operation ${operation}.`) };
    }
    return { jsonrpc: "2.0", id, result: await this.call(claim, params.name, params.arguments ?? {}, typeof id === "string" || typeof id === "number" ? toolCallActionId(claim, id) : undefined, id) };
  }

  #actionContext(claim: InternalCapability, d: Authorized, basis: ApprovalBasis): ActionContext {
    // Settings revisions cannot stale a live No limits policy approval.
    // Connection identity, epoch and role remain bound; a lower level restores revision checks.
    const noLimits = basis !== "owner_exact_review" && serviceNoLimits(claim.generation, claim.threadId, claim.botId);
    return { botId: claim.botId, threadId: claim.threadId, turnGeneration: claim.generation,
      connectionId: d.grant.accountId, connectionEpoch: d.connection.epoch, locationId: d.connection.locationId, companyId: d.connection.companyId,
      grantRevision: noLimits ? 0 : d.grant.revision, accessRevision: noLimits ? 0 : d.accessRevision, policyRevision: noLimits ? 0 : d.policyRevision, roleBinding: d.roleBinding };
  }

  /** Resolve the durable RPC association before preparing any new approval. */
  async #contactRpc(claim: InternalCapability, id: unknown, name: unknown, input: Record<string, unknown>, spec: OperationSpec): Promise<HighLevelToolResult> {
    const journal = this.#deps.approvalJournal;
    if (!journal || !('getRpc' in journal) || !('bindRpc' in journal)
      || !((typeof id === 'string' && id.length > 0 && id.length <= 512) || (typeof id === 'number' && Number.isSafeInteger(id))))
      return highlevelErrorResult('This change requires a durable tool-call identity. Nothing was sent.');
    const digest = (decision: Authorized) => {
      const context = this.#actionContext(claim, decision, this.#basis(claim, spec, spec.risk));
      return createHash('sha256').update(canonicalBindingJson([
        name, input, decision.grant.accountId, context.grantRevision, decision.connection.epoch,
        decision.connection.locationId, decision.connection.companyId, context.accessRevision,
        context.policyRevision, decision.roleBinding, this.#basis(claim, spec, spec.risk),
      ])).digest('hex');
    };
    let preparationFailure: HighLevelToolResult | undefined;
    try {
      const decision = await this.#authorizeOperation(claim, spec, input, spec.risk);
      if (!decision.ok) return highlevelErrorResult(decision.text);
      const currentRpcDigest = digest(decision);
      const rpcId = `rpc:${createHash('sha256').update(canonicalBindingJson([claim.botId, claim.threadId, claim.generation, id])).digest('hex')}`;
      const rpcJournal = journal as RpcApprovalJournal;
      const parsedArgs = spec.args.safeParse(input.args);
      const policyPayloadMatches = (row: ActionIntent | undefined): boolean => Boolean(row && parsedArgs.success
        && serviceNoLimits(claim.generation, claim.threadId, claim.botId) && row.basis !== 'owner_exact_review'
        && row.botId === claim.botId && row.threadId === claim.threadId && row.turnGeneration === claim.generation
        && row.operation === spec.id && row.argumentsDigest === argumentsDigest(String(name), parsedArgs.data));
      const savedRpc = rpcJournal.getRpc(rpcId);
      const rpcDigest = savedRpc && policyPayloadMatches(this.#deps.actions.get(savedRpc.actionId)) ? savedRpc.rpcDigest : currentRpcDigest;
      // F0.2 stored its outer RPC entries in another directory. A legacy claim
      // without an association must never cause a new approval or be terminalized.
      if (!rpcJournal.getRpc(rpcId)) {
        const legacy = this.#deps.callJournal?.get(rpcId);
        if (legacy) {
          if (legacy.requestDigest !== rpcDigest || legacy.state !== 'applied') return highlevelErrorResult('The original approval could not be recovered.', { outcome: 'outcome_unknown' });
          const current = await this.#stillAuthorized(claim, String(name), input, decision, spec);
          if (typeof current === 'string' || digest(current) !== rpcDigest) return highlevelErrorResult('HighLevel access changed.');
          const result = legacy.result as HighLevelToolResult;
          if (result.structuredContent?.outsideContent) markTurnEmailDerived(claim.threadId);
          return result;
        }
      }
      let prepared: PreparedContactWrite | undefined;
      const authorized = async (binding: RpcApprovalBinding): Promise<boolean> => {
        const row = this.#deps.actions.get(binding.actionId);
        if (!row || binding.operation !== spec.id || row.operation !== spec.id || row.approvalId !== binding.approvalId
          || row.requestDigest !== binding.requestDigest || !['approved', 'dispatching', 'outcome_unknown', 'applied', 'not_applied'].includes(row.phase)) return false;
        const terminal = journal.get(binding.approvalId);
        if (row.phase === 'applied' && terminal?.state !== 'applied') return false;
        if (row.phase === 'not_applied' && (terminal?.state !== 'conflict' || terminal.reason !== 'negative_confirmation')) return false;
        const effective = { ...spec, risk: row.risk } as OperationSpec;
        const current = await this.#stillAuthorized(claim, String(name), input, decision, effective);
        if (typeof current === 'string' || (digest(current) !== rpcDigest && !policyPayloadMatches(row)) || this.#deps.signals.signalFor(claim).aborted) return false;
        const context = this.#actionContext(claim, current, row.basis);
        return binding.authorityDigest === createHash('sha256').update(canonicalBindingJson(context)).digest('hex')
          && reviewDigestFor({ ...row, ...context }) === row.reviewDigest
          && this.#approvalStillHolds(claim, effective, row.risk, row.basis, current.grant.accountId);
      };
      const outcome = await runRpcApprovedWrite(rpcJournal, rpcId, rpcDigest, {
        prepare: async () => {
          const result = await this.#operationCall(claim, 'contacts', input, undefined, value => { prepared = value; });
          if (!prepared) { preparationFailure = result; throw new Error('Preparation refused'); }
          return { ...prepared.binding, rpcId, rpcDigest };
        },
        authorize: authorized,
        dispatch: async () => {
          if (!prepared) throw new Error('No approved request held');
          return prepared.dispatch();
        },
        reconcile: binding => prepared ? prepared.reconcile(binding) : this.#reconcileContact(claim, String(name), input, decision, spec as MutationSpec, binding),
      });
      const binding = rpcJournal.getRpc(rpcId);
      if (!binding) {
        // Authorization can refuse the freshly prepared approval before RPC
        // publication. Preserve unsent Stop/stale semantics on that path too.
        const actionId = prepared?.binding.actionId;
        if (actionId) {
          if (this.#deps.signals.signalFor(claim).aborted) this.#deps.actions.notApplied(actionId, 'stopped_before_send');
          else this.#deps.actions.markStale(actionId, 'authority_changed');
        }
        return highlevelErrorResult('The original approval could not be recovered.', actionId
          ? { actionId, outcome: this.#deps.actions.get(actionId)?.phase } : {});
      }
      const before = this.#deps.actions.get(binding.actionId)?.phase;
      let result: HighLevelToolResult;
      if (!await authorized(binding)) {
        const stopped = this.#deps.signals.signalFor(claim).aborted;
        const row = this.#deps.actions.get(binding.actionId);
        if ((row?.dispatchAttempts ?? 0) > 0) this.#deps.actions.outcomeUnknown(binding.actionId, 'authority_changed_after_send');
        else if (stopped) this.#deps.actions.notApplied(binding.actionId, 'stopped_before_send');
        else this.#deps.actions.markStale(binding.actionId, 'authority_changed');
        result = highlevelErrorResult(stopped ? STOPPED_TEXT : 'The result is withheld because HighLevel access changed.', {
          actionId: binding.actionId, outcome: this.#deps.actions.get(binding.actionId)?.phase, ...(stopped ? { stopped: true } : {}),
        });
      } else result = this.#finishContactOutcome(binding.actionId, binding.authorityDigest, outcome, claim);
      const row = this.#deps.actions.get(binding.actionId), status = prepared?.status();
      if (row && before !== row.phase && ['applied', 'not_applied', 'outcome_unknown', 'stale'].includes(row.phase)) this.#deps.onOutcome?.(claim, {
        actionId: row.actionId, operation: row.operation, risk: row.risk, basis: row.basis,
        outcome: row.phase as HighLevelOutcomeRecord['outcome'], ...(status ? { status } : {}),
        recordIds: [...row.recordRefs], providerRecordIds: row.receipt?.recordId ? [row.receipt.recordId] : [], fields: [...row.fields],
      });
      return result;
    } catch { return preparationFailure ?? highlevelErrorResult('The tool call could not be verified. Nothing more was sent.'); }
  }

  async #reconcileContact(claim: InternalCapability, tool: string, args: Record<string, unknown>, current: Authorized,
    spec: MutationSpec, binding: RpcApprovalBinding, retained?: HeldRequest): Promise<ApprovalOutcome> {
    const row = this.#deps.actions.get(binding.actionId);
    if (!row || !binding.readTargets.length || !this.#deps.approvalJournal) return { status: 'conflict', reason: 'unconfirmed' };
    const { connectionId: _connection, ...directArgs } = args;
    const parsed = spec.args.safeParse(object(args.args) ? args.args : directArgs);
    if (!parsed.success) return { status: 'conflict', reason: 'unconfirmed' };
    const pre = createPreflightRequester(this.#deps.client, this.#context(claim, current, this.#deps.signals.signalFor(claim), tool, args, undefined, spec, 'ownership'), spec, this.#deps.operationSpec, parsed.data);
    let recovered: Awaited<ReturnType<typeof reconcileContactEffect>>;
    try { recovered = await reconcileContactEffect(spec, row, binding, this.#deps.approvalJournal, pre, retained, parsed.data); }
    catch { return { status: 'conflict', reason: 'unconfirmed' }; }
    if ('status' in recovered) return recovered;
    const { held: witness, value } = recovered;
    const checked = bindReturnedIdentities(value, witness.frozen, prepareReturnedIdentitySchema(witness, row.locationId));
    if (checked.status !== 'applied') return { status: 'conflict', reason: checked.status === 'not_applied' ? 'negative_confirmation' : 'identity_conflict' };
    const receipt = { recordId: spec.recordId?.(value, witness.frozen) ?? '', fields: row.fields };
    const projected = spec.project(value, witness.frozen);
    return { status: 'applied', result: { actionId: row.actionId, authorityDigest: binding.authorityDigest, receipt,
      toolResult: highlevelCrmResult({ result: projected }, { actionId: row.actionId, outcome: 'applied' }) } };
  }

  #finishContactOutcome(actionId: string, authorityDigest: string, outcome: ApprovalOutcome, claim: InternalCapability): HighLevelToolResult {
    if (outcome.status === 'conflict') {
      if (outcome.reason === 'negative_confirmation') this.#deps.actions.notApplied(actionId, outcome.reason);
      else this.#deps.actions.outcomeUnknown(actionId, outcome.reason);
      return highlevelErrorResult('The approved change could not be confirmed. Check HighLevel before trying again.', { actionId, outcome: this.#deps.actions.get(actionId)?.phase });
    }
    const result = outcome.result as { actionId: string; authorityDigest: string; receipt: { recordId: string; fields: string[] }; toolResult: HighLevelToolResult };
    if (result.authorityDigest !== authorityDigest) {
      this.#deps.actions.markStale(actionId, 'authority_changed');
      return highlevelErrorResult('The stored approval belongs to a different authority context.', { actionId, outcome: 'stale' });
    }
    if (result.actionId !== actionId) this.#deps.actions.markStale(actionId, 'approval_replayed');
    else {
      if (this.#deps.actions.get(actionId)?.phase === 'approved') this.#deps.actions.outcomeUnknown(actionId, 'reconciled');
      if (this.#deps.actions.get(actionId)?.phase !== 'applied') this.#deps.actions.applied(actionId, result.receipt);
    }
    markTurnEmailDerived(claim.threadId);
    return result.toolResult;
  }

  /** F0.2 contact-family dispatch. The journal claims the approval before the only
   * beginDispatch/send path; both owner review and policy approval arrive here. */
  async #contactWrite(claim: InternalCapability, tool: string, args: Record<string, unknown>, current: Authorized,
    signal: AbortSignal, spec: MutationSpec, held: HeldRequest, actionId: string,
    context: (d: Authorized) => ActionContext, onStatus: (status: number | undefined) => void, capture?: CaptureContactWrite): Promise<HighLevelToolResult> {
    const journal = this.#deps.approvalJournal, intent = this.#deps.actions.get(actionId);
    if (!journal || !intent?.approvalId || intent.phase !== 'approved' || intent.operation !== spec.id
      || intent.requestDigest !== held.frozen.requestDigest || reviewDigestFor({ ...intent, ...context(current) }) !== intent.reviewDigest)
      { this.#deps.actions.markStale(actionId, 'authority_changed'); throw new ActionRefused('stale', 'The durable approval could not be verified. Nothing was sent.'); }
    const authorized = async () => {
      const release = await this.#stillAuthorized(claim, tool, args, current, spec);
      const row = this.#deps.actions.get(actionId);
      return typeof release !== 'string' && !signal.aborted && !!row && ['approved', 'dispatching', 'outcome_unknown', 'applied', 'not_applied'].includes(row.phase)
        && row.approvalId === intent.approvalId && row.reviewDigest === intent.reviewDigest
        && reviewDigestFor({ ...row, ...context(release) }) === intent.reviewDigest
        && this.#approvalStillHolds(claim, spec, spec.risk, intent.basis, current.grant.accountId);
    };
    const authorityDigest = createHash('sha256').update(canonicalBindingJson(context(current))).digest('hex');
    saveContactRecovery(journal, intent.approvalId, held, authorityDigest);
    const binding = { approvalId: intent.approvalId, requestDigest: intent.requestDigest, actionId, authorityDigest,
      operation: spec.id, ...contactRecoveryPlan(spec, held) };
    let providerStatus: number | undefined;
    const dispatch = async (): Promise<ApprovalOutcome> => {
        let received = false;
        try {
          const dispatch = this.#deps.actions.beginDispatch(actionId, context(current));
          prepareReturnedIdentitySchema(dispatch.held, current.connection.locationId);
          const ctx = this.#context(claim, current, signal, tool, args, async attempt => {
            if (!await authorized()) { if (!signal.aborted) this.#deps.actions.markStale(actionId, 'authority_changed'); throw new HighLevelStopped(); }
            const now = await this.#stillAuthorized(claim, tool, args, current, spec);
            if (typeof now === 'string') throw new HighLevelStopped();
            this.#deps.actions.recordAttempt(actionId, attempt, context(now));
          }, spec);
          requestChanged.set(ctx, () => this.#deps.actions.markStale(actionId, 'request_changed'));
          const result = await this.#dispatchWrite(spec, ctx, dispatch.held, dispatch.intent, authorized, authorityDigest);
          received = true;
          return result;
        } catch (error) {
          if (error instanceof HighLevelError) { providerStatus = error.status; onStatus(error.status); }
          if (!await authorized()) return { status: 'conflict', reason: 'authority_changed' };
          return { status: 'conflict', reason: !received && error instanceof HighLevelError && error.outcome === 'not_applied' ? 'negative_confirmation' : 'unconfirmed' };
        }
      };
    if (capture) { capture({ binding, dispatch, status: () => providerStatus, reconcile: saved => this.#reconcileContact(claim, tool, args, current, spec, saved, held) }); return highlevelOk('Approved request prepared.'); }
    const outcome = await runApprovedInvocation(journal, intent.approvalId, intent.requestDigest, async () => {
      if (!await authorized()) return { status: 'conflict', reason: 'authority_changed' };
      return runApprovedWrite(journal, intent.approvalId!, intent.requestDigest, {
        dispatch,
        reconcile: () => this.#reconcileContact(claim, tool, args, current, spec, { ...binding, rpcId: 'direct', rpcDigest: authorityDigest }, held),
      });
    });
    // Terminal persistence precedes action settlement and result publication.
    if (!await authorized()) {
      if ((this.#deps.actions.get(actionId)?.dispatchAttempts ?? 0) === 0) {
        if (signal.aborted) this.#deps.actions.notApplied(actionId, 'stopped_before_send');
        else this.#deps.actions.markStale(actionId, 'authority_changed');
      } else this.#deps.actions.outcomeUnknown(actionId, 'authority_changed_after_send');
      return highlevelErrorResult(signal.aborted ? STOPPED_TEXT : 'The result is withheld because HighLevel access changed.', { actionId, outcome: this.#deps.actions.get(actionId)?.phase, ...(signal.aborted ? { stopped: true } : {}) });
    }
    return this.#finishContactOutcome(actionId, authorityDigest, outcome, claim);
  }

  /** One tool call. Always answers with a tool result; a refusal is an error result in words. */
  async call(claim: InternalCapability, name: unknown, args: unknown, replayActionId?: string, rpcIdentity?: unknown): Promise<HighLevelToolResult> {
    const refusal = this.#claimRefusal(claim);
    if (refusal) return highlevelErrorResult(refusal);
    if (this.#deps.bot(claim.botId)?.composio === false) return highlevelErrorResult(CONNECTED_APPS_OFF);
    const family = HIGHLEVEL_FAMILIES.find(f => HIGHLEVEL_FAMILY_TOOLS[f] === name);
    if (family) {
      const spec = object(args) && typeof args.operation === 'string' ? (this.#deps.operationSpec ?? operationSpec)(args.operation) : undefined;
      // The hlc2 durable action identity predates the family RPC indices. Never
      // create a new approval when that identity is already recorded.
      try {
        if (spec?.risk !== 'R' && replayActionId && (this.#deps.actions.get(replayActionId) || this.#deps.approvalJournal?.get(replayActionId)))
          return this.#operationCall(claim, family, args, replayActionId);
      } catch { return highlevelErrorResult('The approval journal could not be read. Nothing was sent.'); }
      if (spec?.family === family && family === 'contacts' && nativeRecovery(spec) && spec.risk !== 'R' && rpcIdentity !== undefined) return this.#contactRpc(claim, rpcIdentity, name, args as Record<string, unknown>, spec);
      if (spec?.family === family && family === 'opportunities' && nativeRecovery(spec) && spec.risk !== 'R') return this.#opportunityRpc(claim, spec, args as Record<string, unknown>, rpcIdentity === undefined ? replayActionId : JSON.stringify([typeof rpcIdentity, rpcIdentity]));
      return this.#operationCall(claim, family, args, replayActionId);
    }
    const problem = checkToolArguments(name, args);
    if (problem) return highlevelErrorResult(problem);
    const a = args as Record<string, unknown>;
    if (isHighLevelHelperName(name)) return this.#helper(claim, name, a);
    if (!isHighLevelToolName(name)) return highlevelErrorResult("Unknown HighLevel tool.");
    const decision = await this.#authorize(claim, name, a);
    if (!decision.ok) return highlevelErrorResult(decision.text, { code: decision.code });
    const signal = this.#deps.signals.signalFor(claim);
    if (signal.aborted) return highlevelErrorResult(STOPPED_TEXT, { stopped: true });
    return highlevelErrorResult("Use the HighLevel family tool and operation name.");
  }

  #grantsFor(bot: HighLevelAccessBot, claim: InternalCapability): Authorized["grant"][] {
    return nativeAccessFor(bot, serviceNoLimits(claim.generation, claim.threadId, claim.botId))?.grants ?? [];
  }

  /** The same validated effective authority is used by Settings, mounts and dispatch. */
  #operationGrant(claim: InternalCapability, bot: HighLevelAccessBot | undefined, spec: OperationSpec, risk: Risk, connectionId?: string): Authorized["grant"] | undefined {
    if (!bot || bot.hidden || bot.composio === false) return;
    const noLimits = serviceNoLimits(claim.generation, claim.threadId, claim.botId);
    const access = nativeAccessFor(bot, noLimits);
    if (!access) return;
    const policy = botAccessPolicy(bot);
    if (risk !== "R" && (bot.draftOnly || (!noLimits && policy.mode === "restricted" && !policy.allowWrites))) return;
    const grants = access.grants.filter(grant =>
      (connectionId === undefined || grant.accountId === connectionId)
      && (noLimits ? grant.families[spec.family] !== "off" :
        (risk === "R" || grant.ceiling === "propose")
        && covers(grant.families[spec.family], risk)
        && (grant.operations[spec.family] === undefined || grant.operations[spec.family]!.includes(spec.id))));
    return grants.length === 1 ? grants[0] : undefined;
  }

  #operationOffLine(claim: InternalCapability, family: Family): string {
    return this.#deps.bot(claim.botId)?.composio === false
      ? 'HighLevel is off for this bot. Turn on Connected apps in Bot settings.'
      : `HighLevel ${family} is off for this bot. Turn it on in Bot settings → Apps → HighLevel.`;
  }

  async #authorizeOperation(claim: InternalCapability, spec: OperationSpec, args: Record<string, unknown>, risk: Risk): Promise<HighLevelDecision> {
    const fail = (text: string): HighLevelDecision => ({ ok: false, code: "not_granted", text });
    const connectionId = typeof args.connectionId === "string" ? args.connectionId : undefined;
    const initial = this.#operationGrant(claim, this.#deps.bot(claim.botId), spec, risk, connectionId);
    if (!initial) return fail(serviceNoLimits(claim.generation, claim.threadId, claim.botId)
      ? this.#operationOffLine(claim, spec.family) : "The owner has not given this bot this HighLevel operation at the required level.");
    const connection = await this.#deps.leases.connection(initial.accountId);
    const bot = this.#deps.bot(claim.botId);
    const grant = this.#operationGrant(claim, bot, spec, risk, connectionId);
    if (!grant || grant.accountId !== initial.accountId || this.#claimRefusal(claim)) return fail("The bot's HighLevel access changed first.");
    if (!connection || connection.connectionId !== grant.accountId || !["connected", "degraded"].includes(connection.state)) return fail(serviceNoLimits(claim.generation, claim.threadId, claim.botId)
      ? 'HighLevel is off because this account is disconnected. Turn it on in Settings → Apps → HighLevel.' : "This HighLevel location needs reconnecting.");
    // Integration dependency: C1 publishes verified token scopes on connection.scopes or through operationScopes.
    // Unknown scopes never imply permission and never cause a credential request.
    const scopes = this.#deps.operationScopes?.(connection.connectionId) ?? (connection as typeof connection & { scopes?: readonly string[] }).scopes;
    if (!scopes?.includes(spec.endpoint.scope)) return fail(`HighLevel needs the ${spec.endpoint.scope} permission for this. The owner can add it in HighLevel and check the token again.`);
    const access = bot!.highlevelAccess as { revision: number };
    return { ok: true, grant, connection, write: risk !== "R", accessRevision: access.revision, policyRevision: botAccessPolicy(bot!).revision, roleBinding: accessRoleBinding(bot!) };
  }

  async #operationCall(claim: InternalCapability, family: Family, input: unknown, replayActionId?: string, capture?: CaptureContactWrite, prepareOpportunity?: PrepareOpportunity): Promise<HighLevelToolResult> {
    if (!object(input) || Object.keys(input).some(key => !["operation", "connectionId", "args"].includes(key)) || typeof input.operation !== "string"
      || (input.connectionId !== undefined && (typeof input.connectionId !== "string" || !/^[A-Za-z0-9_.~%-]+$/.test(input.connectionId)))) return highlevelErrorResult("Use operation, connectionId and args only.");
    const spec = (this.#deps.operationSpec ?? operationSpec)(input.operation) as unknown as OperationSpec | undefined;
    const manifest = providerOperation(input.operation);
    if (!spec || spec.family !== family || (!manifest && !operationExtension(spec.row)) || (manifest && manifest.status !== "qualified")) return highlevelErrorResult("This HighLevel operation is not available to this location.");
    if (!spec.row || 'run' in spec || (spec.risk === 'R' ? typeof spec.prepareRead !== 'function' || !Number.isSafeInteger(spec.maxReads) || spec.maxReads < 1 || spec.maxReads > 5 : typeof spec.prepare !== 'function' || (spec.gate === 'GDp' && !spec.recheck)) || typeof spec.nested !== 'boolean' || !Array.isArray(spec.preflight) || spec.endpoint.retry !== (spec.risk === 'R' ? 'read' : 'write'))
      return highlevelErrorResult('This operation has no verified dispatch contract.');
    const parsed = spec.args.safeParse(input.args);
    if (!parsed.success) return highlevelErrorResult("The HighLevel arguments do not match this operation's schema.");
    const args = { ...parsed.data, ...(input.connectionId !== undefined ? { connectionId: input.connectionId } : {}) };
    const signal = this.#deps.signals.signalFor(claim);
    if (signal.aborted) return highlevelErrorResult(STOPPED_TEXT);
    if (spec.risk !== 'R') {
      if (!this.#deps.approvalJournal) return highlevelErrorResult('The approval journal is unavailable. Nothing was sent.');
      if (replayActionId) {
        const row = this.#deps.actions.get(replayActionId);
        if (row) return this.#replayWrite(claim, spec, args, row);
        // Approval records outlive action cleanup. Missing release context never revives a send.
        try { if (this.#deps.approvalJournal.get(replayActionId)) return highlevelErrorResult('The stored approval no longer has release context.', { outcome: 'outcome_unknown' }); }
        catch { return highlevelErrorResult('The approval journal could not be read. Nothing was sent.'); }
      }
    }
    if(serviceNoLimits(claim.generation,claim.threadId,claim.botId)&&this.#denyMatched(claim,spec,spec.risk)) {
      try{this.#basis(claim,spec,spec.risk);}catch(error){if(error instanceof ActionRefused)return highlevelErrorResult(error.message,{code:error.code});throw error;}
    }
    let reserved: { risk: Risk; escalation: Escalation };
    try { reserved = this.#escalation.reserve(`${claim.threadId}\0${claim.generation}`, spec, parsed.data, Date.now(), this.#basis(claim, spec, spec.risk) !== "owner_exact_review"); }
    catch (error) { if (error instanceof ActionRefused) return highlevelErrorResult(error.message, { code: error.code }); throw error; }
    if (spec.risk !== 'R' && spec.gate === 'GDp' && spec.precondition !== 'provider') reserved.risk = 'D';
    const effective = { ...spec, risk: reserved.risk } as OperationSpec;
    const denied = this.#denyMatched(claim, effective, reserved.risk);
    // Reservation, deny matching, effective grant and basis have no asynchronous boundary.
    const grant = this.#operationGrant(claim, this.#deps.bot(claim.botId), effective, reserved.risk, input.connectionId as string | undefined);
    if (!grant && serviceNoLimits(claim.generation, claim.threadId, claim.botId)) return highlevelErrorResult(this.#operationOffLine(claim, family));
    if (!grant) return highlevelErrorResult(reserved.risk === 'D' && spec.risk !== 'D'
      ? `This is now a bulk change. The owner can give this bot Full control for ${family}.`
      : 'The owner has not given this bot this HighLevel operation at the required level.');
    this.#basis(claim, effective, reserved.risk);
    if (spec.nested && !spec.ownership) return highlevelErrorResult('This operation requires an ownership check.');
    const decision = await this.#authorizeOperation(claim, effective, args, reserved.risk);
    if (!decision.ok) return highlevelErrorResult(decision.text);
    if (spec.id === 'users.create' && !usersCreateRecipientVerified())
      return highlevelErrorResult(`${USER_CREATE_HANDOFF} [${USER_CREATE_OPEN}](${USER_CREATE_URL})`);
    if (spec.id === 'users.create' && !this.#userCreateOwner(claim))
      return highlevelErrorResult('Only you can add users, from the desktop app.');
    let prepared: PreparedUpload | undefined;
    let draft: RequestDraft;
    let identityClaim: UserCreateClaim | undefined, dispatchBarrier = false, reviewStarted = false;
    const createActionId = spec.id === 'users.create' ? replayActionId ?? `hla_${randomUUID()}` : undefined;
    try {
      if (spec.id === 'users.create') {
        if (parsed.data.companyId !== decision.connection.companyId || parsed.data.type !== 'account'
          || !Array.isArray(parsed.data.locationIds) || parsed.data.locationIds.length !== 1 || parsed.data.locationIds[0] !== decision.connection.locationId)
          throw new ActionRefused('request_shape', 'User changes must stay in this location.');
        if (!this.#deps.userCreateClaims) throw new ActionRefused('unrecorded', 'We could not save this request safely. Nothing was sent.');
        identityClaim = this.#deps.userCreateClaims.acquire(decision.connection.companyId, String(parsed.data.email), createActionId!);
        if (!identityClaim) {
          // A new action or RPC cannot obtain a second dispatch owner. Its only
          // provider work is one scoped lookup; an empty list never permits send.
          const pre = createPreflightRequester(this.#deps.client,
            this.#context(claim, decision, signal, HIGHLEVEL_FAMILY_TOOLS[family], args, undefined, effective, 'ownership'), spec, this.#deps.operationSpec);
          try { await readReconciliation(pre, 'users.list', { path: '/users/', query: { locationId: decision.connection.locationId } }); } catch { /* unresolved */ }
          return highlevelErrorResult('We could not confirm whether the user was added.', { outcome: 'outcome_unknown' });
        }
      }
      const ctx = this.#context(claim, decision, signal, HIGHLEVEL_FAMILY_TOOLS[family], args, undefined, effective, 'ownership');
      const bulkPre = spec.id === 'contacts.tags.bulk' ? createPreflightRequester(this.#deps.client, ctx, spec, this.#deps.operationSpec, parsed.data) : undefined;
      await spec.ownership?.(bulkPre ?? createPreflightRequester(this.#deps.client, ctx, spec, this.#deps.operationSpec), parsed.data, { locationId: decision.connection.locationId, companyId: decision.connection.companyId });
      const refs: { workspaceFile: string }[] = [];
      const find = (value: unknown): void => {
        if (Array.isArray(value)) { value.forEach(find); return; }
        if (!object(value)) return;
        if (typeof value.workspaceFile === 'string') refs.push({ workspaceFile: value.workspaceFile });
        else Object.values(value).forEach(find);
      };
      find(parsed.data);
      if (refs.length) {
        const root = this.#deps.workspaceRoot?.(claim);
        if (!root || refs.length !== 1) throw new ActionRefused('stale', 'Choose one file in this bot’s workspace.');
        prepared = prepareWorkspaceUpload(root, refs[0]!);
      }
      const runContext = { locationId: decision.connection.locationId, companyId: decision.connection.companyId, scope: claim, authorityBinding: JSON.stringify([decision.connection.connectionId, decision.connection.epoch, decision.grant.revision, decision.accessRevision]), ...(prepared ? { prepared } : {}) };
      draft = spec.risk === 'R' ? await spec.prepareRead(parsed.data, runContext) : await spec.prepare(bulkPre ?? createPreflightRequester(this.#deps.client, ctx, spec, this.#deps.operationSpec), parsed.data, runContext);
      const held = HeldRequest.freeze(spec, draft, runContext);
      if (identityClaim) userCreateClaims.set(held, {
        barrier: () => { identityClaim!.barrier(); dispatchBarrier = true; },
        releaseUnsent: () => identityClaim!.releaseUnsent(),
      });
      if (spec.risk !== 'R' && !nativeRecovery(spec) && HIGHLEVEL_RETURNED_CONFIRMATION_SCHEMAS[spec.id]?.kind === 'tag_post_state') {
        const path = held.frozen.path.replace(/\/tags$/, '');
        const contactId = decodeURIComponent(path.split('/')[2]!);
        const value = await createPreflightRequester(this.#deps.client, ctx, spec, this.#deps.operationSpec).read('contacts.get', { path });
        const contact = object(value) && object(value.contact) ? value.contact : undefined;
        if (!contact || contact.id !== contactId || !validTagSet(contact.tags)
          || [value, contact].some(record => object(record) && (
            ['id', 'contactId'].some(key => Object.hasOwn(record, key) && record[key] !== contactId)
            || (Object.hasOwn(record, 'locationId') && record.locationId !== runContext.locationId))))
          throw new ActionRefused('request_shape', 'The contact tag state could not be verified. Nothing was sent.');
        prepareTagReturnedIdentitySchema(held, runContext.locationId, contact.tags);
      }
      if (nativeRecovery(spec)) prepareContactConfirmation(held, draft, runContext.locationId);
      if (spec.family === 'contacts' && nativeRecovery(spec) && spec.risk !== 'R')
        await prepareContactRecovery(spec, held, bulkPre ?? createPreflightRequester(this.#deps.client, ctx, spec, this.#deps.operationSpec), runContext.locationId);
      if (spec.risk !== 'R' && (!nativeRecovery(spec) || (spec.family !== 'contacts' && spec.family !== 'opportunities'))) {
        const plan = prepareWriteRecovery(held, runContext.locationId);
        const pre = createPreflightRequester(this.#deps.client, ctx, { preflight: operationExtension(spec.row)?.reconciliation ?? reconciliationReadsFor(spec.id) }, this.#deps.operationSpec);
        let inventory: unknown;
        if (spec.id === 'users.create') {
          inventory = await readReconciliation(pre, 'users.list', { path: '/users/', query: { locationId: runContext.locationId } });
          if (!userCreateInventoryClear(inventory, String(parsed.data.email), runContext.locationId))
            throw new ActionRefused('stale', 'We could not check the users in this location. Nothing was sent.');
        }
        await captureRecoveryPreState(plan, pre, inventory);
        recoveryPlans.set(held, plan);
      }
      if (spec.family === 'opportunities' && nativeRecovery(spec) && spec.risk !== 'R') await prepareOpportunityRecovery(held, runContext.locationId, createPreflightRequester(this.#deps.client, ctx, spec, this.#deps.operationSpec));
      if ((replayActionId || createActionId) && spec.risk !== 'R') heldToolCallActions.set(held, (replayActionId ?? createActionId)!);
      if (spec.risk === 'R' && !denied) return await this.#read(claim, HIGHLEVEL_FAMILY_TOOLS[family], args, decision, signal, spec, draft);
      reviewStarted = true;
      return await this.#reviewedRequest(claim, HIGHLEVEL_FAMILY_TOOLS[family], args, decision, signal, effective, reserved.escalation, held, capture, prepareOpportunity);
    } catch (error) {
      if (dispatchBarrier) return highlevelErrorResult('We could not confirm whether the user was added.', { outcome: 'outcome_unknown' });
      // Reviewed dispatch owns its error/recovery boundary. A failed durable
      // settlement after a send must not become a preflight "Nothing was sent".
      if (reviewStarted) throw error;
      return highlevelErrorResult(error instanceof InvoiceReviewRefused ? error.message : error instanceof Error && error.message === "Murage's file helper is missing. Reinstall Murage." ? error.message : 'The ownership check, workspace file or prepared request could not be verified. Nothing was sent.');
    }
    finally { if (identityClaim && !dispatchBarrier) { try { identityClaim.releaseUnsent(); } catch { /* uncertain claims remain held */ } } }
  }

  #userCreateOwner(claim: InternalCapability): boolean {
    try { return (serviceNoLimits(claim.generation, claim.threadId, claim.botId) || this.#deps.userCreateOwner?.(claim) === true) && !this.#claimRefusal(claim); } catch { return false; }
  }

  #denyMatched(claim: InternalCapability, spec: OperationSpec, risk: Risk): boolean {
    if (serviceNoLimits(claim.generation, claim.threadId, claim.botId)) return false;
    try {
      const bot = this.#deps.bot(claim.botId);
      const rules = bot ? nativeAccessFor(bot)?.denyRules ?? [] : [];
      return highlevelDenyRuleMatches(HIGHLEVEL_FAMILY_TOOLS[spec.family], spec.id, risk, rules, spec.risk !== 'R' && spec.send) || this.#deps.ownerDenyRule?.(claim, spec, risk) === true;
    } catch { return true; }
  }

  #authorize(claim: InternalCapability, tool: string, args: Record<string, unknown>): Promise<HighLevelDecision> {
    return authorizeHighLevelCall({
      bot: () => this.#deps.bot(claim.botId), tool,
      connectionId: typeof args.connectionId === "string" ? args.connectionId : undefined,
      connection: (connectionId) => this.#deps.leases.connection(connectionId),
    });
  }

  #context(claim: InternalCapability, decision: Extract<HighLevelDecision, { ok: true }>, signal: AbortSignal, tool: string, args: Record<string, unknown>,
    onDispatch?: (attempt: number) => Promise<void>, spec?: OperationSpec, purpose: 'execution' | 'ownership' = 'execution'): HighLevelCallContext {
    const ctx: HighLevelCallContext = {
      connection: decision.connection,
      signal,
      assertActive: () => { if (signal.aborted || !this.#deps.capabilities.isActive(claim)) throw new HighLevelStopped(); },
      ...(onDispatch ? { onDispatch } : {}),
      // Every read, retries and the reads a change makes (custom field definitions) included, is authorized again
      // right before it leaves, after any rate or lease wait.
      beforeRead: async () => {
        const now = await this.#stillAuthorized(claim, tool, args, decision, spec);
        if (now === STOPPED_TEXT) throw new HighLevelStopped();
        if (typeof now === "string") throw new HighLevelError(now, { status: 403 });
        // Ownership uses only the declared, bounded preflight requester. Its parent lookup must
        // finish before review; execution still requires approval when a deny rule matches.
        if (purpose === 'execution' && spec?.risk === 'R' && !onDispatch && this.#denyMatched(claim, spec, 'R')) throw new HighLevelError('This read now needs the owner’s exact review.', { status: 403 });
      },
    };
    noLimitsForContext.set(ctx, () => serviceNoLimits(claim.generation, claim.threadId, claim.botId));
    return ctx;
  }

  #approvalStillHolds(claim: InternalCapability, spec: OperationSpec, risk: Risk, basis: ApprovalBasis, connectionId: string): boolean {
    try {
      if (spec.id === 'users.create' && !this.#userCreateOwner(claim)) return false;
      if (this.#claimRefusal(claim) || !this.#operationGrant(claim, this.#deps.bot(claim.botId), spec, risk, connectionId)) return false;
      return basis === 'owner_exact_review' || (!this.#denyMatched(claim, spec, risk) && this.#basis(claim, spec, risk) === basis);
    } catch { return false; }
  }

  /** The same authority as when the call started, checked again now (result release, dispatch). */
  async #stillAuthorized(claim: InternalCapability, tool: string, args: Record<string, unknown>, before: Extract<HighLevelDecision, { ok: true }>, spec?: OperationSpec): Promise<Extract<HighLevelDecision, { ok: true }> | string> {
    if (this.#claimRefusal(claim)) return STOPPED_TEXT;
    const now = spec ? await this.#authorizeOperation(claim, spec, args, spec.risk) : await this.#authorize(claim, tool, args);
    if (!now.ok) return now.text;
    if (now.grant.accountId !== before.grant.accountId || now.connection.epoch !== before.connection.epoch || now.connection.locationId !== before.connection.locationId
      || now.connection.companyId !== before.connection.companyId) {
      return "The HighLevel connection changed while this call ran. Run it again.";
    }
    // the asynchronous connection read above may have spanned a Stop
    if (this.#claimRefusal(claim)) return STOPPED_TEXT;
    return now;
  }

  async #releaseRead(claim: InternalCapability, spec: ReadSpec, args: Record<string, unknown>, decision: Authorized, reviewed: { actionId: string; context: ActionContext } | null): Promise<true | string> {
    try {
      if (this.#claimRefusal(claim) || this.#deps.signals.signalFor(claim).aborted) return 'stopped';
      const now = await this.#stillAuthorized(claim, HIGHLEVEL_FAMILY_TOOLS[spec.family], args, decision, spec);
      if (this.#claimRefusal(claim) || this.#deps.signals.signalFor(claim).aborted) return 'stopped';
      if (typeof now === 'string') return 'authority_changed';
      if (reviewed) {
        const c = reviewed.context, row = this.#deps.actions.get(reviewed.actionId);
        const current = row && this.#actionContext(claim, now, row.basis);
        if (!current || current.grantRevision !== c.grantRevision || current.accessRevision !== c.accessRevision || current.policyRevision !== c.policyRevision || current.roleBinding !== c.roleBinding
          || !row || row.phase !== 'dispatching' || row.reviewDigest !== reviewDigestFor({ ...row, ...c })) return 'authority_changed';
      } else if (this.#denyMatched(claim, spec, 'R')) return 'review_required';
      return true;
    } catch { return 'authority_unreadable'; }
  }

  async #read(claim: InternalCapability, tool: string, args: Record<string, unknown>, decision: Authorized, signal: AbortSignal, spec?: OperationSpec, initial?: RequestDraft): Promise<HighLevelToolResult> {
    if (!spec || spec.risk !== 'R' || !initial) return highlevelErrorResult('This operation has no verified read contract.');
    const pages: unknown[] = [];
    try {
      let draft: RequestDraft | null = initial;
      for (let page = 0; draft && page < spec.maxReads; page++) {
        const held = HeldRequest.freeze(spec, draft, { locationId: decision.connection.locationId });
        const value = await sendFrozenRead(this.#deps.client, this.#context(claim, decision, signal, tool, args, undefined, spec), held);
        const release = await this.#releaseRead(claim, spec, args, decision, null);
        if (release !== true) return highlevelErrorResult(`The read finished, but its result is not shown: ${release}.`, { outcome: 'withheld', ...(release === 'stopped' ? { stopped: true } : {}) });
        pages.push(spec.project(value, held.frozen));
        draft = spec.nextPage?.(value, draft) ?? null;
      }
      // A later page may have spanned revocation: release the aggregate under the same authority.
      const release = await this.#releaseRead(claim, spec, args, decision, null);
      if (release !== true) return highlevelErrorResult(`The read finished, but its result is not shown: ${release}.`, { outcome: 'withheld' });
      markTurnEmailDerived(claim.threadId);
      return highlevelCrmResult(pages.length === 1 ? pages[0] : pages);
    } catch (error) {
      if (error instanceof HighLevelStopped) return highlevelErrorResult(STOPPED_TEXT, { stopped: true });
      if (error instanceof ActionRefused) return highlevelErrorResult(error.message, { code: error.code });
      if (error instanceof HighLevelError && await this.#releaseRead(claim, spec, args, decision, null) === true) return highlevelErrorResult(this.#errorText(claim, error), { status: error.status });
      return highlevelErrorResult('The HighLevel read failed. No record data was returned.');
    }
  }

  async #reviewedRequest(claim: InternalCapability, tool: string, args: Record<string, unknown>, decision: Authorized, signal: AbortSignal, spec: OperationSpec, escalation: Escalation, held: HeldRequest, capture?: CaptureContactWrite, prepareOpportunity?: PrepareOpportunity): Promise<HighLevelToolResult> {
    const { id: operation, risk } = spec;
    // Removing enrollment links for one contact leaves every campaign and
    // contact intact. Only qualified destructive operations can be a wipe.
    const catastrophe = serviceNoLimits(claim.generation, claim.threadId, claim.botId)
      && spec.row.risk === 'D' && destructiveName(operation) && (spec.targets(args) > 1
      || operation !== 'automations.campaign.removeAll' && mcpBulkWipe(operation, args));
    let basis = risk === 'R' || catastrophe ? 'owner_exact_review' : this.#basis(claim, spec, risk);
    const context = (d: Authorized): ActionContext => this.#actionContext(claim, d, basis);
    let review: ActionReview;
    try { review = this.#deps.actions.propose(context(decision), tool, args, { recordRefs: operationExtension(spec.row)?.reviewRefs ? [...new Set([...spec.recordRefs(args), ...operationExtension(spec.row)!.reviewRefs!(held.frozen)])] : spec.recordRefs(args), fields: spec.fields(args), kind: risk === 'R' ? 'read' : 'change', risk, escalation, basis, held }); }
    catch (error) { return highlevelErrorResult(error instanceof ActionRefused ? error.message : 'The request could not be recorded. Nothing was sent.'); }
    const { actionId } = review;
    let status: number | undefined;
    let responseReceived = false;
    let policyRefusal: string | undefined;
    try {
      if (basis === 'owner_exact_review' && !catastrophe) {
        let rechecking: Promise<void> | undefined;
        this.#pendingReviews.set(actionId, { botId: claim.botId, recheck: () => {
          if (rechecking) return rechecking;
          rechecking = (async () => {
            if (!serviceNoLimits(claim.generation, claim.threadId, claim.botId) || signal.aborted
              || !['awaiting_approval', 'approved'].includes(this.#deps.actions.get(actionId)?.phase ?? '')) return;
            const current = await this.#stillAuthorized(claim, tool, args, decision, spec);
            if (signal.aborted) return;
            if (typeof current === 'string') {
              policyRefusal = current;
              if (this.#deps.actions.get(actionId)?.phase === 'approved') this.#deps.actions.notApplied(actionId, 'feature_off');
              else this.#deps.actions.deny(actionId);
              return;
            }
            const nextBasis = this.#basis(claim, spec, risk);
            if (nextBasis === 'owner_exact_review') return;
            basis = nextBasis;
            decision = current;
            upgradeHighLevelAction(this.#deps.actions, actionId, nextBasis, context(current));
          })().finally(() => { rechecking = undefined; });
          return rechecking;
        } });
      }
      if (basis === 'owner_exact_review') {
        if (spec.id === 'users.create' && !this.#userCreateOwner(claim)) {
          this.#deps.actions.deny(actionId); return highlevelErrorResult('Only you can add users, from the desktop app.');
        }
        if (!this.#deps.onReview) { this.#deps.actions.deny(actionId); return highlevelErrorResult('The review could not be delivered. Nothing was sent.'); }
        try { this.#deps.onReview(claim, { ...review, title: spec.title, catastrophe }); }
        catch { this.#deps.actions.deny(actionId); return highlevelErrorResult('The review could not be delivered. Nothing was sent.'); }
      } else this.#deps.actions.approveByPolicy(actionId, basis);
      // A level save may have completed while preparation was awaiting I/O.
      // Recheck after registering, so that transition cannot leave a new wait.
      await this.#pendingReviews.get(actionId)?.recheck();
      const answer = await this.#deps.actions.awaitDecision(actionId, signal);
      // A manual Allow can arrive during a level-change connection read. Join
      // that recheck before capturing the dispatch/replay authority digest.
      await this.#pendingReviews.get(actionId)?.recheck();
      this.#pendingReviews.delete(actionId);
      this.#deps.onReviewClosed?.(actionId);
      if (policyRefusal) return highlevelErrorResult(policyRefusal);
      if (answer !== 'approved') return highlevelErrorResult(answer === 'denied' ? 'The owner declined this request.' : 'The review expired.', { actionId, outcome: answer === 'denied' ? 'not_applied' : 'stale' });
      if (prepareOpportunity && spec.risk !== "R") {
        const intent = this.#deps.actions.get(actionId);
        if (!intent?.approvalId || !intent.requestDigest) throw new ActionRefused("stale", "The approval is unavailable.");
        return await prepareOpportunity(intent, held, async () => {
          const current = await this.#stillAuthorized(claim, tool, args, decision, spec);
          if (typeof current === "string" || intent.reviewDigest !== reviewDigestFor({ ...intent, ...context(current) })) {
            this.#deps.actions.markStale(actionId, "authority_changed");
            return { status: "conflict", reason: "authority_changed" };
          }
          const approvedContext = context(current);

          try {
            const dispatch = this.#deps.actions.beginDispatch(actionId, approvedContext);
            const beforeAttempt = async (attempt: number) => {
              const now = await this.#stillAuthorized(claim, tool, args, current, spec);
              if (typeof now === "string" || !this.#approvalStillHolds(claim, spec, risk, basis, current.grant.accountId)) {
                this.#deps.actions.markStale(actionId, "authority_changed");
                throw new ActionRefused("stale", "The approval no longer applies.");
              }
              this.#deps.actions.recordAttempt(actionId, attempt, context(now));
            };
            const ctx = this.#context(claim, current, signal, tool, args, beforeAttempt, spec);
            requestChanged.set(ctx, () => this.#deps.actions.markStale(actionId, "request_changed"));
            return await this.#dispatchWrite(spec, ctx, dispatch.held, dispatch.intent,
              () => this.#writeRelease(claim, spec, args, dispatch.intent), intent.reviewDigest);
          } catch (error) {
            if (error instanceof HighLevelError) status = error.status;
            return { status: "conflict", reason: error instanceof ActionRefused || error instanceof HighLevelStopped ? "authority_changed"
              : error instanceof HighLevelError && error.outcome === "not_applied" ? "negative_confirmation" : "unconfirmed" };
          }
        });
      }
      // Capture the binding synchronously after approval. RPC ownership registers
      // before its authorize callback's first await; direct calls own that await.
      if (spec.risk !== 'R' && nativeRecovery(spec) && spec.family === 'contacts')
        return await this.#contactWrite(claim, tool, args, decision, signal, spec, held, actionId, context, value => { status = value; }, capture);
      const approved = this.#deps.actions.get(actionId);
      if (!approved?.approvalId || !approved.requestDigest) throw new ActionRefused('stale', 'The durable approval no longer matches this request.');
      const invoke = async (): Promise<ApprovalOutcome | HighLevelToolResult> => {
        if (spec.risk !== 'R') {
          const plan = recoveryPlans.get(held);
          if (!plan) throw new ActionRefused('request_shape', 'The approved recovery plan is unavailable.');
          saveWriteRecovery(this.#deps.approvalJournal!, approved, plan);
        }
        const current = await this.#stillAuthorized(claim, tool, args, decision, spec);
        if (typeof current === 'string') {
          if (signal.aborted) throw new HighLevelStopped();
          this.#deps.actions.markStale(actionId, 'authority_changed'); throw new ActionRefused('stale', current);
        }
        const approvedContext = context(current);
        const intent = this.#deps.actions.get(actionId);
        if (!intent || !intent.approvalId || !intent.requestDigest || intent.operation !== spec.id
          || reviewDigestFor({ ...intent, ...approvedContext }) !== intent.reviewDigest) {
          this.#deps.actions.markStale(actionId, 'authority_changed');
          throw new ActionRefused('stale', 'The durable approval no longer matches this request.');
        }
        const dispatchOnce = async (): Promise<ApprovalOutcome | HighLevelToolResult> => {
          const dispatch = this.#deps.actions.beginDispatch(actionId, approvedContext);
          if (!dispatch.held || !dispatch.intent.requestDigest || dispatch.held.frozen.operation !== spec.id) { this.#deps.actions.markStale(actionId, 'request_changed'); throw new ActionRefused('stale', 'The reviewed request is no longer held.'); }
          const beforeAttempt = async (attempt: number) => {
            const admissionSignal = dispatchAdmissions.get(ctx) ?? signal;
            const assertAdmission = () => { if (admissionSignal.aborted) throw new HighLevelError('The dispatch deadline expired. Nothing was sent.', { status: 503 }); };
            assertAdmission();
            const extension = operationExtension(spec.row);
            if (extension?.revalidate && spec.risk !== 'R') {
              const preContext = this.#context(claim, current, admissionSignal, tool, args, undefined, spec, 'ownership');
              recheckAdmissions.add(preContext);
              const { connectionId: _connectionId, ...input } = args;
              const runContext = { locationId: current.connection.locationId };
              const fresh = HeldRequest.freeze(spec, await spec.prepare(createPreflightRequester(this.#deps.client, preContext, spec, this.#deps.operationSpec), spec.args.parse(input), runContext), runContext);
              if (!extension.revalidate(dispatch.held!.frozen, fresh.frozen)) {
                this.#deps.actions.markStale(actionId, 'request_changed');
                throw new ActionRefused('stale', 'The reviewed request changed. Nothing was sent.');
              }
            }
            if (spec.risk !== 'R' && spec.gate === 'GDp') {
              if (!spec.recheck) throw new ActionRefused('request_shape', 'This draft change requires a status check.');
              const preContext = this.#context(claim, current, admissionSignal, tool, args, undefined, spec, 'ownership');
              recheckAdmissions.add(preContext);
              const recheck = await spec.recheck(createPreflightRequester(this.#deps.client, preContext, spec, this.#deps.operationSpec), dispatch.held!.frozen, { locationId: current.connection.locationId, approvalContext: dispatch.held!.approvalContextCopy() });
              if (!recheck.ok) { this.#deps.actions.markStale(actionId, recheck.reason); throw new ActionRefused('stale', recheck.reason === 'changed' ? 'The reviewed request changed.' : 'This record is no longer a draft.'); }
            }
            let now: Authorized | string;
            try { now = await this.#stillAuthorized(claim, tool, args, current, spec); } catch { now = 'The bot’s HighLevel access could not be verified.'; }
            if (typeof now === 'string' || !this.#approvalStillHolds(claim, spec, risk, basis, current.grant.accountId)) {
              if (signal.aborted || now === STOPPED_TEXT) throw new HighLevelStopped();
              this.#deps.actions.markStale(actionId, 'authority_changed'); throw new ActionRefused('stale', 'The approval no longer applies. Nothing was sent.');
            }
            assertAdmission();
            if (spec.id === 'users.create' && !usersCreateRecipientVerified()) throw new ActionRefused('not_approved', USER_CREATE_HANDOFF);
            this.#deps.actions.recordAttempt(actionId, attempt, context(now));
            if (spec.id === 'users.create') {
              const identity = userCreateClaims.get(dispatch.held);
              if (!identity) throw new ActionRefused('unrecorded', 'We could not confirm that this request can be sent safely.');
              identity.barrier();
            }
          };
          const ctx = this.#context(claim, current, signal, tool, args, risk === 'R' ? undefined : beforeAttempt, spec);
          if (risk === 'R') ctx.beforeReadAttempt = beforeAttempt;
          requestChanged.set(ctx, () => this.#deps.actions.markStale(actionId, 'request_changed'));
          if (spec.risk !== 'R') return this.#dispatchWrite(spec, ctx, dispatch.held, dispatch.intent,
            () => this.#writeRelease(claim, spec, args, dispatch.intent), dispatch.intent.reviewDigest);
          const value = await sendFrozen(this.#deps.client, ctx, dispatch.held, dispatch.intent.requestDigest);
          responseReceived = true;
          {
            const release = await this.#releaseRead(claim, spec, args, current, { actionId, context: approvedContext });
            if (release !== true) {
              this.#deps.actions.settleRead(actionId, 'read_withheld', release);
              return highlevelErrorResult(`The read finished, but its result is not shown: ${release}.`, { actionId, outcome: 'withheld', ...(release === 'stopped' ? { stopped: true } : {}) });
            }
            const projected = spec.project(value, dispatch.held.frozen);
            markTurnEmailDerived(claim.threadId);
            const result = highlevelCrmResult(projected, { actionId, outcome: 'read_done' });
            this.#deps.actions.settleRead(actionId, 'read_done');
            return result;
          }

        };
        if (spec.risk === 'R') return await dispatchOnce() as HighLevelToolResult;
        return await runApprovedWrite(this.#deps.approvalJournal!, intent.approvalId, intent.requestDigest, {
          dispatch: async () => await dispatchOnce() as ApprovalOutcome,
          reconcile: () => this.#reconcileWrite(claim, spec, args, intent, current),
        });
      };
      if (spec.risk === 'R') return await invoke() as HighLevelToolResult;
      const outcome = await runApprovedInvocation(this.#deps.approvalJournal!, approved.approvalId, approved.requestDigest,
        async () => await invoke() as ApprovalOutcome);
      return await this.#publishWrite(claim, spec, args, approved, outcome);
    } catch (error) {
      if (error instanceof HighLevelError) status = error.status;
      if (spec.risk === 'R') {
        if (error instanceof HighLevelError && error.providerDetail) {
          const release = await this.#releaseRead(claim, spec, args, decision, { actionId, context: context(decision) });
          if (release !== true) {
            this.#deps.actions.settleRead(actionId, 'read_withheld', release);
            return highlevelErrorResult('The read finished, but its result is not shown: access changed.', { actionId, outcome: 'withheld' });
          }
          const text = this.#errorText(claim, error);
          this.#deps.actions.settleRead(actionId, 'failed');
          return highlevelErrorResult(text, { actionId, outcome: 'not_applied', status: error.status });
        }
        this.#deps.actions.settleRead(actionId, error instanceof HighLevelStopped ? 'stopped' : 'failed');
        return highlevelErrorResult(error instanceof HighLevelStopped ? STOPPED_TEXT : 'The HighLevel read failed. No record data was returned.', { actionId, outcome: this.#deps.actions.get(actionId)?.phase ?? 'not_applied', ...(error instanceof HighLevelStopped ? { stopped: true } : {}) });
      }
      const row = this.#deps.actions.get(actionId);
      if (row?.phase !== 'stale' && row?.phase !== 'applied') {
        if ((row?.dispatchAttempts ?? 0) > 0 && (responseReceived || !(error instanceof HighLevelError) || error.outcome === 'outcome_unknown')) this.#deps.actions.outcomeUnknown(actionId, 'possible_send');
        else this.#deps.actions.notApplied(actionId, error instanceof HighLevelStopped ? 'stopped_before_send' : 'refused');
      }
      return highlevelErrorResult(error instanceof ActionRefused ? error.message : error instanceof HighLevelStopped ? STOPPED_TEXT : 'The HighLevel change failed. Check its status before trying again.', { actionId, outcome: this.#deps.actions.get(actionId)?.phase, ...(error instanceof HighLevelStopped ? { stopped: true } : {}) });
    } finally {
      this.#pendingReviews.delete(actionId);
      // One guard surrounds send, release AND projection. Existing stale/terminal decisions win.
      if (risk === 'R') this.#deps.actions.settleRead(actionId, signal.aborted ? 'stopped' : 'failed');
      this.#deps.onReviewClosed?.(actionId);
      const row = this.#deps.actions.get(actionId);
      if (row && ['applied', 'not_applied', 'outcome_unknown', 'stale', 'read_done', 'read_withheld'].includes(row.phase)) this.#deps.onOutcome?.(claim, {
        actionId, operation, risk, basis, outcome: row.phase as HighLevelOutcomeRecord['outcome'], ...(status ? { status } : {}),
        recordIds: [...row.recordRefs], providerRecordIds: row.receipt?.recordId ? [row.receipt.recordId] : [], fields: [...row.fields],
      });
    }
  }

  /** The sole mutation dispatch boundary for every family. Callers must already
   * own and claim the same journal approval; no write can reach transport without it. */
  async #dispatchWrite(spec: MutationSpec, ctx: HighLevelCallContext, held: HeldRequest, intent: ActionIntent,
    authorized: () => Promise<boolean>, authorityDigest: string): Promise<ApprovalOutcome> {
    const journal = this.#deps.approvalJournal;
    if (!journal || !intent.approvalId || journal.get(intent.approvalId)?.state !== 'pending'
      || journal.get(intent.approvalId)?.requestDigest !== intent.requestDigest || held.frozen.requestDigest !== intent.requestDigest)
      { this.#deps.actions.markStale(intent.actionId, 'request_changed'); throw new ActionRefused('stale', 'The durable approval is unavailable. Nothing was sent.'); }
    const bound = prepareReturnedIdentitySchema(held, intent.locationId);
    const value = await sendFrozen(this.#deps.client, ctx, held, intent.requestDigest);
    try {
    const binding = bindReturnedIdentities(value, held.frozen, bound);
    if (binding.status !== 'applied') return { status: 'conflict', reason: binding.status === 'not_applied' ? 'negative_confirmation' : 'identity_conflict' };
    if (!await authorized()) return { status: 'conflict', reason: 'authority_changed' };
    const receipt = { recordId: spec.recordId?.(value, held.frozen) ?? '', fields: [...intent.fields] };
    const projected = spec.project(value, held.frozen);
    if (!await authorized() || this.#deps.actions.get(intent.actionId)?.phase !== 'dispatching') return { status: 'conflict', reason: 'authority_changed' };
    return { status: 'applied', result: { intent, actionId: intent.actionId, authorityDigest, receipt,
      toolResult: highlevelCrmResult({ result: projected }, { actionId: intent.actionId, outcome: 'applied' }) } };
    } catch { return { status: 'conflict', reason: 'unconfirmed' }; }
  }

  /** Stored results are data, never authority. Check the original durable intent on every release. */
  async #writeRelease(claim: InternalCapability, spec: OperationSpec, args: Record<string, unknown>, row: ActionIntent): Promise<boolean> {
    if (row.botId !== claim.botId || row.threadId !== claim.threadId || row.turnGeneration !== claim.generation
      || row.operation !== spec.id || row.tool !== HIGHLEVEL_FAMILY_TOOLS[spec.family]
      || row.argumentsDigest !== argumentsDigest(row.tool, args) || this.#deps.actions.get(row.actionId)?.phase === 'stale') return false;
    const now = await this.#authorizeOperation(claim, spec, { ...args, connectionId: row.connectionId }, row.risk);
    if (!now.ok || this.#deps.actions.get(row.actionId)?.phase === 'stale' || this.#deps.signals.signalFor(claim).aborted || !this.#approvalStillHolds(claim, spec, row.risk, row.basis, row.connectionId)) return false;
    return reviewDigestFor({ ...row, ...this.#actionContext(claim, now, row.basis) }) === row.reviewDigest;
  }

  async #publishWrite(claim: InternalCapability, spec: OperationSpec, args: Record<string, unknown>, row: ActionIntent, outcome: ApprovalOutcome): Promise<HighLevelToolResult> {
    const { actionId } = row;
    if (!await this.#writeRelease(claim, spec, args, row)) {
      this.#deps.actions.outcomeUnknown(actionId, 'authority_changed');
      return highlevelErrorResult('The change result is withheld because its approval no longer applies.', { actionId, outcome: this.#deps.actions.get(actionId)?.phase });
    }
    if (outcome.status === 'conflict') {
      if (outcome.reason === 'negative_confirmation') this.#deps.actions.notApplied(actionId, outcome.reason);
      else this.#deps.actions.outcomeUnknown(actionId, outcome.reason);
      return highlevelErrorResult('The approved change could not be confirmed.', { actionId, outcome: this.#deps.actions.get(actionId)?.phase, code: outcome.reason });
    }
    const result = outcome.result as { toolResult: HighLevelToolResult; receipt: { recordId: string; fields: string[] } };
    if (['dispatching', 'outcome_unknown'].includes(this.#deps.actions.get(actionId)?.phase ?? '')) this.#deps.actions.applied(actionId, result.receipt);
    markTurnEmailDerived(claim.threadId);
    return structuredClone(result.toolResult);
  }

  async #replayWrite(claim: InternalCapability, original: OperationSpec, args: Record<string, unknown>, row: ActionIntent): Promise<HighLevelToolResult> {
    const spec = { ...original, risk: row.risk } as OperationSpec;
    try {
      if (!row.approvalId || !row.requestDigest || !await this.#writeRelease(claim, spec, args, row)
        || (args.connectionId !== undefined && args.connectionId !== row.connectionId))
        return highlevelErrorResult('This tool call no longer matches its stored approval.', { actionId: row.actionId, outcome: row.phase });
      const current = await this.#authorizeOperation(claim, spec, { ...args, connectionId: row.connectionId }, row.risk);
      if (!current.ok) return highlevelErrorResult(current.text);
      const outcome = await runApprovedInvocation(this.#deps.approvalJournal!, row.approvalId, row.requestDigest,
        () => runApprovedWrite(this.#deps.approvalJournal!, row.approvalId!, row.requestDigest!, {
          // With no live owner, even a missing claim is recovery work, never a new send.
          dispatch: () => this.#reconcileWrite(claim, spec, args, row, current),
          reconcile: () => this.#reconcileWrite(claim, spec, args, row, current),
        }));
      return await this.#publishWrite(claim, spec, args, row, outcome);
    } catch { return highlevelErrorResult('The stored change could not be verified. Nothing was resent.', { actionId: row.actionId, outcome: 'outcome_unknown' }); }
  }

  async #reconcileWrite(claim: InternalCapability, spec: OperationSpec, args: Record<string, unknown>, row: ActionIntent, current: Authorized): Promise<ApprovalOutcome> {
    if (!await this.#writeRelease(claim, spec, args, row)) return { status: 'conflict', reason: 'authority_changed' };
    const plan = loadWriteRecoveryForSpec(this.#deps.approvalJournal!, row, spec);
    if (!plan) return { status: 'conflict', reason: 'unconfirmed' };
    const ctx = this.#context(claim, current, this.#deps.signals.signalFor(claim), row.tool, args, undefined, spec, 'ownership');
    recheckAdmissions.add(ctx);
    const pre = createPreflightRequester(this.#deps.client, ctx, { preflight: operationExtension(spec.row)?.reconciliation ?? reconciliationReadsFor(row.operation) }, this.#deps.operationSpec);
    try {
      // Plans admit one concrete record or a bounded operation-specific lookup.
      if (plan.readTargets.length !== 1) return { status: 'conflict', reason: 'unconfirmed' };
      let value: unknown, absent = false;
      try { value = await readWriteRecovery(plan, pre, args); }
      catch (error) {
        if (!(error instanceof HighLevelError) || error.status !== 404 || !row.operation.endsWith('.delete') || plan.collection) throw error;
        absent = true; value = operationExtension(spec.row)?.absenceConfirmation ?? { success: true };
      }
      if (!await this.#writeRelease(claim, spec, args, row)) return { status: 'conflict', reason: 'authority_changed' };
      const witness = compareWriteRecovery(plan, value, spec, absent);
      if ('outcome' in witness) return witness.outcome;
      if (spec.risk === 'R') return { status: 'conflict', reason: 'unconfirmed' };
      const receipt = { recordId: spec.recordId?.(witness.value, witness.held.frozen) ?? '', fields: row.fields };
      const projected = spec.project(witness.value, witness.held.frozen);
      if (!await this.#writeRelease(claim, spec, args, row)) return { status: 'conflict', reason: 'authority_changed' };
      return { status: 'applied', result: { toolResult: highlevelCrmResult({ result: projected }, { actionId: row.actionId, outcome: 'applied' }), receipt } };
    } catch {
      return { status: 'conflict', reason: await this.#writeRelease(claim, spec, args, row) ? 'unconfirmed' : 'authority_changed' };
    }
  }

  #opportunityOutcome(claim: InternalCapability, intent: ActionIntent, outcome: ApprovalOutcome, settle: boolean): HighLevelToolResult {
    const row = this.#deps.actions.get(intent.actionId);
    if (row?.phase === "stale") return highlevelErrorResult("The approval is stale; its result is withheld.", { actionId: intent.actionId, outcome: "stale" });
    if (outcome.status === "applied") {
      const saved = outcome.result as { toolResult: HighLevelToolResult; receipt: { recordId: string; fields: string[] } };
      if (settle) this.#deps.actions.applied(intent.actionId, saved.receipt);
      markTurnEmailDerived(claim.threadId);
      return structuredClone(saved.toolResult);
    }
    const phase = outcome.reason === "negative_confirmation" ? "not_applied" : "outcome_unknown";
    if (settle) {
      if (phase === "not_applied") this.#deps.actions.notApplied(intent.actionId, outcome.reason);
      else this.#deps.actions.outcomeUnknown(intent.actionId, outcome.reason);
    }
    return highlevelErrorResult("The HighLevel change could not be confirmed. Check its status before trying again.", { actionId: intent.actionId, outcome: phase });
  }

  async #opportunityRpc(claim: InternalCapability, spec: OperationSpec, input: Record<string, unknown>, callIdentity?: string): Promise<HighLevelToolResult> {
    const journal = this.#deps.approvalJournal;
    if (!journal) return highlevelErrorResult("The durable approval journal is unavailable. Nothing was sent.");
    const hash = (value: unknown) => createHash("sha256").update(canonicalBindingJson(value)).digest("hex");
    const rpcId = hash([claim.botId, claim.threadId, claim.generation, callIdentity ?? randomUUID()]);
    const rpcDigest = hash(input);
    const args = { ...(input.args as Record<string, unknown>), ...(input.connectionId ? { connectionId: input.connectionId } : {}) };
    let prepared: { intent: ActionIntent; held: HeldRequest; dispatch: () => Promise<ApprovalOutcome> } | undefined;
    let preparationResult: HighLevelToolResult | undefined;
    const intentFor = (binding: RpcApprovalBinding): ActionIntent | null => {
      const row = this.#deps.actions.get(binding.actionId);
      if (row) return row;
      const terminal = journal.get(binding.approvalId);
      return terminal?.state === "applied" && object(terminal.result) ? parseIntent(terminal.result.intent) : null;
    };
    const authorize = async (binding: RpcApprovalBinding): Promise<boolean> => {
      const intent = intentFor(binding);
      if (!intent || intent.phase === "stale" || intent.approvalId !== binding.approvalId || intent.requestDigest !== binding.requestDigest
        || intent.reviewDigest !== binding.authorityDigest || intent.reviewDigest !== reviewDigestFor(intent) || intent.operation !== binding.operation || binding.operation !== spec.id
        || intent.botId !== claim.botId || intent.threadId !== claim.threadId || intent.turnGeneration !== claim.generation) return false;
      const now = await this.#authorizeOperation(claim, spec, args, intent.risk);
      const allowed = now.ok && !this.#deps.signals.signalFor(claim).aborted
        && this.#deps.actions.get(intent.actionId)?.phase !== "stale"
        && this.#approvalStillHolds(claim, spec, intent.risk, intent.basis, intent.connectionId)
        && now.grant.accountId === intent.connectionId && now.connection.epoch === intent.connectionEpoch
        && now.connection.locationId === intent.locationId && now.connection.companyId === intent.companyId
        && reviewDigestFor({ ...intent, ...this.#actionContext(claim, now, intent.basis) }) === intent.reviewDigest;
      if (!allowed) this.#deps.actions.markStale(intent.actionId, "authority_changed");
      return allowed;
    };
    try {
      // Legacy RPC claims cannot be re-reviewed or guessed into a new write.
      if (!journal.getRpc(rpcId) && this.#deps.callJournal?.get(rpcId)) return highlevelErrorResult("The recorded tool call needs read-only recovery.", { outcome: "outcome_unknown" });
      const outcome = await runRpcApprovedWrite(journal, rpcId, rpcDigest, {
        prepare: async () => {
          preparationResult = await this.#operationCall(claim, spec.family, input, undefined, undefined, async (intent, held, dispatch) => {
            prepared = { intent, held, dispatch };
            return highlevelOk({});
          });
          if (!prepared) throw new Error("Preparation refused");
          return opportunityReplayBinding(rpcId, rpcDigest, prepared.intent, prepared.held, journal.key);
        },
        authorize,
        dispatch: async () => prepared!.dispatch(),
        reconcile: async binding => {
          const intent = intentFor(binding);
          if (!intent) return { status: "conflict", reason: "authority_changed" };
          const current = await this.#authorizeOperation(claim, spec, args, intent.risk);
          if (!current.ok || !await authorize(binding)) return { status: "conflict", reason: "authority_changed" };
          const pre = createPreflightRequester(this.#deps.client, this.#context(claim, current, this.#deps.signals.signalFor(claim), HIGHLEVEL_FAMILY_TOOLS[spec.family], args, undefined, spec, "ownership"), spec, this.#deps.operationSpec);
          return reconcileOpportunityEffect(binding, intent, spec, pre, journal.key);
        },
      });
      const binding = journal.getRpc(rpcId);
      const intent = binding ? intentFor(binding) : prepared && this.#deps.actions.get(prepared.intent.actionId);
      if (!binding || !intent || !await authorize(binding)) {
        if (intent) this.#deps.actions.outcomeUnknown(intent.actionId, "authority_changed_after_send");
        return highlevelErrorResult("The approval no longer authorizes release of this result.", { ...(binding ? { actionId: binding.actionId } : {}), outcome: intent?.phase === "stale" ? "stale" : "outcome_unknown" });
      }
      const result = this.#opportunityOutcome(claim, intent, outcome, true);
      return result;
    } catch {
      if (!prepared && preparationResult) return preparationResult;
      if (prepared) {
        this.#deps.actions.outcomeUnknown(prepared.intent.actionId, "interrupted_after_send");
      }
      return highlevelErrorResult("The HighLevel change could not be confirmed. Check its status before trying again.", { ...(prepared ? { actionId: prepared.intent.actionId } : {}), outcome: "outcome_unknown" });
    } finally {
      if (prepared) {
        const row = this.#deps.actions.get(prepared.intent.actionId)!;
        if (["applied", "not_applied", "outcome_unknown", "stale"].includes(row.phase)) this.#deps.onOutcome?.(claim, {
          actionId: row.actionId, operation: row.operation, risk: row.risk, basis: row.basis,
          outcome: row.phase as HighLevelOutcomeRecord["outcome"], recordIds: [...row.recordRefs], approvedRecordIds: [...row.recordRefs],
          providerRecordIds: row.phase === "applied" && row.receipt?.recordId ? [row.receipt.recordId] : [], fields: [...row.fields],
        });
      }
    }
  }

  async #helper(claim: InternalCapability, name: "HIGHLEVEL_LIST_CONNECTIONS" | "HIGHLEVEL_ACTION_STATUS", args: Record<string, unknown>): Promise<HighLevelToolResult> {
    const bot = this.#deps.bot(claim.botId);
    if (!bot || bot.composio === false) return highlevelErrorResult(CONNECTED_APPS_OFF);
    if (name === "HIGHLEVEL_ACTION_STATUS") {
      const status = this.#deps.actions.statusFor(claim.botId, String(args.actionId));
      if (!status) return highlevelErrorResult("This bot has no HighLevel change with that id.");
      // the receipt's record id came from HighLevel's answer: fenced as outside content, and the turn marked, like any CRM words
      const recordId = status.receipt?.recordId;
      if (!status.receipt || typeof recordId !== "string" || recordId === "") return highlevelOk(status);
      markTurnEmailDerived(claim.threadId);
      return highlevelOk({ ...status, receipt: { ...status.receipt, recordId: fenceHighLevelText(recordId) } });
    }
    const grants = this.#grantsFor(bot, claim);
    const start = typeof args.cursor === "string" ? Number(args.cursor) : 0;
    const limit = Math.min(PAGE_MAX, Math.max(1, typeof args.limit === "number" ? args.limit : 20));
    const page = grants.slice(start, start + limit);
    const connections = [];
    for (const grant of page) {
      const view = await this.#deps.leases.connection(grant.accountId);
      // the location's name is HighLevel's own text: fenced like any CRM words
      connections.push({ connectionId: grant.accountId, locationName: typeof view?.locationName === "string" ? fenceHighLevelText(view.locationName) : undefined, state: view?.state ?? "disconnected", tools: [...grant.tools], ceiling: grant.ceiling });
    }
    // The awaits above may have spanned a Stop or a grant change: answer only with what is still true now.
    if (this.#claimRefusal(claim)) return highlevelErrorResult(STOPPED_TEXT, { stopped: true });
    const now = this.#deps.bot(claim.botId);
    if (!now || now.composio === false) return highlevelErrorResult(CONNECTED_APPS_OFF);
    const still = new Map(this.#grantsFor(now, claim).map((grant) => [grant.accountId, grant]));
    for (let i = connections.length - 1; i >= 0; i--) {
      const grant = still.get(connections[i]!.connectionId);
      if (!grant) connections.splice(i, 1);
      else Object.assign(connections[i]!, { tools: [...grant.tools], ceiling: grant.ceiling });
    }
    // a location name is HighLevel's own words: the turn is marked as after a read
    if (connections.some((connection) => connection.locationName !== undefined)) markTurnEmailDerived(claim.threadId);
    return highlevelOk({ connections, ...(start + limit < grants.length ? { nextCursor: String(start + limit) } : {}) });
  }
}

/** Frozen C2 hooks. Optional on the legacy host until C2 installs operation dispatch. */
export interface HighLevelHostDeps {
  approvalBasis?: (claim: InternalCapability, spec: OperationSpec, risk: import("../../shared/highlevel.ts").Risk) => "owner_exact_review" | "owner_no_limits" | "owner_no_limits_attended";
  onOutcome?: (claim: InternalCapability, o: { actionId: string; operation: import("../../shared/highlevel.ts").OperationId; risk: import("../../shared/highlevel.ts").Risk; basis: string; outcome: "applied" | "not_applied" | "outcome_unknown" | "stale" | "read_done" | "read_withheld"; status?: number; recordIds: string[]; approvedRecordIds?: string[]; providerRecordIds?: string[]; fields: string[] }) => void;
}
