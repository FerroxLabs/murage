// M6 routes (owner: M6 lane). designs/settings-chat-1023/DESIGN.md sections 2, 4 and 5.
// Owner card routes: GET /api/settings-chat/cards/:id, POST .../:id/apply, POST .../:id/dismiss.
// Internal handlers: POST /api/internal/settings-chat/find and /show, mounted INSIDE the /api/internal block so the
// block's retired-token, generation and requireActiveInternal checks run first. Mount lines and policy entries are core's
// (WIRING.md); this file never reads thread, bot, origin or generation from a body.
import { z } from "zod";
import type { NoLimitsOrigin } from "../no-limits-origin.ts";
import { cloudRouteDecision, DESKTOP_ONLY_SENTENCE, routeAdmits, routePolicy, type RouteCaller } from "../route-policy.ts";
import type { CloudScope } from "../cloud-sessions.ts";
import {
  FIND_MAX, NOT_KNOWN_YET, OPEN_TO_SEE, plainReason, SHOW_CAP_PER_TURN,
  type ApplyRefusal, type JournalLookup, type SettingCardRecord, type SettingCardView, type ToolRefusal, type WriterTarget,
} from "../../shared/settings-chat.ts";
import { chatClass, writerFor, type CatalogInputs, type WriterEntry } from "./catalog.ts";
import type { CardStore } from "./cards.ts";
import { readSetting, READERS, type Reader, type ReaderBot } from "./readers.ts";

export const CLOUD_NEEDS_SETTINGS = "Open in Settings to change this here.";
export const NEEDS_SETTINGS = "Open in Settings to change this.";
export const VOICE_NOTE_OWNER_ONLY = "Ask me in a typed message and I can show it here.";

export interface ChatBot extends ReaderBot { name: string; archived?: boolean; threadId: string; tasks?: Array<{ id: string; threadId?: string; modelSelection?: unknown }> }
export type ThreadPlace = "owner" | "channel" | "group" | "other";
/** What the turn's trigger proved (index.ts reads it through ownerTurnText + decisionNoLimitsOrigin). */
export interface TurnOrigin {
  /** The trigger is a `user` text message with isOwnerOrigin(origin) (ownerTurnText). */
  ownerText: boolean;
  /** The trigger is an owner voice note (no text): fail closed with a typed-message line (Opus r2 L2). */
  ownerVoice?: boolean;
  noLimitsOrigin: NoLimitsOrigin;
  /** internalClaim.depth and internalEventId (Fable r2 L4): only a depth-0 turn with no internal event qualifies. */
  depth: number;
  internalEvent: boolean;
}
/** `generation` is internalClaim.generation / InternalCapabilities.activeGeneration(), a string (Astra 1fbb27906d). */
export interface InternalClaim { threadId: string; botId: string; generation: string }
/** The request's caller, as index.ts proved it. Never read from a body. */
export type CardCaller =
  | { kind: "local"; route: RouteCaller; surface: "desktop" | "phone" | "remote" }
  | { kind: "cloud"; scope: CloudScope | "owner-browser" | "remembered-owner" | "anonymous"; surface: "desktop" | "phone" | "remote" };
/** The writer's answer through its full handler path (Opus r2 M2). `stale` is SV0's stale-expect 409. */
export interface WriterAnswer { status: number; error?: string; stale?: boolean; live?: unknown }

export interface SettingsChatDeps {
  cards: CardStore;
  catalog: CatalogInputs;
  readers?: Readonly<Record<string, Reader>>;
  bot(botId: string): ChatBot | undefined;
  journal: { lookup(changeId: string): JournalLookup };
  activeGeneration(threadId: string): string | undefined;
  turnOrigin(threadId: string, generation: string): TurnOrigin | undefined;
  threadPlace(threadId: string): ThreadPlace;
  /** Is the writer's busy check true right now: the whole bot for the bot writer, that thread for the task writer (Fable r2 L3). */
  busy(bot: ChatBot, target: WriterTarget): boolean;
  postText(threadId: string, text: string): void;
  postCard(threadId: string, card: SettingCardRecord): void;
  /** Re-enters the writer's own HTTP handler with the caller's headers, the writer body, `expect` and `changeId`. */
  dispatchWriter(input: { method: string; path: string; body: Record<string, unknown>; expect: unknown; changeId: string }): Promise<WriterAnswer>;
}

