// SPDX-License-Identifier: AGPL-3.0-or-later
// CONTRACT DOUBLE of the P3 router routes (flux-router-b4 @ wp5-p3 2a221b43: src/cloud_home_grants_route.py + src/flux_credit_grants.py),
// NOT the live router. It mirrors them case for case: the flag-off 404 (no reason field), the misconfigured-token 503, the bearer-only 401,
// the 16 KiB body limit (413 payload_too_large), full body validation (unknown fields, identity, amount, ISO timestamps with an offset, date
// overflow, expires_at = period_end + 1 calendar month), the replay-before-state order (grant row by body hash, else a receipt), issuance
// paused, Redis unavailable, unbound (no generation or the unlink fence), recipient, ceiling (unset = retry, over = 422), freshness, and the
// success fields. Reversed grants are RETAINED (state reversed): a replay of a reversed grant is already_granted, state reversed; only a
// tombstone (a reversal of a grant the router never had) answers not_applied_reversed. Usage sums consumed over grants whose period_end is
// in (period_start, period_end]. The hash is the router's: sort_keys, compact separators, timestamps as UTC isoformat.
export interface DoubleGrant { grantId: string; invoiceId: string; kind: string; homeId: string; accountId: string; amount: number; sha: string;
  periodEnd: number; consumed: number; removed: number; state: "active" | "reversed" | "expired" }
export interface DoubleReceipt { homeId: string; invoiceId: string; kind: string; outcome: "removed" | "no_grant"; removed: number; consumed: number }
export interface Request1 { method: string; path: string; body: string | null; auth: string | null }
export interface DoubleHome { generation: number | null; fenced: boolean; account: string; state: "active" | "revoked" }

const MAX_BODY_BYTES = 16 * 1024;
const MAX_AMOUNT = 2 ** 53 - 1;
const HOME_RE = /^[A-Za-z0-9_-]{1,128}$/;
const GRANT_FIELDS = new Set(["grant_id", "invoice_id", "kind", "home_id", "account_id", "plan", "amount_microcents", "period_start", "period_end", "expires_at"]);
const REVERSE_FIELDS = new Set(["grant_id", "invoice_id", "kind", "home_id", "reason"]);
const ISO = /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d)(?:\.(\d{1,6}))?)?(Z|z|[+-]\d\d:\d\d)?$/;

class Invalid extends Error {}
const j = (status: number, o: unknown) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
/** route _err: {status: code, error: {code, message, reason?}, reason?}; the reason fields only when there is a reason. */
const err = (status: number, code: string, message?: string, reason?: string) =>
  j(status, { status: code, error: { code, message: message ?? reason ?? code, ...(reason !== undefined ? { reason } : {}) }, ...(reason !== undefined ? { reason } : {}) });
