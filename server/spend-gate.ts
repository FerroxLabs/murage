// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pause Flux use at 100% of the owner's monthly limit (UX-L2C-PAUSE r5 + r6 + r7, FINAL design, on Flux's FLAT body).
//
// ONE account-level figure from Flux: `account_spent_usd_this_month` on GET /v1/key/limits, with `account_id`. Murage never
// sums per-key counters. The pause sits behind a capability check; with the capability OFF the product is exactly the
// 1.0.18/1.0.19 heads-up meter (flux-limits.ts), unchanged.
//
// Two kinds of evidence, judged independently per body (r5 section 0, r6 4.3):
//   * KEY evidence: the flat key fields (key_id, key_monthly_budget_usd, key_monthly_token_limit, spent_usd_this_month,
//     tokens_this_month, spend_basis, resets_at, the bot group) stamped by the live `as_of`. Clears refusals, arms the capability read.
//   * ACCOUNT evidence: account_id, month, account_spent_usd_this_month, account_as_of (Flux caches this group up to 30 s).
//     It orders only the account figure (F). A null figure is "unknown", never 0. F only rises inside a month.
// Two identities, never mixed (r6 1): `credId` (durable, no epoch; persisted; membership, refusal scope and coverage) and
// `reqGen` (memory only; drops an answer whose credential or config moved while it was in flight).
// Wire names live in FLUX_FIELDS and BOT_FIELDS ONLY (contract frozen at key-limits-v1, 2731cf18). Fixtures in spend-gate.test.ts are SYNTHETIC until Flux ships staging bytes.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { FLUX_KEY_LIMITS_URL, fluxKeyFingerprint, spendBasisAccepted } from "./flux-limits.ts";
import { fluxUsageHeaders } from "./flux-usage-tags.ts";

export const FLUX_FIELDS = {
  keyId: "key_id",
  keyBudget: "key_monthly_budget_usd",
  tokenLimit: "key_monthly_token_limit",
  spent: "spent_usd_this_month",
  tokens: "tokens_this_month",
  basis: "spend_basis",
  resetsAt: "resets_at",
  asOf: "as_of",
  accountId: "account_id",
  month: "month",
  accountSpent: "account_spent_usd_this_month",
  accountAsOf: "account_as_of",
  // 402 key_budget_reached
  limit: "limit",
  manageUrl: "manage_url",
} as const;

/** FROZEN contract (key-limits-v1, 2731cf18): the 200 carries the bot group for bot keys only (4 dp, summed across the bot's keys).
 *  The 402 for `bot_monthly_spend` carries bot_id and bot_monthly_budget_usd; its spent_usd_this_month IS the bot's sum (no bot_spent field).
 *  The 200 group is all present or all absent; a partial group is not key evidence. */
export const BOT_FIELDS = { id: "bot_id", budget: "bot_monthly_budget_usd", spent: "bot_spent_usd_this_month" } as const;

/** r6 7.1: while the pause is ON and L is set, a failed read (timeout, network, 401, 403, 503, malformed, a null figure, an unbound answer) holds new Flux starts as `unknown`. A constant, not a setting. */
export const FAILED_READ_HOLDS_UNKNOWN = true;

/** r6 7.4: the held-work lines and cards ship in the 1.0.19 renderer. Until that card is in the build the server keeps the pause
 *  pinned OFF (heads-up meter only): no hold without words on screen. Flip when the renderer card lands. */
export const PAUSE_RENDERER_CARD_SHIPPED = false;

