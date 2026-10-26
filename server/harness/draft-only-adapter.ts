// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one choke point for draft-only turns (server/draft-only.ts, DRAFT-ONLY-ALLOWLIST-104.md section 3). The registry wraps
// every live instance with this decorator, outermost, so every engine call the server makes (direct turns, routines, rooms, the
// phone, mentions, the Chief's proposal, steers, prewarm) reaches it. A turn is draft-only when it says so or when the resolver
// (installed by index.ts) reads a draft-only bot behind its thread. Such a turn runs only on a qualifying engine mode, cut down
// to its one read surface; on any other engine it is refused before the engine is called.
import type { ProviderAdapter, ProviderInstance, SendTurnInput } from "../contracts.ts";
import { DRAFT_ONLY_PROMPT, draftOnlyQualifies, DraftOnlyRefused, type DraftOnlySurface } from "../draft-only.ts";

/** Whether a draft-only bot is behind this thread (or this turn's bot). Installed by index.ts; with none installed only the
 *  turn's own flag counts. */
export type DraftOnlyResolver = (threadId: string, botId?: string) => boolean;
let resolver: DraftOnlyResolver = () => false;
export function setDraftOnlyResolver(next: DraftOnlyResolver): void { resolver = next; }

export function turnIsDraftOnly(turn: Pick<SendTurnInput, "threadId" | "draftOnly" | "warmIdentity">): boolean {
  return turn.draftOnly === true || resolver(turn.threadId, turn.warmIdentity?.botId);
}

/** The turn a qualifying engine receives: marked draft-only, with no working folder or extra folders, the draft-only note in
 *  its system text, and its integrations cut to the surface's one read mount (Claude: Murage's connected-app relay, which
 *  admits only verified reads for a draft-only bot; chat-completions: none). */
export function draftOnlyTurnInput(turn: SendTurnInput, surface: DraftOnlySurface): SendTurnInput {
  const connector = surface === "claude-toolless" ? turn.integrations?.composio : undefined;
  const { addDirs: _addDirs, integrations: _integrations, cwd: _cwd, ...rest } = turn;
  return {
    ...rest,
    draftOnly: true,
    system: turn.system ? `${turn.system}\n\n${DRAFT_ONLY_PROMPT}` : DRAFT_ONLY_PROMPT,
    ...(connector ? { integrations: { composio: connector } } : {}),
  };
}

export function decorateDraftOnlyInstance(live: ProviderInstance): ProviderInstance {
  const original = live.adapter;
  const verdict = () => draftOnlyQualifies({ driverKind: live.driverKind, cloudHome: process.env.MURAGE_CLOUD_ROLE === "home" });
  const sendTurn: ProviderAdapter["sendTurn"] = async (input) => {
    if (!turnIsDraftOnly(input)) return original.sendTurn(input);
    const judged = verdict();
    if (!judged.ok) throw new DraftOnlyRefused(judged.line);
    return original.sendTurn(draftOnlyTurnInput(input, judged.surface));
  };
  // A steer into a draft-only thread on an engine that does not qualify is not delivered. On a qualifying engine it is text
  // into the running draft-only turn, whose process was started toolless.
  const steer: ProviderAdapter["steer"] = original.steer
    ? async (threadId, text, beforeWrite, interjectionId) => {
      if (resolver(threadId) && !verdict().ok) return false;
      return original.steer!(threadId, text, beforeWrite, interjectionId);
    }
    : undefined;
  // A prewarm replays the input the engine remembered from its last turn (the decorated one for a draft-only thread), and the
  // Claude driver re-reads its launch facts before that spawn too; an engine that does not qualify warms nothing for it.
  const prewarm: ProviderAdapter["prewarm"] = original.prewarm
    ? async (threadId) => (resolver(threadId) && !verdict().ok ? false : original.prewarm!(threadId))
    : undefined;
  const adapter = new Proxy(original, {
    get(target, property) {
      if (property === "sendTurn") return sendTurn;
      if (property === "steer") return steer;
      if (property === "prewarm") return prewarm;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ProviderAdapter;
  return new Proxy(live, {
    get(target, property) {
      if (property === "adapter") return adapter;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
