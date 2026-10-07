// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// The Chief's New project proposal on every engine (lane N, SPEC-P 11.1 POST
// /api/projects/proposal; lane N2). The proposal is a block in the Chief's
// reply (project-new.ts readProposalReply), so it never depends on Murage
// recognising a tool call. Claude keeps its one-shot call with every tool,
// MCP server, hook and session file off (drivers/claude.ts generateReview).
// Every other enabled engine runs ONE hidden owner-audience turn in the most
// restrictive mode it offers: stopLine (an engine that asks sends its asks to
// Murage, which denies them) and proposalOnly (Codex: no shell tool, no web
// search, no apps, read-only sandbox, ephemeral; pi: its gate asks before
// every tool). What an engine allows on its own still runs (Antigravity's
// edits in the temporary folder under accept-edits, a web search an ACP
// engine does unasked; each leaves one redacted log line), and an engine
// keeps its own copy of the conversation where it stores sessions: the Chief
// is the owner's own bot on the owner's own request, with those permissions
// in its normal chats, and the result is only a draft the owner reviews
// before anything is created.
//
// Where the project_propose tool already works (Fuigo and Grok Build through
// use_tool with a per-turn mount, pi through its gate), the turn also mounts
// the agents server in the proposal role and the tool stays an equivalent
// input: its asks are allowed only when they prove the call.

import { randomBytes } from 'node:crypto';
import { z } from 'zod';

/** `tool`: the turn also mounts project_propose (`serverAlias`: reached by
 * name through use_tool, so mounted under a per-turn alias). Null: the block
 * in the reply is the only way back, and every ask is denied. */
export type ProposalEngine = { kind: 'one-shot' } | { kind: 'turn'; tool: { call: string; serverAlias: boolean } | null };

interface ProposalInstance {
  driverKind: string;
  enabled: boolean;
  adapter: { capabilities: { agentsMcp?: boolean } };
  proposeProject?: unknown;
}

export const PROJECT_PROPOSE_ROUTE = '/api/internal/project/propose';

/** Runtime switches. `turnTimeoutMs`: the hidden turn starts an engine (and
 * on tool engines mounts the agents server), so it waits longer than
 * Claude's tools-off one-shot (30 s in project-new.ts). `toolEngines`: the
 * engines whose ask proves the project_propose call (Fuigo and Grok Build
 * stamp or spell use_tool with the per-turn mount; pi's gate lets exactly
 * that one tool run). Every other engine answers with the block only:
 * gemini-cli asks without the call's input, the other ACP engines name the
 * tool by display title only, and Codex's shell exposure with the agents
 * server mounted was never proven on a live turn. */
export const proposalSettings = { turnTimeoutMs: 90_000, toolEngines: new Set(['fuigoAgent', 'grokAgent', 'piAgent']) };

/** How this engine runs the proposal, or null when it cannot run at all
 * (missing or turned off). */
export function proposalEngine(instance: ProposalInstance | null | undefined): ProposalEngine | null {
  if (!instance || instance.enabled === false) return null;
  if (typeof instance.proposeProject === 'function') return { kind: 'one-shot' };
  const tool = instance.adapter.capabilities.agentsMcp === true && proposalSettings.toolEngines.has(instance.driverKind);
  return { kind: 'turn', tool: tool ? { call: proposalToolCall(instance.driverKind), serverAlias: USE_TOOL_ENGINES.has(instance.driverKind) } : null };
}

const USE_TOOL_ENGINES = new Set(['fuigoAgent', 'grokAgent']);
/** A per-turn mount name for the agents server, like Fuigo's memory alias
 * (acp/fuigo-memory-permission.ts); "<alias>__project_propose" stays under 61 bytes. */
export const newProposalServerAlias = () => `murage-agents-${randomBytes(10).toString('hex')}`;

/** The exact way each engine's model reaches the tool, in its own naming. */
export function proposalToolCall(driverKind: string, server = 'agents'): string {
  switch (driverKind) {
    // Fuigo and Grok Build never list MCP tools to the model: they are
    // reached through use_tool with "<server>__<tool>".
    case 'fuigoAgent':
    case 'grokAgent':
      return `Call use_tool with tool_name "${server}__project_propose" and the proposal as its input. search_tool shows the tool's inputs. A bare name like project_propose is not a tool.`;
    // Both list MCP tools as mcp__<server>__<tool>; Codex mounts Murage's
    // own agents server under its own name (codex.ts mountMcpServer).
    case 'claudeAgent':
    case 'codex':
      return 'Call the mcp__agents__project_propose tool with the proposal as its input.';
    // pi-mcp-extension.ts registers "<server>_<tool>".
    case 'piAgent':
      return 'Call the agents_project_propose tool with the proposal as its input.';
    default:
      return 'Call the project_propose tool of the agents MCP server with the proposal as its input. Your engine may show it with the server name in front, such as mcp__agents__project_propose or agents_project_propose.';
  }
}