type Answer = { status: number; body: unknown };
type Req = { method: string; path: string; readBody: (maxBytes: number) => Promise<unknown> };

const CARD_ROUTE = /^\/api\/settings-chat\/cards\/([\w-]{1,64})(?:\/(apply|dismiss))?$/;
const ApplyBody = z.object({ value: z.unknown(), expect: z.unknown(), cardGen: z.number().int().positive(), changeId: z.string().min(8).max(100) }).strict();
const DismissBody = z.object({}).strict();
const RefBody = z.object({ id: z.string().min(1).max(200), bot: z.string().max(100).optional(), account: z.string().max(200).optional(),
  device: z.string().max(200).optional(), item: z.string().max(200).optional(), code: z.string().max(100).optional() }).strict();
const FindBody = z.object({ query: z.string().min(1).max(200) }).strict();
const ShowBody = z.object({ settingRef: RefBody, reason: z.string().max(2000) }).strict();

const refuse = (status: number, code: ApplyRefusal, error: string, extra: Record<string, unknown> = {}): Answer =>
  ({ status, body: { ok: false, code, error, ...extra } });
const toolRefuse = (status: number, code: ToolRefusal, error: string): Answer => ({ status, body: { ok: false, code, error } });

/** The writer target a card in this thread uses (design section 3; Opus r2 H1). `multiDirect`: the bot's direct thread of a
 * bot with more than one task has no writer row, so it is `open` with no picker. */
export function deriveTarget(bot: ChatBot, threadId: string, settingId: string): { target: WriterTarget; multiDirect: boolean } {
  if (!settingId.startsWith("bot.")) return { target: { kind: "app" }, multiDirect: false };
  const tasks = bot.tasks ?? [];
  if (tasks.length <= 1) return { target: { kind: "bot" }, multiDirect: false };
  const task = tasks.find(row => row.threadId === threadId);
  return task ? { target: { kind: "task", taskId: task.id }, multiDirect: false } : { target: { kind: "bot" }, multiDirect: true };
}

const fillPath = (writer: WriterEntry, botId: string, target: WriterTarget) =>
  writer.path.replace(":botId", encodeURIComponent(botId)).replace(":taskId", target.kind === "task" ? encodeURIComponent(target.taskId) : "");

/** Authority, inner (design section 5): the writer route's own gates on the writer body, for this caller. Cloud inputs are named
 * (Opus r2 M1): the device scope, steppedUp=false, context={}; the card request's proof is never forwarded. */
export function innerGate(writer: WriterEntry, path: string, body: Record<string, unknown>, caller: CardCaller,
  decide: typeof cloudRouteDecision = cloudRouteDecision): { allow: true } | { allow: false; error: string } {
  if (writer.surface === "desktop" && caller.surface !== "desktop") return { allow: false, error: DESKTOP_ONLY_SENTENCE };
  if (caller.kind === "cloud") {
    const decision = decide(writer.method, path, caller.scope, body, false, {});
    return decision === "allow" ? { allow: true } : { allow: false, error: CLOUD_NEEDS_SETTINGS };
  }
  const entry = routePolicy(writer.method, path);
  if (!entry || !routeAdmits(entry.class, caller.route)) return { allow: false, error: DESKTOP_ONLY_SENTENCE };
  return { allow: true };
}

