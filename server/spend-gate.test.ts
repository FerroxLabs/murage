// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX-L2C-PAUSE r5 + r6 + r7 (FINAL design) on Flux's FLAT GET /v1/key/limits body.
// EVERY fixture below is SYNTHETIC: built from the frozen contract (key-limits-v1, 2731cf18), not from real Flux staging bytes.
// Replace with FluxMain's real bytes when they arrive. Frozen deltas: no 403 key_has_no_account (a keyless-of-account key is a 200 with
// account_id null and the account figures null); the 402 has account_as_of and NO as_of; the 402 bot spend is spent_usd_this_month.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BOT_FIELDS, createAccountReader, createSpendGate, credIdOf, decode402Body, decodeLimitsBody, describeHolds, FAILED_READ_HOLDS_UNKNOWN,
  FLUX_FIELDS, PAUSE_RENDERER_CARD_SHIPPED, SpendGateRefusal,
  type AccountRead, type AccountState_, type MembershipBook, type RefusalBook, type SpendCredential,
} from "./spend-gate.ts";

const NOV = Date.parse("2026-11-10T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
let clock = NOV;
const NOW0 = NOV;
/** a fresh, strictly newer stamp for every read that does not pin its own */
const tick = () => (clock += 1000);

interface BodyOpts {
  keyId?: string; budget?: number | null; spent?: number; tokenLimit?: number | null; tokens?: number | null;
  bot?: { id: string; budget: number; spent: number } | null;
  asOf?: number;
  /** null = leave the whole account group out (legacy Flux) */
  account?: string | null;
  /** frozen (a): the key is on no account: account_id and the account figures are null */
  noAccount?: boolean;
  acctSpent?: number | null; acctAsOf?: number; month?: string;
  drop?: string[];
  nested?: boolean;
}
/** SYNTHETIC flat 200 body (r6 contract): key figures, optional bot group, account group. */
const getBody = (o: BodyOpts = {}): Record<string, unknown> => {
  const asOf = o.asOf ?? tick();
  const acctAsOf = o.acctAsOf ?? asOf;
  const body: Record<string, unknown> = {
    key_id: o.keyId ?? "sk-flux1xyz", key_name: null, key_monthly_budget_usd: o.budget === undefined ? null : o.budget, key_monthly_token_limit: o.tokenLimit === undefined ? null : o.tokenLimit,
    spent_usd_this_month: o.spent ?? 1, tokens_this_month: o.tokens === undefined ? 10 : o.tokens, spend_basis: "customer_billed_sale", resets_at: "2026-12-01T00:00:00Z", as_of: iso(asOf),
  };
  if (o.bot) Object.assign(body, { [BOT_FIELDS.id]: o.bot.id, [BOT_FIELDS.budget]: o.bot.budget, [BOT_FIELDS.spent]: o.bot.spent });
  if (o.account !== null) Object.assign(body, { account_id: o.account ?? "acct_A", month: o.month ?? iso(acctAsOf).slice(0, 7), account_spent_usd_this_month: o.acctSpent === undefined ? 10 : o.acctSpent, account_as_of: iso(acctAsOf) });
  if (o.noAccount) Object.assign(body, { account_id: null, month: null, account_spent_usd_this_month: null, account_as_of: null });
  for (const name of o.drop ?? []) delete body[name];
  if (o.nested) { delete body.spent_usd_this_month; body.key = { key_id_prefix: "sk-flux1", max_budget_usd: null, spent_usd_this_month: 1 }; }
  return body;
};
const ok = (o: BodyOpts = {}): AccountRead => ({ kind: "body", decoded: decodeLimitsBody(getBody(o))! });
/** a read that stamps itself fresh every time it is taken */
const fresh = (o: BodyOpts = {}) => (): AccountRead => ok(o);

/** SYNTHETIC 402 key_budget_reached (frozen): flat fields, account_id, account_spent_usd_this_month, account_as_of. NO as_of. For a bot limit,
 *  bot_id and bot_monthly_budget_usd, and spent_usd_this_month carries the bot's sum (there is no bot_spent_usd_this_month). */
const body402 = (o: { account?: string | null; spent?: number | null; asOf?: number; limit?: string; keyId?: string; botId?: string } = {}) => ({
  error: "key_budget_reached", limit: o.limit ?? "monthly_spend", key_id: o.keyId ?? "sk-flux1xyz", key_name: null,
  key_monthly_budget_usd: 50, spent_usd_this_month: 50, spend_basis: "customer_billed_sale", resets_at: "2026-12-01T00:00:00Z", key_monthly_token_limit: 100, tokens_this_month: 100,
  manage_url: "https://fluxrouter.ai/keys",
  ...(o.account === null ? {} : { account_id: o.account ?? "acct_A" }),
  account_spent_usd_this_month: o.spent === undefined ? 60 : o.spent,
  account_as_of: iso(o.asOf ?? NOW0),
  ...(o.botId ? { [BOT_FIELDS.id]: o.botId, [BOT_FIELDS.budget]: 5, spent_usd_this_month: 5 } : {}),
});

const KEYS = { account: "sk-flux-account", email: "sk-flux-email-b1", bank: "sk-flux-bank-1" };
type Which = keyof typeof KEYS;

function harness(opts: { limit?: number | null; reads?: Record<string, AccountRead | (() => AccountRead)>; persisted?: AccountState_ | null; members?: MembershipBook; book?: RefusalBook; accountKey?: string } = {}) {
  const calls: string[] = [];
  const accountKey = { v: opts.accountKey ?? KEYS.account };
  const bankKey = { v: KEYS.bank };
  const bankRev = { v: "r1" };
  const epoch = { v: 0 };
  const creds: Record<"account" | "email" | "bank", SpendCredential> = {
    account: { id: "account", kind: "account", key: () => accountKey.v },
    email: { id: "bot:b1", kind: "email-bot", key: () => KEYS.email },
    bank: { id: "bank:1", kind: "bank", key: () => bankKey.v, gen: () => bankRev.v },
  };
  let limit = opts.limit === undefined ? 100 : opts.limit;
  const reads = { ...(opts.reads ?? {}) };
  let t = NOW0;
  const timers: Array<() => void> = [];
  let book: RefusalBook = opts.book ?? {};
  let saved: AccountState_ | null = opts.persisted ?? null;
  let members: MembershipBook = opts.members ?? {};
  let wakes = 0;
  let offs = 0;
  const gate = createSpendGate({
    credentials: () => [creds.account, creds.email, creds.bank],
    limitUsd: () => limit,
    enabled: true,
    epoch: () => epoch.v,
    read: async (key) => { calls.push(key); const r = reads[key]; return typeof r === "function" ? r() : r ?? { kind: "failed" }; },
    now: () => t,
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    loadRefusals: () => book,
    saveRefusals: (b) => { book = JSON.parse(JSON.stringify(b)); },
    loadAccount: () => saved,
    saveAccount: (s) => { saved = { ...s }; },
    loadMembership: () => members,
    saveMembership: (m) => { members = JSON.parse(JSON.stringify(m)); },
    wake: () => { wakes += 1; },
    onCapabilityOff: () => { offs += 1; },
  });
  return {
    gate, creds, accountKey, bankKey, bankRev, epoch, calls, reads, timers, setLimit: (v: number | null) => { limit = v; }, advance: (ms: number) => { t += ms; },
    book: () => book, saved: () => saved, members: () => members, wakes: () => wakes, offs: () => offs,
  };
}
type H = ReturnType<typeof harness>;
const flush = () => new Promise((r) => setTimeout(r, 0));
const start = (h: H, which: Which = "account", ownerDirect = false) => h.gate.admitStart(which === "account" ? h.accountKey.v : which === "bank" ? h.bankKey.v : KEYS.email, { ownerDirect });
const ACCOUNT_ON = (credKey = KEYS.account, accountId: string | null = "acct_A"): AccountState_ => ({ accountId, accountAsOf: null, capability: "on", capAsOf: iso(NOV), capCredId: credIdOf(credKey) });
const CRED = { account: credIdOf(KEYS.account), email: credIdOf(KEYS.email), bank: credIdOf(KEYS.bank) };
/** restart: a new gate over what the old one persisted */
const restart = (h: H, extra: Partial<Parameters<typeof harness>[0]> = {}) => harness({ persisted: h.saved(), members: h.members(), book: h.book(), ...extra });

describe("the flat wire decoders (field names in one place)", () => {
  it("reads the flat 200: key evidence and the account group, all at top level", () => {
    const d = decodeLimitsBody(getBody({ acctSpent: 12.345678, budget: 50, tokenLimit: 1000, tokens: 7, asOf: NOV, bot: { id: "bot1", budget: 5, spent: 2 } }));
    expect(d).toEqual({
      asOfMs: NOV,
      account: { state: "valid", figure: { accountId: "acct_A", month: "2026-11", asOfMs: NOV, spentUsd: 12.345678 } },
      key: { keyId: "sk-flux1xyz", budgetUsd: 50, spentUsd: 1, tokenLimit: 1000, tokens: 7, bot: { botId: "bot1", budgetUsd: 5, spentUsd: 2 } },
    });
  });
  it("the withdrawn nested `key` shape is not key evidence; a body with no valid as_of is not a body", () => {
    expect(decodeLimitsBody(getBody({ nested: true }))).toMatchObject({ key: null });
    expect(decodeLimitsBody(getBody({ drop: ["as_of"] }))).toBeNull();
    expect(decodeLimitsBody(null)).toBeNull();
    expect(decodeLimitsBody([])).toBeNull();
  });
  it("judges the groups apart: all four account fields absent = absent; a null figure = figureNull (never 0); a partial group or a month that disagrees = malformed", () => {
    expect(decodeLimitsBody(getBody({ account: null }))!.account).toEqual({ state: "absent" });
    expect(decodeLimitsBody(getBody({ acctSpent: null, asOf: NOV }))!.account).toEqual({ state: "figureNull", accountId: "acct_A", asOfMs: NOV });
    for (const drop of ["account_id", "month", "account_spent_usd_this_month", "account_as_of"]) expect(decodeLimitsBody(getBody({ drop: [drop] }))!.account, drop).toEqual({ state: "malformed" });
    expect(decodeLimitsBody(getBody({ month: "2026-10" }))!.account).toEqual({ state: "malformed" });
    expect(decodeLimitsBody(getBody({ acctSpent: -1 }))!.account).toEqual({ state: "malformed" });
    expect(decodeLimitsBody(getBody({ budget: 50, drop: ["account_id"] }))!.key).not.toBeNull(); // a bad account group never spoils key evidence
  });
  it("the bot group is all or none, named only by BOT_FIELDS; a partial group is not key evidence", () => {
    expect(decodeLimitsBody(getBody({ drop: [] }))!.key!.bot).toBeNull();
    const partial = { ...getBody(), [BOT_FIELDS.id]: "bot1" };
    expect(decodeLimitsBody(partial)!.key).toBeNull();
    expect(Object.values(BOT_FIELDS)).toEqual(["bot_id", "bot_monthly_budget_usd", "bot_spent_usd_this_month"]);
  });
  it("a 402 decodes its flat fields and account_id; its account figure is never exposed (r7 1); null figures are fine", () => {
    const d = decode402Body(body402({ botId: "bot1", limit: "bot_monthly_spend", spent: null }))!;
    expect(d).toMatchObject({ limit: "bot_monthly_spend", botId: "bot1", accountId: "acct_A", budget: 5, spent: 5 });
    expect("account" in d).toBe(false);
    expect("asOfMs" in d).toBe(false); // the 402 has no as_of
    expect(decode402Body(body402({ account: null }))!.accountId).toBeNull();
    expect(decode402Body({ error: "something_else" })).toBeNull();
  });
  it("frozen (a): a key with no account is a 200 with account_id null and null figures: `noAccount`, unknown, never 0", () => {
    expect(decodeLimitsBody(getBody({ noAccount: true }))!.account).toEqual({ state: "noAccount" });
    expect(decodeLimitsBody(getBody({ noAccount: true }))!.key).not.toBeNull();
    expect(decodeLimitsBody({ ...getBody({ noAccount: true }), account_spent_usd_this_month: 3 })!.account).toEqual({ state: "malformed" });
  });
  it("the field names are one table", () => {
    expect(FLUX_FIELDS.accountAsOf).toBe("account_as_of");
    expect(FLUX_FIELDS.keyBudget).toBe("key_monthly_budget_usd");
  });
});

describe("the reader", () => {
  it("401 is unauthorized, 403 (no longer a contract answer), 404 and 503 account_spend_unavailable are failed, 200 is a body", async () => {
    const reply = (status: number, body?: unknown): typeof fetch => (async () => new Response(body === undefined ? null : JSON.stringify(body), { status })) as never;
    expect(await createAccountReader(reply(401))("k")).toEqual({ kind: "unauthorized" });
    expect(await createAccountReader(reply(403, { error: "key_has_no_account" }))("k")).toEqual({ kind: "failed" });
    expect(await createAccountReader(reply(404))("k")).toEqual({ kind: "failed" });
    expect(await createAccountReader(reply(503, { error: "account_spend_unavailable" }))("k")).toEqual({ kind: "failed" });
    expect(await createAccountReader(reply(200, getBody()))("k")).toMatchObject({ kind: "body" });
    expect(await createAccountReader(reply(200, { no: "as_of" }))("k")).toEqual({ kind: "failed" });
  });
});

describe("boot safety of the module (it runs inside index.ts under Node strip-only TypeScript)", () => {
  it("building the gate reads no credential: index.ts wires it before the email runtime exists", () => {
    let armed = false;
    const gate = createSpendGate({ credentials: () => { if (!armed) throw new ReferenceError("Cannot access 'emailRuntime' before initialization"); return []; }, limitUsd: () => 100, enabled: true });
    armed = true;
    expect(gate.capability()).toBe("off");
  });
  it("uses no TypeScript syntax Node cannot strip (a parameter property broke the packaged boot)", async () => {
    const { readFileSync } = await import("node:fs");
    const text = readFileSync(new URL("./spend-gate.ts", import.meta.url), "utf8");
    expect(text).not.toMatch(/constructor\([^)]*\b(readonly|private|public|protected)\s+\w+\s*:/);
    expect(text).not.toMatch(/^\s*(export\s+)?(const\s+)?enum\s/m);
    expect(new SpendGateRefusal([{ kind: "limit" }]).holds).toEqual([{ kind: "limit" }]);
  });
});

describe("the pause stays OFF until the renderer card ships (r6 7.4)", () => {
  it("is pinned off by default: no read, no hold, no refusal, capability off, even on a body that would turn it on", async () => {
    expect(PAUSE_RENDERER_CARD_SHIPPED).toBe(false);
    const calls: string[] = [];
    const gate = createSpendGate({
      credentials: () => [{ id: "account", kind: "account", key: () => KEYS.account }], limitUsd: () => 100,
      read: async (k) => { calls.push(k); return ok({ acctSpent: 500 }); },
    });
    expect(await gate.admitStart(KEYS.account)).toEqual({ ok: true });
    await gate.authorizeFluxDispatch(KEYS.account);
    gate.onSettled();
    await gate.refreshAll();
    expect(gate.onBudgetReached(body402(), KEYS.account)).toEqual({ armed: false });
    expect(gate.capability()).toBe("off");
    expect(gate.holdsById("account")).toEqual([]);
    expect(gate.refusals()).toEqual({});
    expect(calls).toEqual([]);
  });
});

describe("capability: the pause is OFF unless a current account-key read shows the account fields", () => {
  it("starts OFF: a 404 route, fields absent, or a failed read admit every start at any spend, and make no hold", async () => {
    for (const read of [{ kind: "failed" } as AccountRead, ok({ account: null }), ok({ noAccount: true })]) {
      const h = harness({ reads: { [KEYS.account]: read } });
      expect(await start(h)).toEqual({ ok: true });
      expect(h.gate.capability()).toBe("off");
      expect(h.gate.holds(h.creds.account)).toEqual([]);
      await h.gate.authorizeFluxDispatch();
      expect(h.offs()).toBe(0);
    }
  });
  it("a valid capability read turns it ON, adopts the account id, writes membership by credId and persists, without any key", async () => {
    const h = harness({ reads: { [KEYS.account]: fresh({ acctSpent: 5 }) } });
    expect(await start(h)).toEqual({ ok: true });
    expect(h.gate.capability()).toBe("on");
    expect(h.gate.account()).toMatchObject({ accountId: "acct_A", capability: "on", capCredId: CRED.account });
    expect(h.saved()?.capAsOf).toMatch(/^2026-11-10T/);
    expect(h.members()[CRED.account]).toMatchObject({ accountId: "acct_A" });
    expect(JSON.stringify([h.saved(), h.members(), h.book()])).not.toContain("sk-flux");
  });
  it("FAILED_READ_HOLDS_UNKNOWN: while ON with L set, a 401, 503, 404, network failure, a key on no account, a null figure or a partial account group is a failed read: capability stays ON, the start meets unknown", async () => {
    expect(FAILED_READ_HOLDS_UNKNOWN).toBe(true);
    const failures: Array<AccountRead | (() => AccountRead)> = [{ kind: "unauthorized" }, fresh({ noAccount: true }), { kind: "failed" }, fresh({ acctSpent: null }), fresh({ drop: ["account_as_of"] })];
    for (const bad of failures) {
      const h = harness({ reads: { [KEYS.account]: fresh({ acctSpent: 5 }) } });
      await start(h);
      h.reads[KEYS.account] = bad;
      expect(await start(h)).toMatchObject({ ok: false, holds: [{ kind: "unknown" }] });
      expect(h.gate.capability()).toBe("on");
    }
    const none = harness({ limit: null, reads: { [KEYS.account]: fresh({ acctSpent: 5 }) } }); // no L: nothing is held
    await none.gate.refreshAll();
    none.reads[KEYS.account] = { kind: "failed" };
    expect(await start(none)).toEqual({ ok: true });
  });
  it("a 200 with account_id null on the account key (frozen: there is no 403) names its own line and offers Open Flux Router; it is never read as 0", async () => {
    const h = harness({ reads: { [KEYS.account]: fresh({ acctSpent: 5 }) } });
    await start(h);
    h.reads[KEYS.account] = fresh({ noAccount: true });
    const verdict = await start(h);
    expect(verdict).toMatchObject({ ok: false });
    const holds = h.gate.holds(h.creds.account);
    expect(holds).toContainEqual({ kind: "unknown", noAccount: true });
    expect(describeHolds(holds)).toEqual({ lines: ["This Flux Router key is not on a Flux account, so Murage's limit cannot count it."], actions: ["check", "openFlux"] });
  });
  it("a GET on an email key without the fields never changes the capability; with L set that credential meets unknown", async () => {
    const h = harness({ reads: { [KEYS.account]: fresh({ acctSpent: 5 }), [KEYS.email]: fresh({ account: null }) } });
    await start(h);
    expect(await start(h, "email")).toMatchObject({ ok: false, holds: [{ kind: "unknown" }] });
    expect(h.gate.capability()).toBe("on");
  });
  it("ON to OFF in ONE step: persisted, pending authorization void, limit and unknown released with a wake, the flux refusal kept, the card raised", async () => {
    const h = harness({ reads: { [KEYS.account]: fresh({ acctSpent: 150, budget: 50, spent: 50 }) } });
    await start(h);
    h.gate.onBudgetReached(body402({ spent: 150 }), KEYS.account);
    expect(h.gate.holds(h.creds.account).map((x) => x.kind)).toEqual(["limit", "flux"]);
    const gen = h.gate.capabilityGeneration();
    h.reads[KEYS.account] = fresh({ account: null, budget: 50, spent: 50 });
    await h.gate.refreshAll();
    expect(h.gate.capability()).toBe("off");
    expect(h.saved()).toMatchObject({ capability: "off" });
    expect(h.gate.capabilityGeneration()).toBeGreaterThan(gen);
    expect(h.gate.holds(h.creds.account)).toEqual([{ kind: "flux", limit: "monthly_spend" }]);
    expect(h.gate.figure()).toBeNull();
    expect(h.gate.headsUpOnlyNotice()).toBe(true);
    expect(h.offs()).toBe(1);
    expect(h.wakes()).toBe(1);
    expect(await start(h)).toMatchObject({ ok: false, holds: [{ kind: "flux" }] });
  });
  it("an authorization minted while OFF is void if the capability turned ON before dispatch: the start goes round again under ON", async () => {
    const h = harness({ reads: { [KEYS.account]: fresh({ acctSpent: 5 }) } });
    expect(await start(h)).toEqual({ ok: true });
    expect(h.calls.filter((k) => k === KEYS.account).length).toBe(2);
    h.calls.length = 0;
    await start(h);
    expect(h.calls.length).toBe(1);
  });
  it("A1: save the key twice (epoch 4), persist ON with F >= L; a new process (epoch 0) with the same key and a timed-out boot read admits no Flux start, L-set work meets unknown, capability still ON", async () => {
    const one = harness({ reads: { [KEYS.account]: fresh({ acctSpent: 500 }) } });
    one.epoch.v = 4;
    await start(one);
    expect(one.saved()).toMatchObject({ capability: "on", capCredId: CRED.account });
    const two = restart(one, { reads: { [KEYS.account]: { kind: "failed" } } });
    expect(two.epoch.v).toBe(0);
    expect(two.gate.capability()).toBe("on");
    expect(two.gate.holds(two.creds.account)).toEqual([{ kind: "unknown" }]);
    await two.gate.refreshAll();
    expect(await start(two)).toMatchObject({ ok: false, holds: [{ kind: "unknown" }] });
    expect(two.gate.capability()).toBe("on");
  });
  it("A2: the same, but the boot read succeeds with F < L: the start is admitted with no extra round", async () => {
    const one = harness({ reads: { [KEYS.account]: fresh({ acctSpent: 500 }) } });
    await start(one);
    const two = restart(one, { reads: { [KEYS.account]: fresh({ acctSpent: 5 }) } });
    await two.gate.refreshAll();
    two.calls.length = 0;
    expect(await start(two)).toEqual({ ok: true });
    expect(two.calls.filter((k) => k === KEYS.account)).toHaveLength(1);
  });
  it("A3: persisted ON, the key replaced on disk before boot, boot read times out: capability ON, F empty, L-set work meets unknown", async () => {
    const h = harness({ accountKey: "sk-flux-K2", persisted: ACCOUNT_ON(KEYS.account), reads: { "sk-flux-K2": { kind: "failed" } } });
    expect(h.gate.capability()).toBe("on");
    expect(h.gate.account()).toMatchObject({ accountId: null, capCredId: credIdOf("sk-flux-K2") });
    await h.gate.refreshAll();
    expect(h.gate.figure()).toBeNull();
    expect(await start(h)).toMatchObject({ ok: false, holds: [{ kind: "unknown" }] });
    expect(h.gate.capability()).toBe("on");
  });
  it("A4: the same key saved again mid-read: the in-flight answer (old reqGen) is dropped; credId and membership are unchanged", async () => {
    const h = harness({ reads: { [KEYS.account]: fresh({ acctSpent: 5 }) } });
    await start(h);
    const before = JSON.stringify([h.members(), h.gate.figure(), h.gate.account()]);
    h.reads[KEYS.account] = () => { h.epoch.v += 1; return ok({ acctSpent: 500 }); };
    await h.gate.refreshAll();
    expect(JSON.stringify([h.members(), h.gate.figure(), h.gate.account()])).toBe(before);
    expect(h.gate.holds(h.creds.account)).toEqual([]);
    expect(Object.keys(h.members())).toEqual([CRED.account]);
  });
  it("persisted OFF boots OFF; a restart never moves ON to OFF", async () => {
    expect(harness({ persisted: { ...ACCOUNT_ON(), capability: "off" } }).gate.capability()).toBe("off");
    expect(harness({ persisted: ACCOUNT_ON() }).gate.capability()).toBe("on");
  });
  it("capability ordering: a late fields-absent read with an older key as_of leaves ON and the limit hold; after a restart an absent read older than the persisted capAsOf is ignored", async () => {
    const h = harness({ reads: { [KEYS.account]: fresh({ acctSpent: 150, asOf: NOV + 50_000 }) } });
    await start(h);
    expect(h.gate.holds(h.creds.account)).toEqual([{ kind: "limit" }]);
    h.reads[KEYS.account] = fresh({ account: null, asOf: NOV + 1000 });
    await h.gate.refreshAll();
    expect(h.gate.capability()).toBe("on");
    expect(h.gate.holds(h.creds.account)).toEqual([{ kind: "limit" }]);
    expect(h.offs()).toBe(0);
    const two = restart(h, { reads: { [KEYS.account]: fresh({ account: null, asOf: NOV + 2000 }) } });
    await two.gate.refreshAll();
    expect(two.gate.capability()).toBe("on");
    expect(two.offs()).toBe(0);
    two.reads[KEYS.account] = fresh({ account: null, asOf: NOV + 90_000 });
    await two.gate.refreshAll();
    expect(two.gate.capability()).toBe("off");
  });
});

describe("account identity and the account figure", () => {
  it("the first account evidence adopts account_id; the same key naming another account is a failed read, held unknown, never adopted", async () => {
    const h = harness({ reads: { [KEYS.account]: fresh({ acctSpent: 1 }) } });
    await start(h);
    h.reads[KEYS.account] = fresh({ account: "acct_B" });
    expect(await start(h)).toMatchObject({ ok: false, holds: [{ kind: "unknown" }] });
    expect(h.gate.account().accountId).toBe("acct_A");
  });
  it("the owner saves a different Flux key: figure dropped, permissions void, the first read on the new key adopts its account (same or new)", async () => {
    const h = harness({ reads: { [KEYS.account]: fresh({ acctSpent: 500 }), "sk-flux-new": fresh({ acctSpent: 7, account: "acct_B" }) } });
    await start(h);
    h.accountKey.v = "sk-flux-new";
    h.gate.credentialsChanged();
    expect(h.gate.figure()).toBeNull();
    expect(h.gate.account()).toMatchObject({ accountId: null, capCredId: credIdOf("sk-flux-new") });
    expect(await start(h)).toEqual({ ok: true });
    expect(h.gate.account().accountId).toBe("acct_B");
    expect(h.gate.figure()?.spentUsd).toBe(7);
    expect(h.members()[credIdOf("sk-flux-new")]).toMatchObject({ accountId: "acct_B" });
    expect(h.members()[CRED.account]).toBeUndefined(); // the old key is no longer configured and no refusal names it: pruned
  });
  it("admits below the limit, refuses at it (equality holds), one fresh round per start; owner_direct is refused `never`", async () => {
    const h = harness({ reads: { [KEYS.account]: fresh({ acctSpent: 99.99 }) } });
    expect(await start(h)).toEqual({ ok: true });
    h.calls.length = 0;
    await start(h);
    expect(h.calls.length).toBe(1);
    h.reads[KEYS.account] = fresh({ acctSpent: 100 });
    expect(await start(h, "account", true)).toEqual({ ok: false, holds: [{ kind: "limit" }], retry: "never" });
  });
  it("account_as_of orders ONLY the account figure: an older account_as_of beside a newer key as_of never lowers or replaces F, and key evidence still clears a covered refusal", async () => {
    const h = harness({ reads: { [KEYS.account]: fresh({ acctSpent: 90, acctAsOf: NOV + 20_000, asOf: NOV + 20_000 }) } });
    await start(h);
    h.gate.onBudgetReached(body402({ asOf: NOV + 21_000 }), KEYS.account);
    expect(h.gate.holds(h.creds.account)).toEqual([{ kind: "flux", limit: "monthly_spend" }]);
    h.reads[KEYS.account] = fresh({ acctSpent: 10, acctAsOf: NOV + 5000, asOf: NOV + 30_000, budget: 50, spent: 1 });
    await h.gate.refreshAll();
    expect(h.gate.figure()?.spentUsd).toBe(90);
    expect(h.gate.holds(h.creds.account)).toEqual([]);
    expect(h.gate.refusals()).toEqual({});
  });
  it("F only rises inside a month (a newer but lower figure keeps the higher); a later month replaces it and frees a limit hold with no timer", async () => {
    const h = harness({ reads: { [KEYS.account]: fresh({ acctSpent: 90 }) } });
    await start(h);
    h.reads[KEYS.account] = fresh({ acctSpent: 40 });
    await h.gate.refreshAll();
    expect(h.gate.figure()?.spentUsd).toBe(90);
    h.reads[KEYS.account] = fresh({ acctSpent: 150 });
    await h.gate.refreshAll();
    expect(await start(h)).toMatchObject({ ok: false, holds: [{ kind: "limit" }] });
    h.reads[KEYS.account] = fresh({ acctSpent: 5, asOf: Date.parse("2026-12-01T00:00:10Z") });
    h.advance(120_000);
    expect(await start(h)).toEqual({ ok: true });
    expect(h.gate.figure()).toMatchObject({ month: "2026-12", spentUsd: 5 });
  });
  it("a null account figure is unknown, never 0: ON + L gives unknown with F untouched; OFF stays OFF; membership is still written", async () => {
    const h = harness({ reads: { [KEYS.account]: fresh({ acctSpent: 5 }) } });
    await start(h);
    h.reads[KEYS.account] = fresh({ acctSpent: null });
    expect(await start(h)).toMatchObject({ ok: false, holds: [{ kind: "unknown" }] });
    expect(h.gate.figure()?.spentUsd).toBe(5);
    const off = harness({ reads: { [KEYS.account]: fresh({ acctSpent: null }) } });
    expect(await start(off)).toEqual({ ok: true });
    expect(off.gate.capability()).toBe("off");
    expect(off.members()[CRED.account]).toMatchObject({ accountId: "acct_A" });
  });
  it("a body with three of the four account fields is a failed account read: ON + L gives unknown, OFF stays OFF", async () => {
    const h = harness({ reads: { [KEYS.account]: fresh({ acctSpent: 5 }) } });
    await start(h);
    h.reads[KEYS.account] = fresh({ drop: ["month"] });
    expect(await start(h)).toMatchObject({ ok: false, holds: [{ kind: "unknown" }] });
    const off = harness({ reads: { [KEYS.account]: fresh({ drop: ["month"] }) } });
    expect(await start(off)).toEqual({ ok: true });
    expect(off.gate.capability()).toBe("off");
  });
  it("starts are serialized: concurrent starts never overlap their reads", async () => {
    let inFlight = 0, max = 0, n = 0;
    const h = harness({ reads: { [KEYS.account]: () => { inFlight++; max = Math.max(max, inFlight); n++; queueMicrotask(() => { inFlight--; }); return ok({ acctSpent: 1 }); } } });
    await Promise.all([start(h), start(h), start(h)]);
    expect(n).toBeGreaterThanOrEqual(3);
    expect(max).toBe(1);
  });
});

describe("membership by credId (r6 2, r7 2)", () => {
  it("every key that can send a Flux call must show the same account_id: the other key waits as unknown with the other-account line; a matching key is admitted", async () => {
    const h = harness({ reads: { [KEYS.account]: fresh({ acctSpent: 5 }), [KEYS.email]: fresh({ account: "acct_B" }), [KEYS.bank]: fresh({}) } });
    expect(await start(h, "email")).toMatchObject({ ok: false, holds: [{ kind: "unknown", otherAccount: true }] });
    expect(await start(h, "bank")).toEqual({ ok: true });
  });
  it("a key on no account (200 with account_id null) waits as unknown while a limit is set, and is admitted with no limit", async () => {
    const h = harness({ reads: { [KEYS.account]: fresh({ acctSpent: 5 }), [KEYS.bank]: fresh({ noAccount: true }) } });
    expect(await start(h, "bank")).toMatchObject({ ok: false, holds: [{ kind: "unknown" }] });
    h.setLimit(null);
    expect(await start(h, "bank")).toEqual({ ok: true });
  });
  it("same-stamp discovery: a first read on a bank key inside the 30 s cache (same account_id and account_as_of) writes its membership, leaves F, and admits it after its round", async () => {
    const T = NOV + 40_000;
    const h = harness({ reads: { [KEYS.account]: fresh({ acctSpent: 5, acctAsOf: T }), [KEYS.bank]: fresh({ acctSpent: 5, acctAsOf: T }) } });
    await start(h);
    const f = h.gate.figure();
    expect(h.members()[CRED.bank]).toBeUndefined();
    expect(await start(h, "bank")).toEqual({ ok: true });
    expect(h.members()[CRED.bank]).toMatchObject({ accountId: "acct_A" });
    expect(h.gate.figure()).toEqual(f);
  });
  it("membership is persisted, restored at boot and pruned to configured credentials (a live refusal record keeps its entry)", async () => {
    const h = harness({ reads: { [KEYS.account]: fresh({ acctSpent: 5 }), [KEYS.bank]: fresh({}) } });
    await start(h); await start(h, "bank");
    expect(Object.keys(h.members()).sort()).toEqual([CRED.account, CRED.bank].sort());
    const two = restart(h);
    expect(two.gate.membership()).toEqual(h.members());
    h.bankKey.v = "sk-flux-bank-2";
    h.gate.credentialsChanged();
    expect(Object.keys(h.members())).toEqual([CRED.account]);
  });
  it("B4: membership A for K; a later read on K shows account B: a failed account read, the entry stays A, L-set work meets unknown", async () => {
    const h = harness({ persisted: ACCOUNT_ON(), members: { [CRED.account]: { accountId: "acct_A", asOf: iso(NOV) } }, reads: { [KEYS.account]: fresh({ account: "acct_B" }) } });
    expect(await start(h)).toMatchObject({ ok: false, holds: [{ kind: "unknown" }] });
    expect(h.members()[CRED.account]).toMatchObject({ accountId: "acct_A" });
  });
});

describe("refusals (402 key_budget_reached)", () => {
  it("a LEGACY 402 (capability OFF) arms monthly_spend by key:<credId>; a later GET with key headroom clears it, capability stays OFF, also after a restart (B5: no key_id_prefix anywhere)", async () => {
    const h = harness({ reads: { [KEYS.account]: fresh({ account: null, budget: 50, spent: 50 }) } });
    h.gate.onBudgetReached(body402({ account: null }), KEYS.account);
    expect(Object.keys(h.book())).toEqual([`key:${CRED.account}`]);
    expect(h.book()[`key:${CRED.account}`]!.monthly_spend).toMatchObject({ credId: CRED.account, keyId: "sk-flux1xyz" });
    expect(await start(h)).toMatchObject({ ok: false, holds: [{ kind: "flux" }] });
    const two = restart(h, { reads: { [KEYS.account]: fresh({ account: null, budget: 50, spent: 10 }) } });
    expect(two.gate.holds(two.creds.account)).toEqual([{ kind: "flux", limit: "monthly_spend" }]);
    await two.gate.refreshAll();
    expect(two.book()).toEqual({});
    expect(two.gate.capability()).toBe("off");
    expect(two.wakes()).toBe(1);
  });
  it("a refusal clears only on KEY evidence sent after it (request sequence only: the 402 has no as_of): not one sent before the 402, not one at the cap, not one naming another key_id", async () => {
    const h = harness({ reads: { [KEYS.account]: fresh({ account: null, budget: 50, spent: 50 }) } });
    h.gate.onBudgetReached(body402({ account: null, asOf: NOV + 100_000 }), KEYS.account);
    h.reads[KEYS.account] = () => { h.gate.onBudgetReached(body402({ account: null, asOf: NOV + 100_000 }), KEYS.account); return ok({ account: null, budget: 50, spent: 1, asOf: NOV + 200_000 }); };
    await h.gate.refreshAll();
    expect(Object.keys(h.book())).toHaveLength(1); // the 402 was recorded after this read was sent
    h.reads[KEYS.account] = fresh({ account: null, budget: 50, spent: 50, asOf: NOV + 300_000 });
    await h.gate.refreshAll();
    expect(Object.keys(h.book())).toHaveLength(1); // at the cap
    h.reads[KEYS.account] = fresh({ account: null, budget: 50, spent: 1, asOf: NOV + 400_000, keyId: "sk-other" });
    await h.gate.refreshAll();
    expect(Object.keys(h.book())).toHaveLength(1); // another key_id is a failed read
    h.reads[KEYS.account] = fresh({ account: null, budget: 50, spent: 1, asOf: NOV + 500_000 });
    await h.gate.refreshAll();
    expect(h.book()).toEqual({});
  });
  it("a GET with valid key evidence and a MALFORMED account group clears a covered refusal and is a failed account read", async () => {
    const h = harness({ reads: { [KEYS.account]: fresh({ acctSpent: 5 }) } });
    await start(h);
    h.gate.onBudgetReached(body402(), KEYS.account);
    h.reads[KEYS.account] = fresh({ budget: 50, spent: 1, drop: ["account_spent_usd_this_month"] });
    await h.gate.refreshAll();
    expect(h.gate.refusals()).toEqual({});
    expect(await start(h)).toMatchObject({ ok: false, holds: [{ kind: "unknown" }] });
    expect(h.gate.capability()).toBe("on");
  });
  it("TOKENS: a monthly_tokens refusal clears on a later read whose tokens_this_month is below the limit, and stays at it", async () => {
    const h = harness({ reads: { [KEYS.account]: fresh({ account: null, tokenLimit: 100, tokens: 100 }) } });
    h.gate.onBudgetReached(body402({ account: null, limit: "monthly_tokens" }), KEYS.account);
    await h.gate.refreshAll();
    expect(Object.keys(h.book())).toHaveLength(1);
    h.reads[KEYS.account] = fresh({ account: null, tokenLimit: 100, tokens: 40 });
    await h.gate.refreshAll();
    expect(h.book()).toEqual({});
  });
  it("BOT: with the account known the scope is bot:<account>:<bot>; it clears when the bot group names that bot with headroom; a GET without a recognised bot group leaves it until the month rollover", async () => {
    const h = harness({ reads: { [KEYS.account]: fresh({ acctSpent: 5 }) } });
    await start(h);
    h.gate.onBudgetReached(body402({ limit: "bot_monthly_spend", botId: "X", account: null }), KEYS.account);
    expect(Object.keys(h.book())).toEqual(["bot:acct_A:X"]); // account from membership
    expect(h.gate.holds(h.creds.account)).toEqual([{ kind: "flux", limit: "bot_monthly_spend" }]);
    h.reads[KEYS.account] = fresh({ acctSpent: 5 });
    await h.gate.refreshAll();
    expect(Object.keys(h.book())).toEqual(["bot:acct_A:X"]); // no bot group: stays
    h.reads[KEYS.account] = fresh({ acctSpent: 5, bot: { id: "Y", budget: 5, spent: 1 } });
    await h.gate.refreshAll();
    expect(Object.keys(h.book())).toEqual(["bot:acct_A:X"]); // another bot
    h.reads[KEYS.account] = fresh({ acctSpent: 5, asOf: Date.parse("2026-12-01T00:05:00Z") });
    await h.gate.refreshAll();
    expect(h.book()).toEqual({}); // month rollover
  });
  it("B1 (Astra's counterexample): K on A arms bot:A:X; a legacy GET turns capability OFF; after a restart K's GET shows bot X headroom with no account fields: bot:A:X clears", async () => {
    const h = harness({ reads: { [KEYS.account]: fresh({ acctSpent: 5 }) } });
    await start(h);
    h.gate.onBudgetReached(body402({ limit: "bot_monthly_spend", botId: "X" }), KEYS.account);
    h.reads[KEYS.account] = fresh({ account: null });
    await h.gate.refreshAll();
    expect(h.gate.capability()).toBe("off");
    expect(Object.keys(h.book())).toEqual(["bot:acct_A:X"]);
    const two = restart(h, { reads: { [KEYS.account]: fresh({ account: null, bot: { id: "X", budget: 5, spent: 1 } }) } });
    await two.gate.refreshAll();
    expect(two.book()).toEqual({});
    expect(two.wakes()).toBe(1);
  });
  it("B2: the restart GET comes on credential K_B (membership B): bot:A:X stays, and K_B's own bot X is not held", async () => {
    const h = harness({ reads: { [KEYS.account]: fresh({ acctSpent: 5 }) } });
    await start(h);
    h.gate.onBudgetReached(body402({ limit: "bot_monthly_spend", botId: "X" }), KEYS.account);
    h.reads[KEYS.account] = fresh({ account: null });
    await h.gate.refreshAll();
    const two = restart(h, { accountKey: "sk-flux-B", reads: { "sk-flux-B": fresh({ account: "acct_B", acctSpent: 5, bot: { id: "X", budget: 5, spent: 1 } }) } });
    await two.gate.refreshAll();
    expect(Object.keys(two.book())).toEqual(["bot:acct_A:X"]);
    expect(two.members()[credIdOf("sk-flux-B")]).toMatchObject({ accountId: "acct_B" });
    expect(two.gate.holds(two.creds.account)).toEqual([]);
  });
  it("B3: botc:<credId>:X with no membership; after a restart K's GET with headroom clears it; another credential is neither held by it nor covered", async () => {
    const h = harness({ reads: { [KEYS.account]: fresh({ account: null }) } });
    h.gate.onBudgetReached(body402({ limit: "bot_monthly_spend", botId: "X", account: null }), KEYS.account);
    expect(Object.keys(h.book())).toEqual([`botc:${CRED.account}:X`]);
    const two = restart(h, { reads: { [KEYS.account]: fresh({ account: null, bot: { id: "X", budget: 5, spent: 1 } }) } });
    expect(two.gate.holds(two.creds.account)).toEqual([{ kind: "flux", limit: "bot_monthly_spend" }]);
    expect(two.gate.holds(two.creds.email)).toEqual([]);
    expect(two.gate.holds(two.creds.bank)).toEqual([]);
    await two.gate.refreshAll();
    expect(two.book()).toEqual({});
  });
  it("another account does not inherit it: bot:A:X holds nothing on account B, and B's headroom does not clear it", async () => {
    const h = harness({ reads: { [KEYS.account]: fresh({ acctSpent: 5 }), [KEYS.bank]: fresh({ account: "acct_B", bot: { id: "X", budget: 5, spent: 1 } }) } });
    await start(h);
    h.gate.onBudgetReached(body402({ limit: "bot_monthly_spend", botId: "X" }), KEYS.account);
    await start(h, "bank");
    expect(h.gate.holds(h.creds.bank).filter((x) => x.kind === "flux")).toEqual([]);
    expect(Object.keys(h.book())).toEqual(["bot:acct_A:X"]);
  });
  it("R7-1 (Astra's counterexample): L = 1000, F = 5; a 402 stamped 1 Nov 00:01:00 with account 1200: its refusal is armed, F stays 5, an unrelated Flux start is admitted after its round", async () => {
    const h = harness({ limit: 1000, reads: { [KEYS.account]: fresh({ acctSpent: 5 }), [KEYS.bank]: fresh({ acctSpent: 5 }) } });
    await start(h);
    h.gate.onBudgetReached(body402({ spent: 1200, asOf: Date.parse("2026-11-01T00:01:00Z") }), KEYS.account);
    expect(Object.keys(h.book())).toEqual([`key:${CRED.account}`]);
    expect(h.gate.figure()?.spentUsd).toBe(5);
    expect(await start(h, "bank")).toEqual({ ok: true });
    expect(h.gate.figure()?.spentUsd).toBe(5);
  });
  it("R7-2: a 402 with a non-null account figure above F mid-month changes neither F, membership nor capability", async () => {
    const h = harness({ reads: { [KEYS.account]: fresh({ acctSpent: 5 }) } });
    await start(h);
    const before = JSON.stringify([h.gate.figure(), h.members(), h.gate.capability(), h.saved()]);
    h.gate.onBudgetReached(body402({ spent: 9999, asOf: NOV + 90_000_000 }), KEYS.bank);
    h.gate.onBudgetReached(body402({ spent: 9999, account: "acct_Z", asOf: NOV + 90_000_000, limit: "monthly_tokens" }), KEYS.account);
    expect(JSON.stringify([h.gate.figure(), h.members(), h.gate.capability(), h.saved()])).toBe(before);
    expect(h.gate.holds(h.creds.account).some((x) => x.kind === "limit")).toBe(false);
  });
  it("R7-3: a 402 with account_id A and the bot group arms bot:A:<bot_id> even when no membership is known", async () => {
    const h = harness({ reads: {} });
    h.gate.onBudgetReached(body402({ limit: "bot_monthly_spend", botId: "bot9", account: "acct_A" }), KEYS.account);
    expect(Object.keys(h.book())).toEqual(["bot:acct_A:bot9"]);
    expect(h.members()).toEqual({});
  });
  it("a 402 with null figures still records its refusal (a null is unknown, never 0)", () => {
    const h = harness();
    expect(h.gate.onBudgetReached(body402({ spent: null }), KEYS.account)).toEqual({ armed: true });
    expect(Object.keys(h.book())).toHaveLength(1);
    expect(h.gate.figure()).toBeNull();
  });
});

describe("a turn's permission is bound to its account and checked per call (authorizeFluxDispatch)", () => {
  it("inside an admitted turn the call is entitled; the same call without it is a start and is refused at the limit", async () => {
    const h = harness({ reads: { [KEYS.account]: fresh({ acctSpent: 150 }) } });
    await start(h);
    await h.gate.runEntitled("turn-1", () => h.gate.authorizeFluxDispatch(KEYS.account));
    await expect(h.gate.authorizeFluxDispatch(KEYS.account)).rejects.toBeInstanceOf(SpendGateRefusal);
  });
  it("a bank row on another account is held unknown inside the turn; the same bank slot re-keyed to the turn's account completes with no round", async () => {
    const h = harness({ reads: { [KEYS.account]: fresh({ acctSpent: 5 }), [KEYS.bank]: fresh({ acctSpent: 5, account: "acct_B" }), "sk-flux-bank-2": fresh({ acctSpent: 5 }) } });
    await start(h); await start(h, "bank");
    await h.gate.runEntitled("turn-1", async () => {
      await expect(h.gate.authorizeFluxDispatch(KEYS.bank)).rejects.toBeInstanceOf(SpendGateRefusal);
    });
    h.bankKey.v = "sk-flux-bank-2"; h.bankRev.v = "r2";
    h.gate.credentialsChanged();
    await start(h, "bank");
    const calls = h.calls.length;
    await h.gate.runEntitled("turn-2", () => h.gate.authorizeFluxDispatch("sk-flux-bank-2"));
    expect(h.calls.length).toBe(calls);
  });
  it("the Flux key replaced mid-turn: the turn's next call is no longer entitled and needs a membership read and a round", async () => {
    const h = harness({ reads: { [KEYS.account]: fresh({ acctSpent: 5 }), "sk-flux-new": fresh({ acctSpent: 5 }) } });
    await start(h);
    await h.gate.runEntitled("turn-1", async () => {
      expect(h.gate.entitled(KEYS.account)).toBe(true);
      h.accountKey.v = "sk-flux-new";
      await h.gate.refreshAll();
      expect(h.gate.entitled("sk-flux-new")).toBe(false);
      const before = h.calls.length;
      await h.gate.authorizeFluxDispatch("sk-flux-new");
      expect(h.calls.length).toBeGreaterThan(before);
    });
  });
  it("with F = L - 1 an un-entitled call takes its own round and is refused once F >= L; a settle that shows F >= L arms the next call with no new round", async () => {
    const h = harness({ reads: { [KEYS.account]: fresh({ acctSpent: 99 }) } });
    await h.gate.authorizeFluxDispatch();
    h.reads[KEYS.account] = fresh({ acctSpent: 100 });
    await expect(h.gate.authorizeFluxDispatch()).rejects.toBeInstanceOf(SpendGateRefusal);
    const s = harness({ reads: { [KEYS.account]: fresh({ acctSpent: 50 }) } });
    await start(s);
    s.reads[KEYS.account] = fresh({ acctSpent: 101 });
    s.gate.onSettled();
    await flush();
    const before = s.calls.length;
    await expect(s.gate.authorizeFluxDispatch()).rejects.toBeInstanceOf(SpendGateRefusal);
    expect(s.calls.length).toBe(before);
  });
});

describe("the 402 hook reaches the gate with the key the request was sent with", () => {
  it("flux-start-gate hands the parsed 402 and the sending key to onBudgetReached", async () => {
    const { installFluxStartGate, reportFlux402 } = await import("./flux-start-gate.ts");
    const seen: Array<{ body: unknown; key: unknown }> = [];
    installFluxStartGate({ onBudgetReached: (body: unknown, key?: string | null) => { seen.push({ body, key }); return { armed: true }; } } as never);
    try { reportFlux402(JSON.stringify(body402()), "sk-sent-with"); reportFlux402("not json", "sk-x"); } finally { installFluxStartGate(null); }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ key: "sk-sent-with", body: { error: "key_budget_reached", limit: "monthly_spend" } });
  });
});