/** Mirrors projectCloseToolRefusal: bound from the executing capability,
 * never from anything the model sent. */
export function projectProposalToolRefusal(proposalTurn: boolean, method: string, path: string):
  { status: 403 | 409; body: { error: string; reason?: string } } | null {
  if (!proposalTurn) return path === PROJECT_PROPOSE_ROUTE ? { status: 403, body: { error: 'Only a New project proposal can use this tool.' } } : null;
  return method === 'POST' && path === PROJECT_PROPOSE_ROUTE ? null
    : { status: 409, body: { error: 'not_allowed', reason: 'This turn can only send the project proposal.' } };
}

/** The propose tool's input and nothing else (the agents proxy's schema);
 * values are judged by the server when the call lands. */
const proposalInput = z.object({
  members: z.array(z.string()), leadBotId: z.string().nullable().optional(), mode: z.string(),
  brief: z.object({ summary: z.string(), doneMeans: z.string(), rules: z.string() }).strict(),
  budget: z.object({ minutes: z.number(), tokens: z.number() }).strict(), planOutline: z.array(z.string()),
}).strict();
const isProposalInput = (value: unknown) => proposalInput.safeParse(value).success;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
/** use_tool's raw input naming the propose tool on this turn's mount and
 * carrying a proposal, nothing else: Fuigo's {variant:"UseTool", tool_name,
 * tool_input} (fuigo-memory-permission.ts), or the plain {tool_name, input}. */
function proposeThroughUseTool(input: unknown, server: string, carries: (value: unknown) => boolean = isProposalInput): boolean {
  if (!isRecord(input) || input.tool_name !== `${server}__project_propose`) return false;
  if (exactKeys(input, ['tool_name', 'input'])) return carries(input.input);
  return exactKeys(input, ['variant', 'tool_name', 'tool_input']) && input.variant === 'UseTool' && carries(input.tool_input);
}
export interface ProposalAsk {
  requestType?: string;
  questionTool?: boolean;
  toolCall?: { name?: unknown; input?: unknown };
  /** ACP's structured tool kind (acp/core.ts), when the engine reports one. */
  toolKind?: string;
  /** The engine's stamped identity of the tool (Fuigo `_meta["fuigo/tool"]`). */
  toolIdentity?: { namespace?: string; name?: string; kind?: string };
}
/** Engines whose asks carry the drivers' own structured names (Codex's
 * serverName, pi's gate); every other engine is judged by the ACP allowlist. */
const NAMED_ASK_ENGINES = new Set(['codex', 'piAgent', 'claudeAgent']);
export function proposalAskContext(driverKind: string, server: string) { return { acp: !NAMED_ASK_ENGINES.has(driverKind), server }; }
/** An engine's permission ask on a proposal turn: only the project_propose
 * call itself, and only with a proposal as its input. An allowlist, never
 * display text, never a question:
 *  - ACP (Fuigo, Grok Build): a stamped identity naming the tool on this
 *    turn's mount, or kind exactly "other" (or none) and exactly use_tool on
 *    this turn's mount carrying a proposal. Any other kind is refused.
 *  - Codex: `mcp__<server>__project_propose` (its structured serverName and
 *    the tool its approval names). Pi never asks for the tool (its gate lets
 *    exactly that one through) and is refused.
 * Where the name is structural (a stamp, Codex's serverName) any object input
 * passes, so the server's validator can tell the Chief what to fix (R9-3). */
export function proposalAskAllowed(event: ProposalAsk, context: { acp: boolean; server: string }): boolean {
  if (event.requestType !== 'permission' || event.questionTool === true || !event.toolCall) return false;
  const { name, input } = event.toolCall;
  if (!context.acp) return name === `mcp__${context.server}__project_propose` && isRecord(input);
  const identity = event.toolIdentity;
  if (event.toolKind !== undefined && event.toolKind !== 'other') return false;
  if (identity) {
    if (identity.namespace === 'mcp') return identity.name === `${context.server}__project_propose` && isRecord(input);
    return identity.namespace === 'fuigo_build' && identity.name === 'use_tool' && identity.kind === 'use_tool' && proposeThroughUseTool(input, context.server, isRecord);
  }
  return proposeThroughUseTool(input, context.server);
}
/** A tool item that started on a Fuigo or Grok Build proposal turn, judged
 * by the engine's structured stamp and kind, never by its display label
 * (which the model's own input can shape). With a stamp: only Fuigo's
 * use_tool and search_tool, or the propose tool on this turn's mount, may
 * run; anything else ran without Murage's ask, so the turn is stopped and
 * the owner gets the plain form (R9-4). Without a stamp: a native kind
 * (read, edit, delete, move, search, execute, fetch, switch_mode) stops it;
 * other, think and none (Murage's own notices carry no kind) do not. Only
 * ever a reason to stop, never to allow a call: the ask gate decides those. */
