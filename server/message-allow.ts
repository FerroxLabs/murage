// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "Who this bot can message" (SPEC-P 3.12, contract 4.3; lane E1).
//
// Outside a project, bot A may ask or message bot B iff `canReach(A, B)`
// (its own team, its lead, the Chief chart; unchanged) or A's owner-set
// `messageAllow` lists B. `all` (Everyone) and `list` (picked bots) widen it; `team` and absent both mean `canReach` alone, so
// this field only ever widens reach, which is why it is an owner-only field:
// set on the desktop, reset by a restore, never carried by a template, a
// package or an import. Narrowing is train 2.
//
// Inside an owner-only project, membership decides (plan 3.2): any member
// may ask or message any other member of that project for project work,
// derived from membership at dispatch and checked again when it runs.
import { z } from "zod";
import { canStartContact } from "../shared/reach.ts";
import type { BotRecord, GroupRecord } from "./store.ts";

export type MessageAllow = NonNullable<BotRecord["messageAllow"]>;

/** At most this many named bots (the field is a short owner list). */
export const MESSAGE_ALLOW_MAX_BOTS = 50;

export const messageAllowBodySchema = z.object({
  mode: z.enum(["team", "all", "list"]),
  botIds: z.array(z.string().regex(/^[\w-]+$/)).max(MESSAGE_ALLOW_MAX_BOTS).optional(),
  /** Explicit direction changes only: a bot id to "one-way" or "two-way". Absent = leave every other bot's own setting alone. */
  directions: z.record(z.string().regex(/^[\w-]+$/), z.enum(["one-way", "two-way"])).optional(),
}).strict();

/** The stored value for a validated body: `team` is the default, so absent.
 * Ids of deleted bots are dropped rather than refused, and `grantedBy` keeps
 * only the entries still listed. */
export function normalizeMessageAllow(body: Pick<z.infer<typeof messageAllowBodySchema>, "mode" | "botIds">, self: string, known: (id: string) => boolean, previous?: MessageAllow): MessageAllow | undefined | { error: string } {
  if (body.mode === "team") {
    if (body.botIds?.length) return { error: "botIds are only for a list" };
    return undefined;
  }
  if (body.mode === "all") {
    if (body.botIds?.length) return { error: "botIds are only for a list" };
    return { mode: "all" };
  }
  const requested = [...new Set(body.botIds ?? [])];
  if (requested.includes(self)) return { error: "a bot cannot list itself" };
  const ids = requested.filter(known);
  const grantedBy = (previous?.mode === "list" ? previous.grantedBy ?? [] : []).filter((id) => ids.includes(id));
  return { mode: "list", botIds: ids, ...(grantedBy.length ? { grantedBy } : {}) };
}

/** Whether a thread runs without a proven, present owner (webhook, channel,
 * routine, or an unattended chain). Set once by the harness; "Everyone" never
 * widens such a turn, so automation keeps the narrower team rule. */
let automationProbe: (botId: string, threadId: string) => boolean = () => false;
export function setAutomationProbe(probe: (botId: string, threadId: string) => boolean): void { automationProbe = probe; }
export function isAutomationThread(botId: string, threadId: string | undefined): boolean { return threadId !== undefined && automationProbe(botId, threadId); }

/** Both bots are members of this project room (and it is a project). */
export function projectCoMembers(group: GroupRecord | undefined, fromId: string, toId: string): boolean {
  return Boolean(group && !group.dm && group.channelProject && group.memberIds.includes(fromId) && group.memberIds.includes(toId));
}

/** May `from` ask or message `to`? `projectRoom` is the project room the
 * asking turn runs in, when the turn is the owner's audience. */
export function mayMessage(from: BotRecord, to: BotRecord, options: { projectRoom?: GroupRecord; ownerAudience?: boolean } = {}): boolean {
  if (from.id === to.id) return false;
  if (options.projectRoom && projectCoMembers(options.projectRoom, from.id, to.id)) return true;
  return canStartContact(from, to, { ownerAudience: options.ownerAudience });
}

/** The bots a Can talk to value names, out of `bots`. */
export function targetsOf(self: BotRecord, bots: BotRecord[]): BotRecord[] {
  const others = bots.filter((b) => b.id !== self.id && !b.hidden);
  if (self.messageAllow?.mode === "all") return others;
  if (self.messageAllow?.mode === "list") return others.filter((b) => self.messageAllow!.botIds?.includes(b.id));
  return [];
}

/** The grants an owner's edit of `self` writes onto OTHER bots; returns the new
 * `messageAllow` per changed bot (undefined = back to team).
 *  - a target removed from the picks (or My team chosen) loses only a grant
 *    this control created (`grantedBy` names `self`), never an independent one;
 *  - an explicit "two-way" adds `self` to the target's picks, marked as created
 *    by `self`; "one-way" removes only such a created grant;
 *  - with no explicit direction, other bots are left alone (adding a pick never
 *    deletes anything). */
export function reverseGrantPatches(self: BotRecord, before: BotRecord[], after: BotRecord[], directions: Record<string, "one-way" | "two-way"> = {}): Map<string, MessageAllow | undefined> {
  const out = new Map<string, MessageAllow | undefined>();
  const current = (t: BotRecord): MessageAllow | undefined => out.has(t.id) ? out.get(t.id) : t.messageAllow;
  const created = (t: BotRecord) => { const m = current(t); return m?.mode === "list" && (m.grantedBy ?? []).includes(self.id); };
  const revoke = (t: BotRecord) => {
    const m = current(t);
    if (m?.mode !== "list") return;
    const botIds = (m.botIds ?? []).filter((id) => id !== self.id), grantedBy = (m.grantedBy ?? []).filter((id) => id !== self.id);
    out.set(t.id, botIds.length ? { mode: "list", botIds, ...(grantedBy.length ? { grantedBy } : {}) } : undefined);
  };
  const afterIds = new Set(after.map((t) => t.id));
  for (const t of before) if (!afterIds.has(t.id) && created(t)) revoke(t);
  for (const t of after) {
    const want = directions[t.id];
    if (!want || t.messageAllow?.mode === "all") continue;
    if (want === "one-way") { if (created(t)) revoke(t); continue; }
    if (canStartContact(t, self)) continue;
    const m = current(t);
    const botIds = m?.mode === "list" ? m.botIds ?? [] : [];
    const grantedBy = m?.mode === "list" ? m.grantedBy ?? [] : [];
    out.set(t.id, { mode: "list", botIds: [...botIds, self.id], grantedBy: [...grantedBy, self.id] });
  }
  return out;
}
