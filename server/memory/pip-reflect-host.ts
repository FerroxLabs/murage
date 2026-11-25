// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PIP P2: the wiring between the reflection machine and the server's routing (design 3.3). The route is the
// speaking route of the bot's own task, with the optional `reflectModel` on the same connection; the fingerprint
// is computed from configuration before anything is resolved, so a throwing route is recorded under it.
import type { ProviderInstance } from "../contracts.ts";
import type { ProviderTurnRoute } from "../provider-routing.ts";
import { binaryIdentity, preflightRoute, routeFingerprint, type PipEngine } from "./pip-transport.ts";
import type { ReflectBot, ResolvedRoute } from "./pip-reflect.ts";

const CLI_ENGINE: Record<string, PipEngine> = { fuigoAgent: "fuigo", grokAgent: "grok", claudeAgent: "claude" };

export interface RouteHost {
  /** The bot's task as the speaking route sees it (store.projectBotForTask(bot, thread) ?? bot). */
  modelSelectionOf(bot: ReflectBot, threadId: string): { instanceId: string; model: string; connectionId?: string };
  /** turnRouting(task): throws the turn's own refusal when the connection or model is unavailable. */
  turnRouting(bot: ReflectBot, threadId: string): { instance: ProviderInstance; providerRoute: ProviderTurnRoute | undefined };
  connectionRevision(connectionId: string): string | null;
  /** The resolved CLI path of an engine, when it has one. */
  binaryPath(engine: PipEngine): string | undefined;
  botFolderOf?(bot: ReflectBot, threadId: string): string | undefined;
  connectionModels?(connectionId: string): readonly string[];
}

/** 1.0.22 idle: ReflectBot.routeStamp, the owner's route choice for every thread of the bot (the reflect model and each thread's model
 *  selection, as resolveRoute reads them). Pure configuration: no route is resolved, no binary is read. */
export function reflectRouteStamp(bot: Pick<ReflectBot, "threadIds" | "options">, selectionOf: (threadId: string) => { instanceId: string; model: string; connectionId?: string } | undefined): string {
  return JSON.stringify([bot.options?.reflectModel ?? null, bot.threadIds.map(threadId => { const s = selectionOf(threadId); return s ? [s.instanceId, s.model, s.connectionId ?? null] : null; })]);
}

/** What reflectBotsOf reads of the server's store (server/store.ts: bots, threadIdsForBot, projectBotForTask). */
export interface ReflectStoreView {
  readonly bots: ReadonlyArray<{ id: string; name?: string; continuity?: boolean; continuityOptions?: ReflectBot["options"]; continuityGeneration?: number; modelSelection?: { instanceId: string; model: string; connectionId?: string } }>;
  threadIdsForBot(botId: string, includeActiveDuplicate?: boolean): readonly string[];
  projectBotForTask(botId: string, threadId: string): { modelSelection?: { instanceId: string; model: string; connectionId?: string } } | null;
}
/** ReflectDeps.bots for the server (index.ts pipReflectDeps): every bot with its threads, continuity settings and route stamp. */
export function reflectBotsOf(store: ReflectStoreView): () => ReflectBot[] {
  return () => store.bots.map(bot => {
    const threadIds = store.threadIdsForBot(bot.id, true), options = bot.continuityOptions;
    // 1.0.22 idle: the route choice a doubled reflect recheck is bound to (read only while one gates)
    const routeStamp = () => reflectRouteStamp({ threadIds, options }, t => (store.projectBotForTask(bot.id, t) ?? store.bots.find(x => x.id === bot.id))?.modelSelection);
    return { id: bot.id, name: bot.name, threadIds, continuity: bot.continuity === true, options, settingsGeneration: bot.continuityGeneration, routeStamp };
  });
}

const identityCache = new Map<string, { at: number; value: string }>();
async function cachedBinaryIdentity(path: string): Promise<string> {
  const hit = identityCache.get(path);
  if (hit && Date.now() - hit.at < 300_000) return hit.value;
  const value = await binaryIdentity(path);
  identityCache.set(path, { at: Date.now(), value });
  return value;
}

export function createResolveRoute(host: RouteHost) {
  return async (bot: ReflectBot, threadId: string): Promise<ResolvedRoute> => {
    const selection = host.modelSelectionOf(bot, threadId);
    // reflectModel is restricted to the speaking route's own connection: the connection never changes.
    let model = bot.options?.reflectModel ?? selection.model;
    const { instance, providerRoute: speakingRoute } = host.turnRouting(bot, threadId);
    const offered = selection.connectionId ? host.connectionModels?.(selection.connectionId) : instance.models.options.map(m => m.id);
    if (bot.options?.reflectModel && !offered?.includes(model)) throw new Error("Choose a reflection model from this connection.");
    const providerRoute = speakingRoute ? { ...speakingRoute, model } : undefined;
    const prepared = instance.adapter.prepareTextOnlyTurn?.(model, providerRoute);
    if (prepared) model = prepared.model;
    const engine = CLI_ENGINE[instance.driverKind];
    const path = engine ? instance.adapter.textOnlyExecutable?.() ?? host.binaryPath(engine) : undefined;
    const pre = engine ? preflightRoute(engine) : undefined;
    const fingerprint = routeFingerprint({
      instanceId: selection.instanceId, model, connectionId: selection.connectionId ?? null,
      connectionRevision: selection.connectionId ? host.connectionRevision(selection.connectionId) : null,
      adapterKind: instance.driverKind, binaryIdentity: path && pre?.ok ? await cachedBinaryIdentity(path) : null, managedConfigIdentity: pre?.identity ?? null,
    });
    const adapter = instance.adapter;
    const base = { fingerprint, engine: instance.displayName ?? instance.driverKind, kind: (engine ? "cli" : "http") as "cli" | "http", model, providerRoute };
    if (!adapter.capabilities.textOnlyTurn || !adapter.textOnlyTurn) return { ...base, unsupported: { reason: "no-text-only-turn" } };
    if (pre && !pre.ok) return { ...base, unsupported: { reason: pre.verdict.reason, detail: pre.verdict.detail } };
    return { ...base, probeRequired: Boolean(engine), textOnlyTurn: (input) => {
      const turn = { ...input, cwd: host.botFolderOf?.(bot, threadId) };
      return prepared ? prepared.turn(turn) : adapter.textOnlyTurn!(turn);
    } };
  };
}