export type FluxLimitKind = "monthly_spend" | "bot_monthly_spend" | "monthly_tokens";
const LIMIT_KINDS: readonly string[] = ["monthly_spend", "bot_monthly_spend", "monthly_tokens"];
const utcMonth = (ms: number): string => new Date(ms).toISOString().slice(0, 7);
const money = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const stampMs = (v: unknown): number | null => (typeof v === "string" && v.trim() !== "" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** durable credential identity: no epoch, no revision (r6 1). A fingerprint, never the key. */
export const credIdOf = (key: string): string => createHash("sha256").update(`murage-flux-cred\0${key.trim()}`).digest("hex").slice(0, 16);

export interface BotEvidence { botId: string; budgetUsd: number | null; spentUsd: number }
export interface KeyEvidence { keyId: string; budgetUsd: number | null; spentUsd: number; tokenLimit: number | null; tokens: number | null; bot: BotEvidence | null }
export interface AccountFigure { accountId: string; month: string; asOfMs: number; spentUsd: number }
/** r6 4.1/4.2: `absent` = the four account fields are all absent (legacy Flux); `figureNull` = the identity is valid and the figure is null (ledger unreadable). */
export type AccountState =
  | { state: "valid"; figure: AccountFigure }
  | { state: "figureNull"; accountId: string; asOfMs: number }
  | { state: "noAccount" }
  | { state: "absent" }
  | { state: "malformed" };
export interface DecodedLimits { asOfMs: number; account: AccountState; key: KeyEvidence | null }

/**
 * The one decoder of a flat GET /v1/key/limits 200 body. null = not a JSON object, or no valid `as_of` (it stamps the key
 * figures and must be present for any accepted body, r6 4.1). The key group and the account group are judged on their own.
 */
export function decodeLimitsBody(body: unknown): DecodedLimits | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const raw = body as Record<string, unknown>;
  const asOfMs = stampMs(raw[FLUX_FIELDS.asOf]);
  if (asOfMs === null) return null;
  // An unknown spend_basis makes the WHOLE reading pending: no key figure and no account figure may come from it.
  if (!spendBasisAccepted(raw[FLUX_FIELDS.basis])) return null;

  const names = [FLUX_FIELDS.accountId, FLUX_FIELDS.month, FLUX_FIELDS.accountSpent, FLUX_FIELDS.accountAsOf];
  let account: AccountState;
  if (names.every((n) => raw[n] === undefined)) account = { state: "absent" };
  else {
    const id = raw[FLUX_FIELDS.accountId];
    const month = raw[FLUX_FIELDS.month];
    const nullish = (v: unknown) => v === null || v === undefined;
    const accountAsOfMs = stampMs(raw[FLUX_FIELDS.accountAsOf]);
    const figureRaw = raw[FLUX_FIELDS.accountSpent];
    const identityOk = typeof id === "string" && id.trim() !== "" && accountAsOfMs !== null && typeof month === "string" && MONTH.test(month) && month === utcMonth(accountAsOfMs);
    // frozen contract (a): a key with no account is a 200 with account_id null and the account figures null: unknown, never 0
    if (id === null && nullish(month) && nullish(figureRaw) && nullish(raw[FLUX_FIELDS.accountAsOf])) account = { state: "noAccount" };
    else if (!identityOk) account = { state: "malformed" };
    else if (figureRaw === null) account = { state: "figureNull", accountId: id as string, asOfMs: accountAsOfMs as number };
    else if (money(figureRaw) === null) account = { state: "malformed" };
    else account = { state: "valid", figure: { accountId: id as string, month: month as string, asOfMs: accountAsOfMs as number, spentUsd: money(figureRaw) as number } };
  }

  let key: KeyEvidence | null = null;
  const keyId = raw[FLUX_FIELDS.keyId];
  const spent = money(raw[FLUX_FIELDS.spent]);
  const budget = raw[FLUX_FIELDS.keyBudget];
  const tokenLimit = raw[FLUX_FIELDS.tokenLimit];
  const tokens = raw[FLUX_FIELDS.tokens];
  const optMoney = (v: unknown): boolean => v === undefined || v === null || money(v) !== null;
  const botPresent = [BOT_FIELDS.id, BOT_FIELDS.budget, BOT_FIELDS.spent].map((n) => raw[n] !== undefined);
  const botAny = botPresent.some(Boolean);
  const botAll = botPresent.every(Boolean);
  const botId = raw[BOT_FIELDS.id];
  const botBudget = money(raw[BOT_FIELDS.budget]);
  const botSpent = money(raw[BOT_FIELDS.spent]);
  // a null bot budget is "no bot cap" (Flux 13-bot-key-no-bot-budget), not unknown; a present-but-invalid one is still malformed
  const botBudgetOk = raw[BOT_FIELDS.budget] === null || botBudget !== null;
  const botOk = !botAny || (botAll && typeof botId === "string" && botId.trim() !== "" && botBudgetOk && botSpent !== null);
  if (typeof keyId === "string" && keyId.trim() !== "" && spent !== null && stampMs(raw[FLUX_FIELDS.resetsAt]) !== null
    && optMoney(budget) && optMoney(tokenLimit) && optMoney(tokens) && botOk) {
    key = {
      keyId, spentUsd: spent, budgetUsd: money(budget), tokenLimit: money(tokenLimit), tokens: money(tokens),
      bot: botAny ? { botId: botId as string, budgetUsd: botBudget, spentUsd: botSpent as number } : null,
    };
  }
  return { asOfMs, account, key };
}

export interface Decoded402 {
  limit: FluxLimitKind; keyId: string | null; botId: string | null; resetsAt: string | null; manageUrl: string | null;
  budget: number | null; spent: number | null;
  /** the 402's account_id. It carries no month, so it may scope a bot refusal; its account figure is never read (r7 1). */
  accountId: string | null;
}

/** The one decoder of a 402 key_budget_reached body (flat fields plus account_id, account_spent_usd_this_month, account_as_of; NO as_of: the key figures are live at refusal time). The account figure is ignored by design (r7 1). */
export function decode402Body(body: unknown): Decoded402 | null {
  // Flux's real 402 (F5 fixture 12) is {"error":{...,"provider_specific_fields":{flat fields}}}; the older shapes (detail wrapper, bare flat body) still decode.
  // The marker must sit exactly where Flux puts it: the flat/detail payload's `error`, or the nested provider_specific_fields.error, or the wrapper error.code/type. A body carrying only `limit` is not a budget refusal.
  const MARKER = "key_budget_reached";
  const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
  const top = obj(body);
  if (!top) return null;
  const wrapper = obj(top.error);
  const nested = wrapper ? obj(wrapper.provider_specific_fields) : null;
  let detail: unknown;
  let marked: boolean;
  if (nested) { detail = nested; marked = nested.error === MARKER || wrapper?.code === MARKER || wrapper?.type === MARKER; }
  else if (obj(top.detail)) { detail = top.detail; marked = (detail as Record<string, unknown>).error === MARKER; }
  else { detail = top; marked = top.error === MARKER; }
  if (!marked) return null;
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return null;
  const raw = detail as Record<string, unknown>;
  const limit = raw[FLUX_FIELDS.limit];
  if (typeof limit !== "string" || !LIMIT_KINDS.includes(limit)) return null;
  const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const kind = limit as FluxLimitKind;
  return {
    limit: kind, keyId: str(raw[FLUX_FIELDS.keyId]), botId: str(raw[BOT_FIELDS.id]), resetsAt: str(raw[FLUX_FIELDS.resetsAt]), manageUrl: str(raw[FLUX_FIELDS.manageUrl]),
    budget: num(kind === "monthly_spend" ? raw[FLUX_FIELDS.keyBudget] : kind === "bot_monthly_spend" ? raw[BOT_FIELDS.budget] : raw[FLUX_FIELDS.tokenLimit]),
    spent: num(kind === "monthly_spend" || kind === "bot_monthly_spend" ? raw[FLUX_FIELDS.spent] : raw[FLUX_FIELDS.tokens]),
    accountId: str(raw[FLUX_FIELDS.accountId]),
  };
}