describe("the once-a-second post-charge refresh", () => {
  it("many settles in one second make one read now and one trailing read", async () => {
    const h = harness({ reads: { [KEYS.account]: fresh({ acctSpent: 1 }) } });
    await start(h);
    const account = () => h.calls.filter((k) => k === KEYS.account).length;
    const base = account();
    h.advance(5000);
    for (let i = 0; i < 20; i++) h.gate.onSettled();
    await flush();
    expect(account() - base).toBe(1);
    expect(h.timers.length).toBe(1);
    h.advance(1000);
    h.timers[0]!();
    await flush();
    expect(account() - base).toBe(2);
  });
  it("makes no read with nothing to evaluate (no limit, capability OFF, no refusal)", async () => {
    const h = harness({ limit: null, reads: { [KEYS.account]: fresh({ acctSpent: 1 }) } });
    h.gate.onSettled();
    expect(h.calls).toEqual([]);
  });
});

describe("copy from holds", () => {
  it("limit alone offers Raise limit; limit plus flux names both and drops Raise limit", () => {
    expect(describeHolds([{ kind: "limit" }], { limitText: "$1,000" })).toEqual({ lines: ["You reached your $1,000 monthly limit."], actions: ["raise", "check"] });
    const both = describeHolds([{ kind: "limit" }, { kind: "flux", limit: "monthly_spend" }], { limitText: "$1,000" });
    expect(both.lines).toHaveLength(2);
    expect(both.lines[1]).toBe("A limit in Flux Router has also been reached.");
    expect(both.actions).toEqual(["openFlux"]);
  });
  it("names the bot unless only that bot's email waits", () => {
    expect(describeHolds([{ kind: "flux", limit: "bot_monthly_spend" }], { botName: "Dax", emailOnly: true }).lines.at(-1)).toBe("Only Dax's email waits.");
    expect(describeHolds([{ kind: "flux", limit: "bot_monthly_spend" }], { botName: "Dax", emailOnly: false }).lines.at(-1)).toBe("Dax waits.");
  });
  it("copy rules: no em or en dash and none of the banned words, including the heads-up-only and no-account lines", async () => {
    const l2c = (await import("../src/locales/en-ux/l2c.json", { with: { type: "json" } })).default as Record<string, string>;
    const all = [
      ...[describeHolds([{ kind: "limit" }, { kind: "unknown", otherAccount: true }, { kind: "flux", limit: "monthly_tokens" }], { botName: "Dax" }),
        describeHolds([{ kind: "unknown" }]), describeHolds([{ kind: "unknown", noAccount: true }]), describeHolds([{ kind: "flux", limit: "monthly_spend" }]), describeHolds([{ kind: "flux", limit: "bot_monthly_spend" }])].flatMap((d) => d.lines),
      ...Object.entries(l2c).filter(([k]) => k.startsWith("ux.l2c.pause.")).map(([, v]) => v),
    ].join("\n");
    expect(all).toContain("heads-up only for now");
    expect(all).toContain("is not on a Flux account");
    expect(all).not.toMatch(/[–—]|\b(safe|unsafe|safety|free|forge|will fail)\b/i);
  });
});