const CATALOG_TOOLS = new Set(['use_tool', 'search_tool']);
const QUIET_KINDS = new Set(['other', 'think']);
export function proposalToolItemStops(driverKind: string, item: { toolKind?: string; toolIdentity?: { namespace?: string; name?: string } }, server: string): boolean {
  if (!USE_TOOL_ENGINES.has(driverKind)) return false;
  const identity = item.toolIdentity;
  if (identity) {
    if (identity.namespace === 'fuigo_build') return !CATALOG_TOOLS.has(identity.name ?? '');
    if (identity.namespace === 'mcp') return identity.name !== `${server}__project_propose`;
    return true;
  }
  return item.toolKind !== undefined && !QUIET_KINDS.has(item.toolKind);
}
const word = (value: unknown) => typeof value === 'string' ? value.replace(/[^\w.-]/g, '').slice(0, 60) : '';
/** The one line a refused ask leaves in the server log: no prompt, no
 * input, no title; engine-supplied words cut to identifier characters. */
export function proposalAskRefusalLine(event: ProposalAsk, driverKind: string): string {
  const identity = event.toolIdentity ? `${word(event.toolIdentity.namespace)}/${word(event.toolIdentity.name)}` : 'none';
  return `Chief proposal: an engine ask was denied (engine ${word(driverKind)}, tool kind ${word(event.toolKind) || 'none'}, identity ${identity}).`;
}
/** The one line a tool the engine ran without asking leaves on a turn that
 * answers with the block only: engine and structured kind, nothing else. */
export function proposalOwnToolLine(driverKind: string, toolKind?: string): string {
  return `Chief proposal: the engine ran a tool without asking (engine ${word(driverKind)}, tool kind ${word(toolKind) || 'none'}).`;
}

export interface ValidatedProposal {
  proposal: { members: string[]; leadBotId: string | null; mode: 'goal' | 'chat' | 'ongoing' | 'bots';
    brief: { summary: string; doneMeans: string; rules: string }; budget: { minutes: number; tokens: number }; planOutline: string[] };
  note?: string;
}

interface PendingProposal {
  botId: string;
  generation: string;
  instanceId: string;
  validate(raw: unknown): ValidatedProposal;
  resolve(result: ProposalTurnOutcome): void;
  /** Revokes the turn's capability generation; run once, at end(). */
  onEnd?: () => void;
  settled: boolean;
}

/** A proposal its tool sent, the turn's reply text (`partial`: the turn
 * failed or was stopped first), or nothing. */
export type ProposalTurnOutcome = ValidatedProposal | { text: string; partial?: true } | null;

/** Proposal turns in flight, by their hidden thread. Runtime only: a restart
 * drops them, and the owner's request has timed out by then anyway. */
export class ChiefProposalTurns {
  readonly #turns = new Map<string, PendingProposal>();
  /** Ended proposal threads: an engine's late events (a stop's terminal
   * event, a child exit) stay ignored after the wait is over. Bounded. */
  readonly #ended = new Set<string>();

  begin(threadId: string, botId: string, generation: string, instanceId: string, validate: (raw: unknown) => ValidatedProposal, onEnd?: () => void): Promise<ProposalTurnOutcome> {
    return new Promise(resolve => {
      this.#turns.set(threadId, { botId, generation, instanceId, validate, resolve, onEnd, settled: false });
    });
  }

  owns(threadId: string): boolean { return this.#turns.has(threadId); }

  /** A proposal thread, running or ended: its provider events belong to no one else. */
  ignores(threadId: string): boolean { return this.#turns.has(threadId) || this.#ended.has(threadId); }

  instanceOf(threadId: string): string | undefined { return this.#turns.get(threadId)?.instanceId; }

  /** One submission from the turn's own capability. */
  submit(threadId: string, generation: string, raw: unknown): { status: number; body: Record<string, unknown> } {
    const turn = this.#turns.get(threadId);
    if (!turn || turn.generation !== generation) return { status: 403, body: { error: 'This proposal turn has ended.' } };
    if (turn.settled) return { status: 409, body: { error: 'not_allowed', reason: 'The proposal was already sent.' } };
    let result: ValidatedProposal;
    try { result = turn.validate(raw); }
    catch (error) { return { status: 400, body: { error: error instanceof Error ? error.message : 'Check the proposal.' } }; }
    turn.settled = true;
    turn.resolve(result);
    return { status: 200, body: { ok: true, text: 'The proposal is with the owner. End your turn now.' } };
  }

  /** The turn ended, timed out or failed: an unanswered wait resolves with
   * the reply text so far (`text`; `partial` when the turn did not finish),
   * else empty. */
  end(threadId: string, generation: string, text?: string, partial?: boolean): void {
    const turn = this.#turns.get(threadId);
    if (!turn || turn.generation !== generation) return;
    this.#turns.delete(threadId);
    this.#ended.add(threadId);
    if (this.#ended.size > 256) this.#ended.delete(this.#ended.values().next().value!);
    turn.onEnd?.();
    if (!turn.settled) { turn.settled = true; turn.resolve(text === undefined ? null : partial ? { text, partial: true } : { text }); }
  }
}
