// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What a shared bot looks like on the wire (SPEC-X 12.3).
//
// `sharedWith` is an owner-only reach field and `partitionedAt` says when a
// bot started keeping separate work: the desktop sees both. Every other
// surface (the paired phone, the browser door, the local MCP server) gets
// neither. It gets `shared` (is this bot shared with other teams) and, for
// the owner's phone only, `sharedRows`: one row per covered team with the
// work thread when it exists. Both are derived here, never stored.
//
// `wireBot` and `wireTask` in index.ts spread whatever fields a record has,
// so a field is stripped by naming it, here, rather than by forgetting it.
import { database } from "./database.ts";
import type { BotRecord, Store, TaskRecord } from "./store.ts";
import { sectionKey, isIndividualAssistant, isWorkspaceChief } from "./store.ts";
import { sharedWithTeam } from "./execution-audience.ts";
import { teamChangeOpen, teamIdFor, teamLabel } from "./team-identities.ts";

/** `teamId` is null for a team that has no identity yet: an `all`-mode bot
 * covers it by its label, and the owner's first open mints it (3.1). */
export interface SharedRow { teamId: string | null; teamName: string; threadId: string | null; working: boolean; waiting: number }
export interface SharingTeam { id: string; name: string; covered: boolean; selectable: boolean; reason?: "home" | "assistants" }
/** A team as a read sees it: no id until something mints one. */
type TeamView = Omit<SharingTeam, "id"> & { id: string | null };

function liveIdentity(label: string): string | undefined {
  const row = database().prepare("SELECT team_id FROM team_identities WHERE label=? AND retired_at IS NULL").get(label);
  return row ? String(row.team_id) : undefined;
}

/** Every named team a bot could be shared with, in name order: each label a
 * bot or channel carries and each live identity. General is never a team for
 * sharing. With `mint`, a team with no identity yet gets one (SPEC-X 3.1
 * mints when sharing names a team), except while a rename or delete is
 * finishing or when the label is too long to be an identity. Without it,
 * nothing is written: an unminted team keeps a null id and is covered only
 * by `all` mode. */
function teamViews(store: Pick<Store, "bots" | "groups">, bot: BotRecord, mint: boolean): TeamView[] {
  const labels = new Set<string>([
    ...store.bots.map(b => sectionKey(b.section)),
    ...store.groups.filter(g => !g.dm).map(g => sectionKey(g.section)),
    ...database().prepare("SELECT label FROM team_identities WHERE retired_at IS NULL").all().map(row => String(row.label)),
  ]);
  labels.delete("");
  const open = mint && teamChangeOpen();
  return [...labels].sort((a, b) => a.localeCompare(b)).flatMap(label => {
    const id = liveIdentity(label) ?? (mint && !open && label.length <= 60 ? teamIdFor(label) : undefined);
    if (!id && mint) return [];
    const members = store.bots.filter(b => sectionKey(b.section) === label);
    const reason = label === sectionKey(bot.section) ? "home" as const : members.length && members.every(isIndividualAssistant) ? "assistants" as const : undefined;
    const covered = !reason && (id ? sharedWithTeam(bot, id) : bot.sharedWith?.mode === "all" && !isIndividualAssistant(bot) && !isWorkspaceChief(bot));
    return [{ id: id ?? null, name: label, covered, selectable: !reason, ...(reason ? { reason } : {}) }];
  });
}

/** The teams the owner's sharing routes choose from; this is where a named
 * team gets its identity. */
export function sharingTeams(store: Pick<Store, "bots" | "groups">, bot: BotRecord): SharingTeam[] {
  return teamViews(store, bot, true) as SharingTeam[];
}

/** The same teams, read only: for every read and broadcast path (a wire bot,
 * a frame, Team settings), which never mint. */
export function sharingTeamsRead(store: Pick<Store, "bots" | "groups">, bot: BotRecord): TeamView[] {
  return teamViews(store, bot, false);
}

/** The phone's rows for one bot: every team it is shared with right now, and
 * the owner's work thread for that team when one exists (null before the
 * first open, which `all` mode makes the usual case). */