describe("Astra f5 round 2: strict 402 marker, unknown basis voids the whole reading, null bot budget clears", () => {
  const astra = { error: { message: "premium_locked", provider_specific_fields: { limit: "monthly_spend" } } };
  it("a nested body with only a limit and no key_budget_reached marker is not a budget refusal (Astra exact body)", () => {
    expect(decode402Body(astra)).toBeNull();
    const h = harness();
    expect(h.gate.onBudgetReached(astra, KEYS.account)).toEqual({ armed: false });
    expect(h.book()).toEqual({});
  });
  it("a nested marker of the wrong type, or a flat body with only a limit, is not a budget refusal", () => {
    expect(decode402Body({ error: { provider_specific_fields: { error: 7, limit: "monthly_spend" } } })).toBeNull();
    expect(decode402Body({ limit: "monthly_spend" })).toBeNull();
    expect(decode402Body({ error: { code: "premium_locked", provider_specific_fields: { limit: "monthly_spend" } } })).toBeNull();
  });
  it("MUST ACCEPT: the REAL F5 402 fixture (marker in provider_specific_fields.error) still arms the refusal", () => {
    const real = JSON.parse(readFileSync(new URL("./fixtures/flux-key-limits-v1/12-402-key-budget-reached.json", import.meta.url), "utf8"));
    expect(decode402Body(real)).toMatchObject({ limit: "monthly_spend" });
    const h = harness();
    expect(h.gate.onBudgetReached(real, KEYS.account)).toEqual({ armed: true });
    expect(Object.keys(h.book())).toEqual([`key:${CRED.account}`]);
  });
  it("an unknown spend_basis voids the WHOLE reading: after a good activation the account limit is unchanged, there is no flux hold and the reading is unknown", async () => {
    const h = harness({ limit: 100, reads: { [KEYS.account]: fresh({ acctSpent: 5 }) } });
    expect(await start(h)).toMatchObject({ ok: true });
    const before = JSON.stringify(h.gate.account());
    const bad = { ...getBody({ acctSpent: 99999 }), spend_basis: "net_sale" };
    expect(decodeLimitsBody(bad)).toBeNull();
    h.reads[KEYS.account] = () => { const d = decodeLimitsBody({ ...bad, as_of: iso(NOV + 900_000), account_as_of: iso(NOV + 900_000) }); return d ? { kind: "body", decoded: d } : { kind: "failed" }; };
    await h.gate.refreshAll();
    expect(h.gate.holds(h.creds.account).filter((x) => x.kind === "flux")).toEqual([]);
    expect(JSON.stringify(h.gate.account())).toBe(before);
  });
  it("a bot refusal clears when a null-budget (no bot cap) reading arrives for the same bot", async () => {
    const h = harness({ reads: { [KEYS.account]: fresh({ account: null }) } });
    h.gate.onBudgetReached(body402({ limit: "bot_monthly_spend", botId: "X", account: null }), KEYS.account);
    expect(Object.keys(h.book())).toHaveLength(1);
    h.reads[KEYS.account] = fresh({ account: null, bot: { id: "X", budget: null as unknown as number, spent: 5 } });
    await h.gate.refreshAll();
    expect(h.book()).toEqual({});
  });
});