export function createSettingsChat(deps: SettingsChatDeps) {
  const readers = deps.readers ?? READERS;
  const scopeLine = (bot: ChatBot, target: WriterTarget, scope: string | undefined) =>
    target.kind === "task" ? "This chat's model" : target.kind === "bot" ? `${bot.name}'s model` : scope === "app" || scope === "every-bot" ? "Every bot" : "This chat";

  /** Withdrawn when the bot is gone or archived, the task is gone, the target no longer fits the bot, or the id dropped to `no`. */
  function withdrawnReason(card: SettingCardRecord, bot: ChatBot | undefined): string | undefined {
    if (!bot || bot.archived) return "bot";
    if (card.settingBot && card.settingBot !== card.botId) return "bot";
    if (card.writerTarget.kind === "task") { const id = card.writerTarget.taskId; if (!bot.tasks?.some(task => task.id === id)) return "task"; }
    if (card.writerTarget.kind === "bot" && (bot.tasks?.length ?? 0) > 1 && deriveTarget(bot, card.threadId, card.settingId).target.kind !== "bot") return "target";
    if (chatClass(card.settingId, card.writerTarget.kind, deps.catalog).class === "no") return "retired";
    return undefined;
  }

  function sweep(card: SettingCardRecord): SettingCardRecord {
    let current = deps.cards.readRepair(card, deps.journal.lookup);
    if (current.state === "OPEN" && withdrawnReason(current, deps.bot(current.botId))) current = deps.cards.settleSettingCard(current.cardId, "withdrawn")?.card ?? current;
    return current;
  }

  /** What the card draws for this caller right now. Render uses the same gate as apply, so the control matches the answer. */
  function view(card: SettingCardRecord, caller: CardCaller): SettingCardView & { busy: boolean } {
    const current = sweep(card);
    const bot = deps.bot(current.botId);
    const entry = chatClass(current.settingId, current.writerTarget.kind, deps.catalog);
    const base = { card: current, label: entry.label ?? current.settingId, path: entry.path ?? "", scopeLine: bot ? scopeLine(bot, current.writerTarget, entry.scope) : "" };
    const writer = writerFor(current.settingId, current.writerTarget.kind, deps.catalog);
    const multiDirect = bot ? deriveTarget(bot, current.threadId, current.settingId).multiDirect : false;
    const value = bot && entry.class === "inline" ? readSetting(current.settingId, { bot, target: current.writerTarget }, readers) : undefined;
    if (current.state !== "OPEN" || !bot || !writer || entry.class !== "inline" || multiDirect) return { ...base, control: "open", ...(multiDirect ? { controlNote: NEEDS_SETTINGS } : {}), busy: false };
    const gate = innerGate(writer, fillPath(writer, bot.id, current.writerTarget), writer.body(value), caller);
    if (!gate.allow) return { ...base, control: "open", controlNote: gate.error, busy: false };
    return { ...base, control: "inline", chatControl: writer.chatControl, value, expect: value, busy: deps.busy(bot, current.writerTarget) };
  }

  async function apply(card: SettingCardRecord, raw: unknown, caller: CardCaller): Promise<Answer> {
    const parsed = ApplyBody.safeParse(raw);
    if (!parsed.success) return refuse(400, "BAD_REQUEST", "That change could not be read.");
    const { value, expect, cardGen, changeId } = parsed.data;
    if (card.state === "SETTLED") {
      // a proven replay of this card's own change returns the first receipt; dedupe runs before the card fences (section 4 step 3)
      if (card.outcome === "changed" && card.changeId === changeId) return { status: 200, body: { ok: true, card, replay: true } };
      const prior = deps.journal.lookup(changeId);
      if (prior.state === "saved" && card.pendingChangeId === changeId) return { status: 200, body: { ok: true, card, replay: true } };
      if (prior.state === "couldNotCheck" && card.pendingChangeId === changeId) return refuse(503, "COULD_NOT_CHECK", "Could not check. Try again.", { card });
      const code = card.outcome === "superseded" ? "SUPERSEDED" : card.outcome === "withdrawn" ? "WITHDRAWN" : "SETTLED";
      return refuse(409, code, code === "SUPERSEDED" ? "See the newer card below." : "This card is closed.", { card });
    }
    deps.cards.setPending(card.cardId, changeId);
    // dedupe first: a saved change replays without comparing expect; a lookup that could not check writes nothing
    const found = deps.journal.lookup(changeId);
    if (found.state === "saved") {
      const settled = deps.cards.settleSettingCard(card.cardId, "changed", changeId);
      return settled?.won ? { status: 200, body: { ok: true, card: settled.card, replay: true } } : refuse(409, "SETTLED", "This card is closed.", { card: settled?.card });
    }
    if (found.state === "couldNotCheck") return refuse(503, "COULD_NOT_CHECK", "Could not check. Try again.", { card: deps.cards.get(card.cardId) });
    // card generation fence: the client's cardGen is this card's and no newer card exists for (thread, id, bot) (W5b). A show
    // that lands while the body is read is caught earlier: cardRoute re-reads the card, which is then SETTLED superseded.
    if (cardGen !== card.cardGen || cardGen !== deps.cards.currentGen(card.threadId, card.settingId, card.settingBot)) return refuse(409, "SUPERSEDED", "See the newer card below.", { card });
    // bot epoch, task and target: sweep() settled a withdrawn card before apply runs (cardRoute), so a SETTLED withdrawn card
    // is refused above; there is no second copy of that fence here (Astra 1fbb27906d: the copy was unreachable).
    const bot = deps.bot(card.botId);
    const writer = writerFor(card.settingId, card.writerTarget.kind, deps.catalog);
    const entry = chatClass(card.settingId, card.writerTarget.kind, deps.catalog);
    if (!bot || !writer || entry.class !== "inline" || deriveTarget(bot, card.threadId, card.settingId).multiDirect) return refuse(403, "NEEDS_SETTINGS", NEEDS_SETTINGS, { card });
    const path = fillPath(writer, bot.id, card.writerTarget);
    const body = writer.body(value);
    const gate = innerGate(writer, path, body, caller);
    if (!gate.allow) return refuse(403, "NEEDS_SETTINGS", gate.error, { card });
    const answer = await deps.dispatchWriter({ method: writer.method, path, body, expect, changeId });
    if (answer.status === 200) {
      const settled = deps.cards.settleSettingCard(card.cardId, "changed", changeId);
      return { status: 200, body: { ok: true, card: settled?.card ?? card, replay: false } };
    }
    const live = deps.cards.get(card.cardId) ?? card;
    if (answer.status === 409 && answer.stale) return refuse(409, "VALUE_CHANGED", "Changed elsewhere; nothing changed.", { card: live, live: answer.live });
    // any other writer refusal: the writer's own status and sentence; nothing written, the card stays OPEN
    return refuse(answer.status, "WRITER_REFUSED", answer.error ?? "That change was not made.", { card: live });
  }

  /** Owner card routes. `mayApprove` is index.ts's predicate for this request (desktop surface or ownerActs). */
  async function cardRoute(req: Req, request: { mayApprove: boolean; caller: CardCaller }): Promise<Answer | null> {
    const match = CARD_ROUTE.exec(req.path);
    if (!match) return null;
    const [, cardId, action] = match;
    if (action ? req.method !== "POST" : req.method !== "GET") return null;
    if (!request.mayApprove) return refuse(403, "NOT_OWNER", "Only the owner can change settings here.");
    const card = deps.cards.get(cardId!);
    if (!card) return refuse(404, "NOT_FOUND", "no such card");
    if (!action) return { status: 200, body: view(card, request.caller) };
    const raw = await req.readBody(4096);
    if (action === "dismiss") {
      if (!DismissBody.safeParse(raw ?? {}).success) return refuse(400, "BAD_REQUEST", "That could not be read.");
      const settled = deps.cards.settleSettingCard(sweep(card).cardId, "dismissed");
      return { status: 200, body: { ok: true, card: settled?.card ?? card } };
    }
    // the body read awaits: a dismiss, settle or newer card may have landed meanwhile, so apply acts on the record as it is now
    return apply(sweep(deps.cards.get(card.cardId) ?? card), raw, request.caller);
  }

  const qualifies = (origin: TurnOrigin | undefined) =>
    Boolean(origin && origin.ownerText && origin.noLimitsOrigin === "owner" && origin.depth === 0 && !origin.internalEvent);

  function find(claim: InternalClaim, raw: unknown): Answer {
    const parsed = FindBody.safeParse(raw);
    if (!parsed.success) return toolRefuse(400, "BAD_REQUEST", "find takes only {query}.");
    const words = parsed.data.query.toLowerCase().split(/\s+/).filter(Boolean);
    const bot = deps.bot(claim.botId);
    const withValues = qualifies(deps.turnOrigin(claim.threadId, claim.generation)) && Boolean(bot);
    const rows = deps.catalog.inventory
      .filter(record => !record.retired && !record.hidden)
      .map(record => ({ record, score: words.filter(word => `${record.label} ${record.path} ${record.id}`.toLowerCase().includes(word)).length }))
      .filter(row => row.score > 0)
      .sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id))
      .map(({ record }) => {
        const { target } = bot ? deriveTarget(bot, claim.threadId, record.id) : { target: { kind: "app" } as WriterTarget };
        const entry = chatClass(record.id, target.kind, deps.catalog);
        const ref = { id: record.id, ...(record.id.startsWith("bot.") ? { bot: claim.botId } : {}), code: "chat" };
        const row: Record<string, unknown> = { settingRef: ref, label: record.label, path: record.path, scope: record.scope, shownAs: entry.class, ...(entry.class === "inline" ? {} : { why: entry.reasons[0] }) };
        if (withValues && entry.class === "inline") row.value = readSetting(record.id, { bot: bot!, target }, readers) ?? OPEN_TO_SEE;
        else if (withValues) row.valueNote = OPEN_TO_SEE;
        return { entry, row };
      })
      .filter(({ entry }) => entry.class !== "no")
      .slice(0, FIND_MAX)
      .map(({ row }) => row);
    return { status: 200, body: { ok: true, settings: rows } };
  }

  function show(claim: InternalClaim, raw: unknown): Answer {
    const parsed = ShowBody.safeParse(raw);
    if (!parsed.success) return toolRefuse(400, "BAD_REQUEST", "show takes only {settingRef, reason}.");
    if (deps.activeGeneration(claim.threadId) !== claim.generation) return toolRefuse(401, "OWNER_ONLY", "This turn has ended.");
    const origin = deps.turnOrigin(claim.threadId, claim.generation);
    const channelOwner = origin?.noLimitsOrigin === "owner-channel";
    if (!qualifies(origin) && !channelOwner) return toolRefuse(403, "OWNER_ONLY", origin?.ownerVoice ? VOICE_NOTE_OWNER_ONLY : "Only the owner's own typed message can bring a setting into this chat.");
    const ref = parsed.data.settingRef;
    if (ref.bot !== undefined && ref.bot !== claim.botId) return toolRefuse(403, "NOT_THIS_BOT", "You can only show your own settings.");
    const bot = deps.bot(claim.botId);
    if (!bot || bot.archived) return toolRefuse(403, "NOT_THIS_BOT", "This bot is not active.");
    const { target } = deriveTarget(bot, claim.threadId, ref.id);
    const entry = chatClass(ref.id, target.kind, deps.catalog);
    if (entry.class === "no") return toolRefuse(404, "NO_HOME", `That setting cannot be shown here: ${entry.reasons[0]}.`);
    const place = deps.threadPlace(claim.threadId);
    if (place !== "owner" || channelOwner) {
      deps.postText(claim.threadId, `${entry.label}: Settings > ${(entry.path ?? "").replace(/^Settings\s*>\s*/, "")}`);
      return { status: 200, body: { ok: true, shown: "text" } };
    }
    if (deps.cards.showsInTurn(claim.threadId, claim.generation) >= SHOW_CAP_PER_TURN) return toolRefuse(429, "CARD_CAP", "You can show at most 3 settings in one reply.");
    const settingBot = ref.id.startsWith("bot.") ? claim.botId : undefined;
    const card = deps.cards.create({ threadId: claim.threadId, botId: claim.botId, generation: claim.generation, settingId: ref.id, settingBot, writerTarget: target, reason: plainReason(parsed.data.reason) });
    deps.postCard(claim.threadId, card);
    return { status: 200, body: { ok: true, shown: entry.class, cardId: card.cardId, value: entry.class === "inline" ? readSetting(ref.id, { bot, target }, readers) ?? NOT_KNOWN_YET : undefined } };
  }

  /** Internal handlers. index.ts calls this inside the /api/internal block after requireActiveInternal(), with the claim. */
  async function internalRoute(req: Req, claim: InternalClaim): Promise<Answer | null> {
    if (req.method !== "POST") return null;
    if (req.path !== "/api/internal/settings-chat/find" && req.path !== "/api/internal/settings-chat/show") return null;
    const raw = await req.readBody(8192);
    return req.path.endsWith("/find") ? find(claim, raw) : show(claim, raw);
  }

  return { cardRoute, internalRoute, view, sweep };
}