export function sharedRowsFor(store: Pick<Store, "bots" | "groups">, bot: BotRecord): SharedRow[] {
  if (!bot.sharedWith || bot.sharedWith.mode === "none") return [];
  const count = database().prepare("SELECT sum(state='queued') AS waiting, sum(state IN ('running','waiting_bot','waiting_owner')) AS working FROM room_requests WHERE to_bot_id=? AND target_thread_id=?");
  return sharingTeamsRead(store, bot).filter(team => team.covered).map(team => {
    const task = team.id ? bot.tasks?.find(item => item.sharedWork?.teamId === team.id && !item.sharedWork.quarantined) : undefined;
    const load = task ? count.get(bot.id, task.threadId) : undefined;
    return { teamId: team.id, teamName: team.name, threadId: task?.threadId ?? null, working: Number(load?.working ?? 0) > 0 || task?.busy === true, waiting: Number(load?.waiting ?? 0) };
  });
}

/** A task's work-thread marker as any client sees it: the team and whether
 * the thread is closed, never the finishing request's ids. */
export function wireSharedWork(work: NonNullable<TaskRecord["sharedWork"]>) {
  return { teamId: work.teamId, teamName: teamLabel(work.teamId) ?? "", createdAt: work.createdAt,
    ...(work.closedAt !== undefined ? { closedAt: work.closedAt, closedReason: work.closedReason } : {}) };
}

type WireBotShape = { id: string; sharedWith?: unknown; partitionedAt?: unknown };
/** What every wire bot carries about sharing, the desktop's included: is it
 * shared, and the owner's rows. */
export function sharingWire(bot: BotRecord, store: Pick<Store, "bots" | "groups">): { shared: boolean; sharedRows: SharedRow[] } {
  const shared = !!bot.sharedWith && bot.sharedWith.mode !== "none";
  return { shared, sharedRows: shared ? sharedRowsFor(store, bot) : [] };
}

/** A desktop wire bot as a surface that is not the desktop receives it. */
export function remoteWireBot<T extends WireBotShape>(wire: T, store: Pick<Store, "bots" | "groups" | "bot">, owner: boolean): Omit<T, "sharedWith" | "partitionedAt"> & { shared: boolean; sharedRows: SharedRow[] } {
  const { sharedWith: _sharedWith, partitionedAt: _partitionedAt, ...rest } = wire;
  const bot = store.bot(wire.id);
  const shared = !!bot?.sharedWith && bot.sharedWith.mode !== "none";
  return { ...rest, shared, sharedRows: owner && bot && shared ? sharedRowsFor(store, bot) : [] };
}

const isBotShape = (value: Record<string, unknown>) =>
  typeof value.id === "string" && typeof value.threadId === "string" && typeof value.name === "string" && typeof value.modelSelection === "object" && value.modelSelection !== null;

/** Every bot inside a response body, projected for a surface that is not the
 * desktop. Transcripts are passed through untouched (a message is never a
 * bot); the walk is shallow because every route nests bots at most under a
 * list or one wrapper object. */
export function remoteBody(body: unknown, store: Pick<Store, "bots" | "groups" | "bot">, owner: boolean, depth = 0): unknown {
  if (depth > 4 || body === null || typeof body !== "object") return body;
  if (Array.isArray(body)) {
    const items = body.map(item => remoteBody(item, store, owner, depth + 1));
    return items.some((item, index) => item !== body[index]) ? items : body;
  }
  const record = body as Record<string, unknown>;
  if (isBotShape(record)) return remoteWireBot(record as WireBotShape, store, owner);
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const next = key === "messages" ? value : remoteBody(value, store, owner, depth + 1);
    if (next !== value) changed = true;
    out[key] = next;
  }
  return changed ? out : body;
}

/** A `bot` frame as a scoped stream receives it (live and replay); any other
 * frame as is. */
export function scopedBotFrame(frame: string, store: Pick<Store, "bots" | "groups" | "bot">, owner: boolean): string {
  const match = /^(id: [^\n]*\n)?data: (.*)\n\n$/s.exec(frame);
  if (!match || !match[2].startsWith('{"kind":"bot"')) return frame;
  const payload = JSON.parse(match[2]) as { bot?: WireBotShape };
  if (!payload.bot) return frame;
  return `${match[1] ?? ""}data: ${JSON.stringify({ ...payload, bot: remoteWireBot(payload.bot, store, owner) })}\n\n`;
}