const retry = (reason: "busy" | "unavailable" = "unavailable") => err(503, "credit_grants_retry", undefined, reason);
const hex = async (t: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** A UTC instant in ms plus its microsecond remainder (Python datetime precision), or Invalid with the router's message. */
function parseTs(v: unknown, name: string): { ms: number; us: number } {
  if (typeof v !== "string" || !v.trim()) throw new Invalid(`${name} must be an ISO-8601 timestamp`);
  const m = ISO.exec(v.trim());
  if (!m) throw new Invalid(`${name} is not an ISO-8601 timestamp`);
  if (!m[8]) throw new Invalid(`${name} must carry a UTC offset`);
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "0"].map(Number);
  const frac = (m[7] ?? "").padEnd(6, "0");
  const off = /^[Zz]$/.test(m[8]) ? 0 : (m[8][0] === "-" ? -1 : 1) * (Number(m[8].slice(1, 3)) * 60 + Number(m[8].slice(4, 6)));
  const local = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(local);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || y < 1) throw new Invalid(`${name} is not an ISO-8601 timestamp`);
  const ms = local - off * 60_000;
  const yr = new Date(ms).getUTCFullYear();
  if (yr < 1 || yr > 9999) throw new Invalid(`${name} is out of the supported date range`);
  return { ms: ms + Math.floor(Number(frac) / 1000), us: Number(frac) % 1000 };
}
function addOneMonth(ms: number): number {
  const p = new Date(ms);
  const [year, month] = p.getUTCMonth() === 11 ? [p.getUTCFullYear() + 1, 0] : [p.getUTCFullYear(), p.getUTCMonth() + 1];
  if (year > 9999) throw new Invalid("period_end plus one calendar month is out of the supported date range");
  const day = Math.min(p.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
  return Date.UTC(year, month, day, p.getUTCHours(), p.getUTCMinutes(), p.getUTCSeconds(), p.getUTCMilliseconds());
}
/** Python datetime(UTC).isoformat(). */
const iso = (t: { ms: number; us: number }) => {
  const base = new Date(t.ms - (t.ms % 1000)).toISOString().slice(0, 19);
  const micro = (t.ms % 1000) * 1000 + t.us;
  return `${base}${micro ? `.${String(micro).padStart(6, "0")}` : ""}+00:00`;
};
const text = (b: Record<string, unknown>, name: string, limit = 256): string => {
  const v = b[name];
  if (typeof v !== "string" || !v.trim() || v.length > limit) throw new Invalid(`${name} must be a non-empty string`);
  return v;
};
function identity(b: Record<string, unknown>, allowed: Set<string>) {
  if (Object.keys(b).some((k) => !allowed.has(k))) throw new Invalid("unknown field(s) in body");
  const grantId = text(b, "grant_id"); const invoiceId = text(b, "invoice_id");
  const kind = b.kind;
  if (kind !== "period" && kind !== "upgrade_delta") throw new Invalid("kind must be period or upgrade_delta");
  const homeId = b.home_id;
  if (typeof homeId !== "string" || !HOME_RE.test(homeId)) throw new Invalid("home_id is not a valid home id");
  if (grantId !== `${invoiceId}:${kind}`) throw new Invalid("grant_id must equal invoice_id:kind");
  return { grantId, invoiceId, kind, homeId };
}

export class GrantsRouterDouble {
  /** The router's FLUX_CLOUD_GRANTS_TOKEN (and what it compares the bearer with). */
  token = "t".repeat(40);
  keysToken = "k".repeat(40);
  masterKey = "m".repeat(40);
  enabled = true;
  issueEnabled = true;
  /** FLUX_CLOUD_GRANT_MAX_MICROCENTS; null = unset (fails closed: retry unavailable). */
  ceiling: number | null = 1_000_000_000_000;
  redisUp = true;
  /** home_id -> Redis generation / unlink fence and the PG key row at that generation. */
  homes = new Map<string, DoubleHome>();
  /** Accounts whose state row is not fresh (held, or used without the grant credit armed). */
  unfresh = new Set<string>();
  accountAvailable = new Map<string, number>();
  grants = new Map<string, DoubleGrant>();
  receipts = new Map<string, DoubleReceipt>();
  usageFault = false;
  /** Astra JOURNEY-A-6 #2: the reversal-target route (lanes/cloud-v2/b4/FLUX-REVERSAL-TARGET-CONTRACT.md); off = the live router (404). */
  reversalTargets = false;
  /** Astra JOURNEY-A-8 #2: the grant route takes `initial_target` and applies it IN THE GRANT'S OWN STEP (one transaction: a grant is never live
   *  without it, and no fault mode can separate them); advertised as capabilities.grantWithTarget. Off = a router that refuses the unknown
   *  field (400, nothing applied). */
  grantWithTarget = false;
  /** Astra JOURNEY-A-9: receipts echo the target held at their revision (target_removed_microcents); off = a router that does not say it. */
  echoTargets = true;
  /** Astra JOURNEY-A-9 #2: GET .../credit-grants/state (capability grantState) and adopt_legacy_reversal on the target route
   *  (capability adoptLegacyReversal): a grant finally reversed by /reverse becomes a target held at revision 0 = what /reverse removed. */
  grantState = false;
  adoptLegacyReversal = false;
  /** Per grant: the latest revision applied and its target (the router's ordering state). */
  targets = new Map<string, { revision: number; target: number }>();
  requests: Request1[] = [];
  /** One-shot behaviours for the NEXT grant/reverse call. `delay`: the request is held in flight (the caller sees a timeout) and applied
   *  only when releaseDelayed() is called, i.e. AFTER whatever the caller does next. */
  next: "apply_then_drop" | "apply_then_503" | "busy" | "unavailable" | "network" | "http500" | "delay" | null = null;
  private delayed: { path: string; body: Record<string, unknown> }[] = [];
  /** Delivers the held requests now (late), in order; returns the router's answers. */
  async releaseDelayed(): Promise<{ status: number; json: Record<string, unknown> }[]> {
    const out: { status: number; json: Record<string, unknown> }[] = [];
    for (const d of this.delayed.splice(0)) {
      const res = await this.route(d.path, d.body);
      out.push({ status: res.status, json: await res.json() as Record<string, unknown> });
    }
    return out;
  }

  /** Bind a home to an account, as an active key row at a current generation (what the keys client minting for it leaves behind). */
  bind(homeId: string, account: string): void { this.homes.set(homeId, { generation: 1, fenced: false, account, state: "active" }); }

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const bodyText = typeof init?.body === "string" ? init.body : null;
    this.requests.push({ method, path: u.pathname, body: bodyText, auth: headers.get("authorization") });
    const refused = this.auth(headers);
    if (refused) return refused;
    const route = `${method} ${u.pathname}`;
    if (route === "GET /internal/cloud-home/credit-grants/usage") return this.usage(u.searchParams);
    // wp5-p5: the capability route exists only on a router that implements the target contract (an older router answers 404).
    if (route === "GET /internal/cloud-home/credit-grants/capabilities") {
      return this.reversalTargets || this.grantWithTarget
        ? j(200, { capabilities: { ...(this.reversalTargets ? { reversalTargets: true } : {}), ...(this.grantWithTarget ? { grantWithTarget: true } : {}),
          ...(this.grantState ? { grantState: true } : {}), ...(this.adoptLegacyReversal ? { adoptLegacyReversal: true } : {}) } })
        : j(404, { detail: "Not Found" });
    }
    if ((this.grantState || this.stateRoute) && route === "GET /internal/cloud-home/credit-grants/state") return this.state(u.searchParams);
    const targetRoute = this.reversalTargets && route === "POST /internal/cloud-home/credit-grants/reversal-target";
    if (route !== "POST /internal/cloud-home/credit-grants" && route !== "POST /internal/cloud-home/credit-grants/reverse" && !targetRoute) return j(404, { detail: "Not Found" });
    const declared = headers.get("content-length");
    if (declared !== null) {
      if (!/^\d+$/.test(declared.trim())) return err(400, "invalid_request", "invalid Content-Length");
      if (Number(declared.trim()) > MAX_BODY_BYTES) return err(413, "payload_too_large", `body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    if (new TextEncoder().encode(bodyText ?? "").length > MAX_BODY_BYTES) return err(413, "payload_too_large", `body exceeds ${MAX_BODY_BYTES} bytes`);
    let body: unknown;
    try { body = JSON.parse(bodyText ?? ""); } catch { body = null; }
    if (!body || typeof body !== "object" || Array.isArray(body)) return err(400, "invalid_request", "body must be a JSON object");
    const mode = this.next;
    this.next = null;
    if (mode === "network") throw new TypeError("network down");
    if (mode === "http500") return new Response("boom", { status: 500 });
    if (mode === "busy") return retry("busy");
    if (mode === "unavailable") return retry("unavailable");
    if (mode === "delay") { this.delayed.push({ path: u.pathname, body: body as Record<string, unknown> }); throw new TypeError("timeout"); }
    const res = await this.route(u.pathname, body as Record<string, unknown>);
    if (mode === "apply_then_drop") throw new TypeError("response lost");
    // Astra JOURNEY-A-8 #1: the router committed, lost its COMMIT acknowledgement, failed reconciliation and answered 503.
    if (mode === "apply_then_503") return retry("unavailable");
    return res;
  };

  /** Lane H1: FluxMain's REVISION FENCE (confirmed contract), ONE applied revision per grant id across grant, reverse and reversal-target:
   *  a revision below it is 409 stale_revision (applied_revision, latest_revision; nothing changes); the same revision with the same body
   *  (canonical hash, the revision left out) replays the original 200; with another body 409 idempotency_mismatch. A request without a
   *  revision (grant/reverse) is the pre-H1 shape. */
  fence = new Map<string, { applied: number; seen: Map<number, { sha: string; body: string }> }>();
  /** GET .../credit-grants/state (FluxMain's partner API; capability-independent). */
  stateRoute = true;
  private async route(path: string, b: Record<string, unknown>): Promise<Response> {
    const isTarget = path.endsWith("/reversal-target");
    const run = async (x: Record<string, unknown>) => isTarget ? this.target(x) : path.endsWith("/reverse") ? this.reverse(x) : await this.grant(x);
    const rev = b.revision;
    if (rev === undefined) return run(b);
    if (typeof rev !== "number" || !Number.isSafeInteger(rev) || rev < 1) return err(400, "invalid_request", "revision must be a positive integer");
    const id = typeof b.grant_id === "string" ? b.grant_id : "";
    const f = this.fence.get(id) ?? { applied: 0, seen: new Map() };
    const { revision: _rev, ...rest } = b;
    const sha = await hex(JSON.stringify(rest));
    const refusal = (code: string) => j(409, { status: code, error: { code, message: code }, applied_revision: f.applied, latest_revision: f.applied });
    if (rev < f.applied) return refusal("stale_revision");
    const prior = f.seen.get(rev);
    if (prior) return prior.sha === sha ? new Response(prior.body, { status: 200, headers: { "content-type": "application/json" } }) : refusal("idempotency_mismatch");
    const res = await run(isTarget ? b : rest);
    if (res.status === 200) {
      const text = await res.clone().text();
      f.applied = Math.max(f.applied, rev); f.seen.set(rev, { sha, body: text }); this.fence.set(id, f);
    }
    return res;
  }

  private auth(headers: Headers): Response | null {
    if (!this.enabled) return err(404, "not_found", "not found");
    const expected = this.token.trim();
    if (expected.length < 32 || expected.startsWith("sk-flux-") || (this.keysToken && expected === this.keysToken) || (this.masterKey && expected === this.masterKey)) {
      return err(503, "misconfigured", "grants authority is not configured");
    }
    const h = headers.get("authorization") ?? "";
    const presented = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
    if (!presented || presented !== expected) return err(401, "unauthorized", "unauthorized");
    return null;
  }

  private async grant(b0: Record<string, unknown>): Promise<Response> {
    let g: { grantId: string; invoiceId: string; kind: string; homeId: string; accountId: string; plan: string; amount: number; sha: string; periodEnd: number };
    // initial_target: outside the grant's identity and hash; only a grantWithTarget router knows the field (otherwise: unknown field, 400).
    const { initial_target: it0, ...rest } = b0;
    const b = this.grantWithTarget ? rest : b0;
    let it: { target: number; revision: number } | null = null;
    try {
      if (this.grantWithTarget && it0 !== undefined) {
        const t = (it0 ?? {}) as Record<string, unknown>;
        if (typeof it0 !== "object" || it0 === null || Array.isArray(it0) || Object.keys(t).some((k) => k !== "target_removed_microcents" && k !== "revision")) throw new Invalid("initial_target must be an object");
        if (typeof t.target_removed_microcents !== "number" || !Number.isSafeInteger(t.target_removed_microcents) || t.target_removed_microcents < 0) throw new Invalid("target_removed_microcents must be a non-negative integer");
        if (typeof t.revision !== "number" || !Number.isSafeInteger(t.revision) || t.revision < 1) throw new Invalid("revision must be a positive integer");
        it = { target: t.target_removed_microcents, revision: t.revision };
      }
      const id = identity(b, GRANT_FIELDS);
      const amount = b.amount_microcents;
      if (typeof amount !== "number" || !Number.isInteger(amount) || !(amount > 0 && amount <= MAX_AMOUNT)) throw new Invalid("amount_microcents must be an integer, 0 < amount <= 2^53-1");
      const ps = parseTs(b.period_start, "period_start"); const pe = parseTs(b.period_end, "period_end"); const ex = parseTs(b.expires_at, "expires_at");
      if (pe.ms * 1000 + pe.us <= ps.ms * 1000 + ps.us) throw new Invalid("period_end must be after period_start");
      const expected = addOneMonth(pe.ms);
      if (ex.ms !== expected || ex.us !== pe.us) throw new Invalid("expires_at must equal period_end plus one calendar month (UTC)");
      const accountId = text(b, "account_id"); const plan = text(b, "plan");
      const canon = { account_id: accountId, amount_microcents: amount, expires_at: iso(ex), grant_id: id.grantId, home_id: id.homeId, invoice_id: id.invoiceId,
        kind: id.kind, period_end: iso(pe), period_start: iso(ps), plan };
      g = { ...id, accountId, plan, amount, sha: await hex(JSON.stringify(canon)), periodEnd: pe.ms };
    } catch (e) {
      if (e instanceof Invalid) return err(400, "invalid_request", e.message); // store validation: error.message only, no reason
      throw e;
    }
    // 1-3: replays, before any current state.
    const held = this.grants.get(g.grantId);
    if (held) {
      if (held.sha !== g.sha) return err(409, "idempotency_conflict");
      // The replay applies its initial_target with the usual revision rules, in the same step as the answer.
      const target = it && !this.receipts.has(g.grantId) ? this.applyTarget(held, it.target, it.revision) : undefined;
      return j(200, { status: "already_granted", state: held.state, amount_microcents: held.amount,
        available_microcents: Math.max(0, held.amount - held.consumed - held.removed), ...(target ? { target } : {}) });
    }
    const receipt = this.receipts.get(g.grantId);
    if (receipt) return receipt.homeId !== g.homeId ? err(409, "grant_mismatch") : j(200, { status: "not_applied_reversed" });
    // 4-6
    if (!this.issueEnabled) return err(503, "issuance_paused");
    if (!this.redisUp) return retry("unavailable");
    const home = this.homes.get(g.homeId);
    if (!home || home.fenced || home.generation === null) return err(503, "unbound");
    if (home.state !== "active" || home.account !== g.accountId) return err(409, "recipient_mismatch");
    if (this.ceiling === null) return retry("unavailable");
    const delivered = [...this.grants.values()].filter((x) => x.homeId === g.homeId && x.periodEnd === g.periodEnd).reduce((s, x) => s + x.amount - x.removed, 0);
    if (g.amount > this.ceiling || delivered + g.amount > this.ceiling) return err(422, "ceiling");
    if (this.unfresh.has(g.accountId)) return err(409, "account_not_fresh");
    const created: DoubleGrant = { grantId: g.grantId, invoiceId: g.invoiceId, kind: g.kind, homeId: g.homeId, accountId: g.accountId, amount: g.amount,
      sha: g.sha, periodEnd: g.periodEnd, consumed: 0, removed: 0, state: "active" };
    this.grants.set(g.grantId, created);
    this.accountAvailable.set(g.accountId, (this.accountAvailable.get(g.accountId) ?? 0) + g.amount);
    // The grant and its initial target in ONE step: nothing runs between them, and every fault mode affects both or neither.
    const target = it ? this.applyTarget(created, it.target, it.revision) : undefined;
    const available = this.accountAvailable.get(g.accountId)!;
    return j(200, { status: "granted", state: created.state, amount_microcents: g.amount, available_microcents: Math.max(0, g.amount - created.removed),
      account_available_microcents: available, ...(target ? { target } : {}) });
  }
  /** One target applied to a held grant (the reversal-target rules); answers the receipt of the revision the router now holds. A stale or
   *  conflicting revision changes nothing and answers the held revision's receipt (the caller re-sends through the target route). */
  private applyTarget(g: DoubleGrant, target: number, revision: number): Record<string, unknown> {
    const held = this.targets.get(g.grantId) ?? { revision: 0, target: 0 };
    if (revision > held.revision) {
      const removed = Math.max(0, Math.min(target, g.amount - g.consumed));
      this.accountAvailable.set(g.accountId, (this.accountAvailable.get(g.accountId) ?? 0) - (removed - g.removed));
      g.removed = removed;
      if (g.state !== "expired") g.state = removed > 0 ? "reversed" : "active";
      held.revision = revision; held.target = target;
      this.targets.set(g.grantId, held);
    }
    return { status: "applied", grant_id: g.grantId, revision: held.revision, removed_microcents: g.removed, consumed_microcents: g.consumed,
      ...(this.echoTargets ? { target_removed_microcents: held.target } : {}) };
  }
  /** The router's account of one grant: tombstoned (a /reverse before it existed), reversed (by /reverse), active, or not_found. */
  private state(qs: URLSearchParams): Response {
    const id = qs.get("grant_id") ?? ""; const home = qs.get("home_id") ?? "";
    const receipt = this.receipts.get(id); const g = this.grants.get(id);
    if (home && ((receipt && receipt.homeId !== home) || (g && g.homeId !== home))) return err(409, "grant_mismatch");
    const state = receipt ? (receipt.outcome === "no_grant" ? "tombstoned" : "reversed") : g ? (g.state === "expired" ? "expired" : "active") : "not_found";
    return j(200, { grant_id: id, state, removed_microcents: receipt ? receipt.removed : g?.removed ?? 0, consumed_microcents: g?.consumed ?? 0,
      applied_revision: this.fence.get(id)?.applied ?? 0, remaining_microcents: g ? Math.max(0, g.amount - g.consumed - g.removed) : 0 });
  }

  private reverse(b: Record<string, unknown>): Response {
    let r: { grantId: string; invoiceId: string; kind: string; homeId: string };
    try { r = identity(b, REVERSE_FIELDS); text(b, "reason", 500); } catch (e) {
      if (e instanceof Invalid) return err(400, "invalid_request", e.message); // store validation: error.message only, no reason
      throw e;
    }
    // wp5-p5: a grant with any reversal target is never finally reversed by the legacy route.
    if (this.targets.has(r.grantId)) return err(409, "reversal_target_held");
    const receipt = this.receipts.get(r.grantId);
    if (receipt) {
      if (receipt.homeId !== r.homeId || receipt.invoiceId !== r.invoiceId || receipt.kind !== r.kind) return err(409, "grant_mismatch");
      return receipt.outcome === "no_grant" ? j(200, { status: "no_grant", removed_microcents: 0, consumed_microcents: 0 })
        : j(200, { status: "already_reversed", removed_microcents: receipt.removed, consumed_microcents: receipt.consumed });
    }
    const g = this.grants.get(r.grantId);
    if (!g) {
      this.receipts.set(r.grantId, { homeId: r.homeId, invoiceId: r.invoiceId, kind: r.kind, outcome: "no_grant", removed: 0, consumed: 0 });
      return j(200, { status: "no_grant", removed_microcents: 0, consumed_microcents: 0 });
    }
    if (g.homeId !== r.homeId || g.invoiceId !== r.invoiceId || g.kind !== r.kind) return err(409, "grant_mismatch");
    const remainder = Math.max(0, g.amount - g.consumed - g.removed);
    g.removed += remainder; if (g.state !== "expired") g.state = "reversed"; // RETAINED, closed reversed; an expired grant stays expired
    this.accountAvailable.set(g.accountId, (this.accountAvailable.get(g.accountId) ?? 0) - remainder);
    this.receipts.set(r.grantId, { homeId: r.homeId, invoiceId: r.invoiceId, kind: r.kind, outcome: "removed", removed: remainder, consumed: g.consumed });
    return j(200, { status: "reversed", removed_microcents: remainder, consumed_microcents: g.consumed });
  }

  /** The reversal-target contract: a revision older than the one held is refused (409 stale_revision, nothing changes); the same revision
   *  with the same target answers the same receipt (idempotent), with another target 409 revision_conflict; a newer one sets what is removed
   *  from the grant to min(target, amount - consumed): more removed when it rises, RESTORED when it falls, consumed credit never touched.
   *  The receipt names the revision applied. A grant fully reversed (final, the /reverse route) is not targeted (409 grant_reversed). */
  private target(b: Record<string, unknown>): Response {
    let r: { grantId: string; invoiceId: string; kind: string; homeId: string }; let target: number; let revision: number; let adopt = false;
    try {
      const { target_removed_microcents: t, revision: v, ...rest0 } = b;
      const { adopt_legacy_reversal: adopt0, ...rest } = this.adoptLegacyReversal ? rest0 : { ...rest0, adopt_legacy_reversal: undefined };
      if (!this.adoptLegacyReversal && "adopt_legacy_reversal" in rest0) throw new Invalid("unknown field(s) in body");
      if (adopt0 !== undefined && adopt0 !== true) throw new Invalid("adopt_legacy_reversal must be true");
      adopt = adopt0 === true;
      r = identity(rest, REVERSE_FIELDS); text(rest, "reason", 500);
      if (typeof t !== "number" || !Number.isSafeInteger(t) || t < 0) throw new Invalid("target_removed_microcents must be a non-negative integer");
      if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) throw new Invalid("revision must be a positive integer");
      target = t; revision = v;
    } catch (e) {
      if (e instanceof Invalid) return err(400, "invalid_request", e.message);
      throw e;
    }
    const g = this.grants.get(r.grantId);
    if (!g) return err(404, "grant_not_found");
    if (g.homeId !== r.homeId || g.invoiceId !== r.invoiceId || g.kind !== r.kind) return err(409, "grant_mismatch");
    const finalReceipt = this.receipts.get(r.grantId);
    if (finalReceipt && !(adopt && finalReceipt.outcome === "removed")) return err(409, "grant_reversed");
    // Adoption: the /reverse removal becomes the target held at revision 0 (the grant leaves the final state; a late /reverse is refused).
    if (finalReceipt) { this.receipts.delete(r.grantId); this.targets.set(r.grantId, { revision: 0, target: finalReceipt.removed }); }
    const held = this.targets.get(r.grantId) ?? { revision: 0, target: 0 };
    const receipt = () => j(200, { status: "applied", grant_id: r.grantId, revision: held.revision, removed_microcents: g.removed, consumed_microcents: g.consumed,
      ...(this.echoTargets ? { target_removed_microcents: held.target } : {}) });
    if (revision < held.revision) return j(409, { status: "stale_revision", error: { code: "stale_revision", message: "stale_revision" }, latest_revision: held.revision });
    if (revision === held.revision) return held.target === target ? receipt()
      : j(409, { status: "revision_conflict", error: { code: "revision_conflict", message: "revision_conflict" }, latest_revision: held.revision });
    const removed = Math.max(0, Math.min(target, g.amount - g.consumed));
    this.accountAvailable.set(g.accountId, (this.accountAvailable.get(g.accountId) ?? 0) - (removed - g.removed));
    g.removed = removed;
    if (g.state !== "expired") g.state = removed > 0 ? "reversed" : "active";
    held.revision = revision; held.target = target;
    this.targets.set(r.grantId, held);
    return receipt();
  }

  private usage(q: URLSearchParams): Response {
    const home = q.get("home_id") ?? "";
    const fix = (s: string) => s.trim().replace(/ (\d\d:\d\d)$/, "+$1");
    let start: { ms: number; us: number }; let end: { ms: number; us: number };
    try {
      if (!HOME_RE.test(home)) throw new Invalid("home_id is not a valid home id");
      start = parseTs(fix(q.get("period_start") ?? ""), "period_start"); end = parseTs(fix(q.get("period_end") ?? ""), "period_end");
      if (end.ms * 1000 + end.us <= start.ms * 1000 + start.us) throw new Invalid("period_end must be after period_start");
    } catch (e) {
      if (e instanceof Invalid) return err(400, "invalid_request", e.message);
      throw e;
    }
    if (this.usageFault) return retry("unavailable");
    const consumed = [...this.grants.values()].filter((g) => g.homeId === home && g.periodEnd > start.ms && g.periodEnd <= end.ms).reduce((s, g) => s + g.consumed, 0);
    return j(200, { consumed_microcents: consumed });
  }
}