/** One credential read. 401 = revoked or expired key; anything else (403, 404, 503, network, bad body) = failed. There is no 403 key_has_no_account: a key with no account is a 200 with account_id null. */
export type AccountRead = { kind: "body"; decoded: DecodedLimits } | { kind: "unauthorized" } | { kind: "failed" };
export type AccountReader = (key: string) => Promise<AccountRead>;

export function createAccountReader(fetchImpl: typeof fetch = fetch): AccountReader {
  return async (key) => {
    try {
      const response = await fetchImpl(FLUX_KEY_LIMITS_URL, {
        headers: { authorization: `Bearer ${key.trim()}`, accept: "application/json", ...fluxUsageHeaders({ feature: "other" }) },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 401) { void response.body?.cancel().catch(() => {}); return { kind: "unauthorized" }; }
      if (!response.ok) { void response.body?.cancel().catch(() => {}); return { kind: "failed" }; }
      const decoded = decodeLimitsBody(await response.json().catch(() => null));
      return decoded ? { kind: "body", decoded } : { kind: "failed" };
    } catch {
      return { kind: "failed" };
    }
  };
}

// ----------------------------------------------------------------- state ----

export interface SpendCredential {
  id: string;
  /** `account` = fluxKey(); the others can dispatch a Flux call too (email bot keys `bot:<botId>`, enabled provider-bank Flux rows). */
  kind: "account" | "email-bot" | "bank";
  key: () => string | null;
  /** reqGen part for a non-account credential: a bank row's `revision`, an email bot key's secret version. Memory only. */
  gen?: () => string | number | null;
}

export type SpendHold =
  | { kind: "limit" }
  | { kind: "unknown"; otherAccount?: boolean; noAccount?: boolean }
  | { kind: "flux"; limit: FluxLimitKind };

export interface Refusal {
  limit: FluxLimitKind;
  /** `key:<credId>`, `bot:<account_id>:<bot_id>` or `botc:<credId>:<bot_id>` (r6 2) */
  scope: string;
  /** when the 402 arrived (the 402 carries no as_of); the key figures are live at refusal time */
  asOf: string;
  resetsAt: string | null;
  month: string;
  budget: number | null;
  spent: number | null;
  manageUrl: string | null;
  /** the credential the 402 was sent with (durable fingerprint only), recorded at dispatch */
  credId: string | null;
  /** the 402's key_id, for display and the later-GET match (r6 2); the bot id for bot scopes */
  keyId?: string | null;
  botId?: string | null;
  seq: number;
}
export type RefusalBook = Record<string, Partial<Record<FluxLimitKind, Refusal>>>;

/** Persisted identity (r6 1). Fingerprints only, never a key. */
export interface AccountState_ { accountId: string | null; accountAsOf: string | null; capability: "on" | "off"; capAsOf: string | null; capCredId: string | null }
/** Persisted membership by durable credId (r6 2). Never a key. */
export type MembershipBook = Record<string, { accountId: string; asOf: string }>;

export type StartVerdict = { ok: true } | { ok: false; holds: SpendHold[]; retry: "queue" | "never" };

export class SpendGateRefusal extends Error {
  readonly code = "spend_limit";
  // no parameter property: the server runs under Node's strip-only TypeScript mode, which refuses it (the packaged boot failed on it)
  readonly holds: SpendHold[];
  constructor(holds: SpendHold[]) { super(describeHolds(holds).lines.join(" ")); this.holds = holds; }
}

const SETTLE_REFRESH_MS = 1000;
const RECHECK_MS = 60_000;

export interface SpendGateOptions {
  credentials: () => SpendCredential[];
  limitUsd: () => number | null;
  read?: AccountReader;
  /** the account key's config epoch (config.ts fluxKeyEpoch): part of reqGen only, never of credId */
  epoch?: () => number;
  /** default PAUSE_RENDERER_CARD_SHIPPED: false pins the pause OFF (the heads-up meter is the whole product) */
  enabled?: boolean;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  loadRefusals?: () => RefusalBook;
  saveRefusals?: (book: RefusalBook) => void;
  loadAccount?: () => AccountState_ | null;
  saveAccount?: (state: AccountState_) => void;
  loadMembership?: () => MembershipBook;
  saveMembership?: (book: MembershipBook) => void;
  /** A hold on any scope cleared: pump the dispatchers, replay the outbox. */
  wake?: () => void;
  /** The pause turned ON to OFF: raise the "heads-up only for now" card. */
  onCapabilityOff?: () => void;
}

interface Entitlement { turnKey: string; accountId: string; capGen: number }
type Ingested = "valid" | "absent" | "failed" | "ignored" | "dropped";

export function createSpendGate(options: SpendGateOptions) {
  const enabled = options.enabled ?? PAUSE_RENDERER_CARD_SHIPPED;
  const read = options.read ?? createAccountReader();
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
  const epoch = options.epoch ?? (() => 0);
  const persisted = options.loadAccount?.() ?? null;
  const accountCredential = (): SpendCredential | null => options.credentials().find((c) => c.kind === "account") ?? null;
  const accountKeyNow = (): string | null => accountCredential()?.key()?.trim() || null;
  const credNow = (): string | null => { const k = accountKeyNow(); return k ? credIdOf(k) : null; };
  const credIdFor = (credential: SpendCredential): string | null => { const k = credential.key()?.trim(); return k ? credIdOf(k) : null; };
  /** reqGen: this request's binding. Account key: fluxKeyFingerprint(key, epoch); others: credId + the row revision. */
  const reqGenOf = (credential: SpendCredential): string => {
    const k = credential.key()?.trim() || null;
    if (!k) return "none";
    return credential.kind === "account" ? `acct:${fluxKeyFingerprint(k, epoch())}` : `${credIdOf(k)}:${credential.gen?.() ?? ""}`;
  };

  // Boot (r6 1): a restart never moves ON to OFF. Only a current capability read with the fields absent does.
  // Lazy: the credential list is wired in index.ts before every dependency it reads exists, so it must not be read while the gate is built.
  let account: AccountState_ = { accountId: null, accountAsOf: null, capability: "off", capAsOf: null, capCredId: null };
  /** The latest capability read could not give a figure (boot with a persisted ON, 401/503, a bad body, a null figure, another account). */
  let figureUnreadable = false;
  let accountKeyNoAccount = false;
  let booted = false;
  function boot(): void {
    if (booted) return;
    booted = true;
    const cred = credNow();
    account = { ...account, capCredId: cred };
    if (persisted) {
      if (persisted.capability === "on" && cred !== null) {
        // same key: ON, F empty. A key changed while Murage was down: ON with the intentional switch applied, account re-adopted by the first read.
        account = persisted.capCredId === cred ? { ...persisted } : { accountId: null, accountAsOf: null, capability: "on", capAsOf: null, capCredId: cred };
        figureUnreadable = true;
      } else if (persisted.capability === "on") { account = { ...persisted }; figureUnreadable = true; }
      else account = persisted.capCredId === cred || cred === null ? { ...persisted, capability: "off" } : { accountId: null, accountAsOf: null, capability: "off", capAsOf: null, capCredId: cred };
    }
    pruneMembers();
  }
  let figure: AccountFigure | null = null;
  let capGen = 0;
  let lastCapSeq = Number.NEGATIVE_INFINITY;
  let headsUpOnlyNotice = false;
  /** persisted: credId -> the account its reads named (r6 2). Never overwritten by a different id. */
  let members: MembershipBook = { ...(options.loadMembership?.() ?? {}) };
  const conflicts = new Set<string>();
  const lastKey = new Map<string, { seq: number; asOfMs: number }>();
  let book: RefusalBook = options.loadRefusals?.() ?? {};
  let seq = Math.max(0, ...Object.values(book).flatMap((r) => Object.values(r).map((x) => x?.seq ?? 0)));
  let tail: Promise<unknown> = Promise.resolve();
  let lastSettleRefresh = Number.NEGATIVE_INFINITY;
  let settleTimer: unknown = null;
  let lastRoundAt = Number.NEGATIVE_INFINITY;
  const entitlements = new Map<string, Entitlement>();
  const byTurn = new Map<string, string>();
  const als = new AsyncLocalStorage<string>();

  const limit = () => { const v = options.limitUsd(); return typeof v === "number" && v > 0 ? v : null; };
  const saveBook = () => options.saveRefusals?.(book);
  const saveAccount = () => options.saveAccount?.({ ...account });
  const saveMembers = () => options.saveMembership?.({ ...members });
  const on = () => account.capability === "on";

  /** Keep membership only for credIds still configured, plus those a live refusal record names (r6 2). */
  function pruneMembers(): void {
    const keep = new Set<string>();
    for (const c of options.credentials()) { const id = credIdFor(c); if (id) keep.add(id); }
    for (const kinds of Object.values(book)) for (const r of Object.values(kinds)) if (r?.credId) keep.add(r.credId);
    const next = Object.fromEntries(Object.entries(members).filter(([id]) => keep.has(id)));
    if (Object.keys(next).length !== Object.keys(members).length) { members = next; saveMembers(); }
  }

  /** The owner saved a different Flux key: under the coordinator lock, void everything bound to the old account (r5 1.4, r6 1). */
  function syncKey(): void {
    const cred = credNow();
    if (cred === null || cred === account.capCredId) return;
    const first = account.capCredId === null;
    account = { accountId: first ? account.accountId : null, accountAsOf: null, capability: account.capability, capAsOf: first ? account.capAsOf : null, capCredId: cred };
    if (!first) { capGen++; entitlements.clear(); byTurn.clear(); figure = null; figureUnreadable = on(); accountKeyNoAccount = false; lastCapSeq = Number.NEGATIVE_INFINITY; }
    saveAccount();
  }

  function setCapabilityOn(): void {
    if (on()) return;
    account = { ...account, capability: "on" }; capGen++; saveAccount();
  }
  /** ON to OFF in one step: persist, void authorizations, release limit/unknown (wake), keep every flux refusal, raise the card. */
  function setCapabilityOff(): void {
    if (!on()) { figure = null; figureUnreadable = false; return; }
    account = { ...account, capability: "off" }; capGen++; entitlements.clear(); byTurn.clear();
    figure = null; figureUnreadable = false; headsUpOnlyNotice = true; saveAccount();
    options.onCapabilityOff?.();
  }

  const accountOfCred = (credId: string): string | null => members[credId]?.accountId ?? null;
  /** r6 2 coverage, from persisted facts only: `key:` and `botc:` by credId; `bot:` by membership account or the record's own credId. */
  const coveredBy = (refusal: Refusal, credId: string | null): boolean => {
    if (credId === null) return false;
    if (refusal.scope.startsWith("botc:")) return refusal.scope.split(":")[1] === credId;
    if (refusal.scope.startsWith("bot:")) return accountOfCred(credId) === refusal.scope.split(":")[1] || refusal.credId === credId;
    return refusal.scope === `key:${credId}`;
  };

  /** Clearing (r5 1.3, r6 2, r6 7.3): valid ordered KEY evidence sent after the refusal, on a covered credential. Token refusals clear on a later read;
   *  bot refusals when the bot group names the same bot with headroom, else at the month rollover. */
  function clearRefusals(credId: string, evidence: KeyEvidence, asOfMs: number, sentAtSeq: number): void {
    let changed = false;
    for (const [scope, kinds] of Object.entries(book)) {
      for (const [kind, refusal] of Object.entries(kinds) as Array<[FluxLimitKind, Refusal]>) {
        if (refusal.seq > sentAtSeq || !coveredBy(refusal, credId)) continue;
        if (refusal.keyId && scope.startsWith("key:") && evidence.keyId !== refusal.keyId) continue; // a different key_id is a failed read, never a clear
        const rolled = utcMonth(asOfMs) > refusal.month;
        let headroom = false;
        { // ordered by request sequence only (frozen contract (b): the 402 has no as_of)
          if (kind === "monthly_spend") headroom = scope.startsWith("key:") && (evidence.budgetUsd === null || evidence.spentUsd < evidence.budgetUsd);
          else if (kind === "monthly_tokens") headroom = scope.startsWith("key:") && (evidence.tokenLimit === null || (evidence.tokens !== null && evidence.tokens < evidence.tokenLimit));
          else headroom = evidence.bot !== null && evidence.bot.botId === refusal.botId && (evidence.bot.budgetUsd === null || evidence.bot.spentUsd < evidence.bot.budgetUsd);
        }
        if (rolled || headroom) { delete kinds[kind]; changed = true; }
      }
      if (Object.keys(kinds).length === 0) delete book[scope];
    }
    if (changed) saveBook();
  }

  /** Membership discovery (r7 2): written whenever a bound response names a valid account_id for a credId with no entry; never overwritten. false = a different id (a failed account read). */
  function writeMembership(credId: string, accountId: string, asOfMs: number): boolean {
    const have = members[credId];
    if (have) return have.accountId === accountId;
    members = { ...members, [credId]: { accountId, asOf: new Date(asOfMs).toISOString() } };
    saveMembers();
    return true;
  }

  /** F moves only on valid account evidence for the current account, ordered by `account_as_of`; inside a month it only rises; a later month replaces it. */
  function applyFigure(f: AccountFigure): void {
    if (account.accountId === null || f.accountId !== account.accountId) return;
    if (figure && f.month < figure.month) return;
    if (figure && f.month === figure.month) {
      if (f.asOfMs <= figure.asOfMs) return;
      figure = { ...f, spentUsd: Math.max(f.spentUsd, figure.spentUsd) };
    } else figure = f;
    account = { ...account, accountAsOf: new Date(f.asOfMs).toISOString() }; saveAccount();
  }

  /** Take one answer for `credential` into the state. `bound` is the reqGen it was sent under. */
  function ingest(credential: SpendCredential, key: string, result: AccountRead, sentSeq: number, bound: string): Ingested {
    if (reqGenOf(credential) !== bound) return "dropped"; // the credential or its config moved while Flux answered
    const credId = credIdOf(key);
    const isAccount = credential.kind === "account";
    if (result.kind !== "body") {
      if (isAccount) { figureUnreadable = true; accountKeyNoAccount = false; }
      return "failed";
    }
    if (isAccount) accountKeyNoAccount = false;
    const d = result.decoded;
    const a = d.account;
    const ke = d.key;

    // KEY evidence: ordered by request sequence and the live as_of per credential
    const last = lastKey.get(credId);
    const keyOk = ke !== null && sentSeq > (last?.seq ?? Number.NEGATIVE_INFINITY) && d.asOfMs > (last?.asOfMs ?? Number.NEGATIVE_INFINITY);
    if (keyOk && ke) { lastKey.set(credId, { seq: sentSeq, asOfMs: d.asOfMs }); clearRefusals(credId, ke, d.asOfMs, sentSeq); }

    // MEMBERSHIP: independent of account_as_of ordering and of a null figure (r7 2)
    if (a.state === "valid" || a.state === "figureNull") {
      const id = a.state === "valid" ? a.figure.accountId : a.accountId;
      if (!writeMembership(credId, id, a.state === "valid" ? a.figure.asOfMs : a.asOfMs)) {
        conflicts.add(credId); if (isAccount) figureUnreadable = true; return "failed"; // a different account_id for a known credential: never overwritten
      }
      conflicts.delete(credId);
    }

    if (!isAccount) {
      if (a.state === "valid" && on()) applyFigure(a.figure);
      return a.state === "valid" ? "valid" : a.state === "absent" ? "absent" : "failed";
    }

    // CAPABILITY read (r6 7.2): the account key, bound to the current reqGen (checked above), valid key evidence, a newer request
    // sequence than the last applied capability read, and a key as_of strictly newer than the persisted capAsOf. account_as_of never orders it.
    const capAsOfMs = account.capAsOf ? Date.parse(account.capAsOf) : Number.NEGATIVE_INFINITY;
    const capOk = keyOk && sentSeq > lastCapSeq && d.asOfMs > capAsOfMs;
    if (capOk) {
      if (a.state === "absent") {
        lastCapSeq = sentSeq; account = { ...account, capAsOf: new Date(d.asOfMs).toISOString() }; saveAccount(); setCapabilityOff();
        return "absent";
      }
      if (a.state !== "valid") { figureUnreadable = true; accountKeyNoAccount = a.state === "noAccount"; return "failed"; } // no account, figure null or malformed: capability unchanged
      if (account.accountId !== null && account.accountId !== a.figure.accountId) { figureUnreadable = true; return "failed"; } // same key, other account: never adopted
      lastCapSeq = sentSeq;
      account = { ...account, accountId: a.figure.accountId, capAsOf: new Date(d.asOfMs).toISOString() };
      setCapabilityOn(); saveAccount();
      figureUnreadable = false;
      applyFigure(a.figure);
      return "valid";
    }
    if (a.state === "valid" && on() && account.accountId === a.figure.accountId) applyFigure(a.figure); // account ordering still applies to F
    if (ke === null) { if (a.state !== "valid" && a.state !== "absent") figureUnreadable = true; return a.state === "absent" ? "ignored" : "failed"; }
    return "ignored";
  }

  async function readOne(credential: SpendCredential, key: string): Promise<Ingested> {
    const sentSeq = ++seq;
    const bound = reqGenOf(credential);
    return ingest(credential, key, await read(key), sentSeq, bound);
  }

  /** One capability read of the account key, serialized behind earlier rounds. */
  function accountRound(): Promise<Ingested> {
    const run = async (): Promise<Ingested> => {
      syncKey();
      const credential = accountCredential();
      const key = credential?.key()?.trim();
      if (!credential || !key) return "failed";
      lastRoundAt = now();
      return readOne(credential, key);
    };
    const next = tail.then(run, run);
    tail = next.catch(() => {});
    return next;
  }

  async function memberRead(credential: SpendCredential): Promise<void> {
    const key = credential.key()?.trim();
    if (key) await readOne(credential, key);
  }

  const refusalHolds = (credential: SpendCredential): SpendHold[] => {
    const credId = credIdFor(credential);
    const out: SpendHold[] = [];
    for (const kinds of Object.values(book)) for (const r of Object.values(kinds)) if (r && coveredBy(r, credId)) out.push({ kind: "flux", limit: r.limit });
    return out.slice(0, 1);
  };

  /** Holds on work billed to this credential, from the state as it stands. Synchronous. */
  function holdsFor(credential: SpendCredential): SpendHold[] {
    const holds: SpendHold[] = [];
    const L = limit();
    if (on() && L !== null) {
      const credId = credIdFor(credential);
      let unknown: Extract<SpendHold, { kind: "unknown" }> | null = null;
      if (figure && figure.spentUsd >= L) holds.push({ kind: "limit" });
      if ((figureUnreadable && FAILED_READ_HOLDS_UNKNOWN) || !figure) unknown = credential.kind === "account" && accountKeyNoAccount ? { kind: "unknown", noAccount: true } : { kind: "unknown" };
      if (credential.kind !== "account") {
        const accountId = credId ? accountOfCred(credId) : null;
        if (accountId === null || (credId && conflicts.has(credId))) unknown = unknown ?? { kind: "unknown" };
        else if (accountId !== account.accountId) unknown = { kind: "unknown", otherAccount: true };
      } else if (credId && conflicts.has(credId)) unknown = unknown ?? { kind: "unknown" };
      if (unknown) holds.push(unknown);
    }
    return [...holds, ...refusalHolds(credential)];
  }

  const holdCount = (): number => options.credentials().reduce((n, c) => n + holdsFor(c).length, 0);
  const verdict = (holds: SpendHold[], ownerDirect = false): StartVerdict => holds.length === 0 ? { ok: true } : { ok: false, holds, retry: ownerDirect ? "never" : "queue" };

  async function refresh(): Promise<void> {
    const before = holdCount();
    await accountRound();
    for (const c of options.credentials()) {
      if (c.kind === "account") continue;
      if ((on() && limit() !== null) || refusalHolds(c).length > 0) await memberRead(c);
    }
    if (holdCount() < before) options.wake?.();
  }

  const credentialFor = (key: string | null | undefined): SpendCredential | null => {
    const creds = options.credentials();
    if (!key) return creds.find((c) => c.kind === "account") ?? null;
    return creds.find((c) => c.key() === key) ?? { id: `key:${credIdOf(key)}`, kind: "bank", key: () => key };
  };

  async function admitStart(key: string | null | undefined, input: { ownerDirect?: boolean } = {}): Promise<StartVerdict> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const credential = credentialFor(key);
      if (!credential) return { ok: true };
      syncKey();
      const startGen = capGen;
      const armed = holdsFor(credential);
      const recheck = now() - lastRoundAt >= RECHECK_MS;
      if (armed.some((h) => h.kind === "flux" || (h.kind === "limit" && !recheck))) return verdict(armed, input.ownerDirect);
      if (limit() === null) return { ok: true };
      const round = await accountRound();
      // an authorization minted under another capability generation is void: go round again (r5 1.1 activation)
      if (capGen !== startGen) continue;
      if (!on()) return verdict(refusalHolds(credential), input.ownerDirect);
      if (round === "failed" || round === "dropped") return verdict([{ kind: "unknown" }, ...refusalHolds(credential)], input.ownerDirect);
      if (credential.kind !== "account") { const id = credIdFor(credential); if (id && members[id] === undefined) await memberRead(credential); }
      if (capGen !== startGen) continue;
      return verdict(holdsFor(credential), input.ownerDirect);
    }
    return verdict([{ kind: "unknown" }], input.ownerDirect);
  }

  /** A turn's permission: bound to its account and capability generation, and still valid for THIS dispatch credential (r5 1.2). */
  function entitledFor(key: string | null | undefined): boolean {
    const token = als.getStore();
    const ent = token ? entitlements.get(token) : undefined;
    if (!ent || ent.capGen !== capGen || !on() || account.accountId !== ent.accountId) return false;
    const credential = credentialFor(key);
    const id = credential ? credIdFor(credential) : null;
    return id !== null && members[id]?.accountId === ent.accountId;
  }

  const gate = {
    capability: (): "on" | "off" => account.capability,
    capabilityGeneration: (): number => capGen,
    account: (): AccountState_ => ({ ...account }),
    membership: (): MembershipBook => ({ ...members }),
    figure: (): AccountFigure | null => figure,
    holds: holdsFor,
    holdsById(credentialId: string): SpendHold[] { const c = options.credentials().find((x) => x.id === credentialId); return c ? holdsFor(c) : []; },
    refusals: (): RefusalBook => book,
    headsUpOnlyNotice: (): boolean => headsUpOnlyNotice,
    dismissNotice(): void { headsUpOnlyNotice = false; },
    admitStart,

    /** A Flux-route turn began (capability ON): its permission is bound to the account it was admitted against. */
    enterTurn(turnKey: string): void {
      const old = byTurn.get(turnKey); if (old) entitlements.delete(old);
      if (!on() || account.accountId === null) return;
      const token = `${turnKey}#${capGen}#${seq}#${entitlements.size}`;
      entitlements.set(token, { turnKey, accountId: account.accountId, capGen }); byTurn.set(turnKey, token); als.enterWith(token);
    },
    endTurn(turnKey: string): void { const token = byTurn.get(turnKey); if (token) { entitlements.delete(token); byTurn.delete(turnKey); } },
    runEntitled<T>(turnKey: string, fn: () => T): T {
      if (!on() || account.accountId === null) return fn();
      const token = `${turnKey}#run${capGen}#${entitlements.size}#${seq}`;
      entitlements.set(token, { turnKey, accountId: account.accountId, capGen });
      return als.run(token, fn);
    },
    entitled: entitledFor,

    /**
     * Every Flux dispatch calls this right before its fetch, with the key it is about to send (null = the account key); the
     * gate turns it into the credId of that credential. Entitled only when the turn's permission is live, current and matches
     * this credential's account; otherwise a start. Throws SpendGateRefusal.
     */
    async authorizeFluxDispatch(key?: string | null): Promise<void> {
      if (entitledFor(key)) return;
      const outcome = await admitStart(key);
      if (!outcome.ok) throw new SpendGateRefusal(outcome.holds);
    },

    /** A Flux operation settled: refresh and evaluate holds, at most once a second (a trailing refresh covers the rest). */
    onSettled(): void {
      if (limit() === null && !on() && Object.keys(book).length === 0) return;
      const t = now();
      if (t - lastSettleRefresh >= SETTLE_REFRESH_MS) { lastSettleRefresh = t; void refresh().catch(() => {}); return; }
      if (settleTimer) return;
      settleTimer = setTimer(() => { settleTimer = null; lastSettleRefresh = now(); void refresh().catch(() => {}); }, Math.max(0, lastSettleRefresh + SETTLE_REFRESH_MS - t));
    },

    /** The owner saved/raised/lowered/removed L, a key or bank row changed, boot, or Check again. */
    refreshAll: refresh,
    credentialsChanged(): void { syncKey(); pruneMembers(); },

    /**
     * 402 key_budget_reached from a request sent with `key` (null = the account key). It ARMS the scoped refusal from its own
     * flat fields and does nothing else (r7 1): its account figure never updates F, never writes membership, never changes the
     * capability. Its account_id (fixed per key, no month) may scope a bot refusal. After a 402 the next admission round reads F from a GET.
     */
    onBudgetReached(body: unknown, key?: string | null): { armed: boolean } {
      const d = decode402Body(body);
      if (!d) return { armed: false };
      const credential = credentialFor(key);
      const credId = credential ? credIdFor(credential) : null;
      const acct = d.accountId ?? (credId ? accountOfCred(credId) : null);
      let scope: string | null = null;
      if (d.limit === "bot_monthly_spend") { if (d.botId) scope = acct ? `bot:${acct}:${d.botId}` : credId ? `botc:${credId}:${d.botId}` : null; }
      else scope = credId ? `key:${credId}` : null;
      if (!scope) return { armed: false };
      const entry: Refusal = {
        limit: d.limit, scope, asOf: new Date(now()).toISOString(), resetsAt: d.resetsAt, month: utcMonth(now()),
        budget: d.budget, spent: d.spent, manageUrl: d.manageUrl, credId, keyId: d.keyId, botId: d.limit === "bot_monthly_spend" ? d.botId : null, seq: ++seq,
      };
      book[scope] = { ...(book[scope] ?? {}), [entry.limit]: entry }; saveBook(); // ordered by request sequence: the newest arrival wins
      return { armed: true };
    },
  };
  for (const name of Object.keys(gate) as Array<keyof typeof gate>) {
    const original = gate[name] as unknown;
    if (typeof original === "function") (gate as Record<string, unknown>)[name] = (...args: unknown[]) => { boot(); return (original as (...a: unknown[]) => unknown)(...args); };
  }
  if (enabled) return gate;
  // Pinned OFF until the renderer card ships (r6 7.4): the gate holds nothing, reads nothing, records nothing.
  const none: StartVerdict = { ok: true };
  return {
    ...gate,
    capability: (): "on" | "off" => "off",
    holds: (): SpendHold[] => [],
    holdsById: (): SpendHold[] => [],
    refusals: (): RefusalBook => ({}),
    headsUpOnlyNotice: (): boolean => false,
    admitStart: async (): Promise<StartVerdict> => none,
    enterTurn: (): void => {},
    runEntitled: <T,>(_turnKey: string, fn: () => T): T => fn(),
    entitled: (): boolean => false,
    authorizeFluxDispatch: async (): Promise<void> => {},
    onSettled: (): void => {},
    refreshAll: async (): Promise<void> => {},
    credentialsChanged: (): void => {},
    onBudgetReached: (): { armed: boolean } => ({ armed: false }),
  };
}

export type SpendGate = ReturnType<typeof createSpendGate>;

// ------------------------------------------------------------------ copy ----

import l2c from "../src/locales/en-ux/l2c.json" with { type: "json" };

const strings = l2c as Record<string, string>;
const fill = (key: string, values: Record<string, string> = {}): string =>
  (strings[key] ?? key).replace(/\{(\w+)\}/g, (_m, name: string) => values[name] ?? "");

export type PauseAction = "raise" | "check" | "openFlux";

/**
 * r4 2.3: the line names EVERY hold on the work, in the order limit, unknown, flux, and offers only actions that can
 * clear all of them. "Raise limit" only when `limit` is the only hold. `botName` + `emailOnly`: the work is one email
 * bot's, and no account-key work shares its bot_id.
 */
export function describeHolds(holds: SpendHold[], context: { limitText?: string; botName?: string; emailOnly?: boolean } = {}): { lines: string[]; actions: PauseAction[] } {
  const lines: string[] = [];
  const actions = new Set<PauseAction>();
  const has = (kind: SpendHold["kind"]) => holds.find((h) => h.kind === kind);
  const limitHold = has("limit");
  const unknown = has("unknown") as Extract<SpendHold, { kind: "unknown" }> | undefined;
  const flux = has("flux") as Extract<SpendHold, { kind: "flux" }> | undefined;
  if (limitHold) lines.push(fill("ux.l2c.pause.limit", { limit: context.limitText ?? "monthly" }));
  if (unknown) lines.push(fill(unknown.noAccount ? "ux.l2c.pause.noAccount.line" : unknown.otherAccount ? "ux.l2c.pause.otherAccount" : "ux.l2c.pause.unknown"));
  if (flux) lines.push(fill(limitHold || unknown ? "ux.l2c.pause.fluxAlso" : flux.limit === "monthly_tokens" ? "ux.l2c.pause.fluxTokens" : flux.limit === "bot_monthly_spend" ? "ux.l2c.pause.fluxBot" : "ux.l2c.pause.fluxKey"));
  if (context.botName && holds.length) lines.push(fill(context.emailOnly ? "ux.l2c.pause.emailOnly" : "ux.l2c.pause.botWaits", { bot: context.botName }));
  if (limitHold && holds.length === 1) { actions.add("raise"); actions.add("check"); }
  if (unknown) actions.add("check");
  if (flux || unknown?.otherAccount || unknown?.noAccount) actions.add("openFlux");
  return { lines, actions: (["raise", "check", "openFlux"] as const).filter((a) => actions.has(a)) };
}
