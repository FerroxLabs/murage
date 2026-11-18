// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { REJECT_KINDS } from "../src/checkout-moments";
import { ALERT_TIER, PAGE_GROUPS, PAGE_KINDS, alertTier } from "../src/alert-tiers";

// @ts-expect-error import.meta.glob is Vite's (vitest transforms it); the worker tsconfig does not load vite/client types.
const sources = import.meta.glob("../src/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** Dotted names that are passed to those calls but are not alert kinds. */
const NOT_KINDS = new Set(["cloud_homes.id", "h.id", "h.owner_id", "o.id", "invoice.paid", "invoice.payment_failed", "daily.summary", "page.alert_storm", "pool.create_fail"]);
const KIND = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/;
/** Every call that raises or records an alert: record(, raise(, openOrAddAlertStmts( and any helper with "alert" in its name (raiseAlert,
 *  persistAlert, alertStatement, subjectAlertStatements, refundAlert, guardedAlert, ...). The kind literal is anywhere in its argument
 *  list, however many lines that spans. */
const CALLS = /\b(?:record|raise|openOrAddAlertStmts|\w*[aA]lert\w*)\s*\(/g;
const ALERT_CONST = /\b[A-Z_]*ALERT[A-Z_]*\s*=\s*["'`]([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)["'`]/g;
const SQL_KIND = /'([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)'/g;

/** Template-literal kinds (`checkout.${verdict}`) the scan cannot read off the text. Each one must be listed here with every concrete kind it
 *  raises (the union the placeholder ranges over); an unlisted one is reported as a missing kind, so a new computed kind cannot slip past. */
const EXPANSIONS: Record<string, string[]> = {
  "checkout.${}": ["checkout.rejected_consent", "checkout.mismatch", "checkout.country_paused"],
  "checkout.replacement_${}": ["checkout.replacement_async_payment_failed", "checkout.replacement_expired"],
  "pool.tick_${}": ["pool.tick_grabber", "pool.tick_fast"],
  // The image name is part of the kind (one open alert per image), so it cannot be listed: these fall to the digest default, asserted below.
  "image.sig_expiry_${}d.${}": [],
  "plan.resize_${}": ["plan.resize_failed", "plan.resize_unhealthy"],
};
/** The kinds a literal body stands for: itself, its listed expansion, or an "UNEXPANDED" marker (which is never in ALERT_TIER). */
function kindsOfBody(body: string): string[] {
  if (KIND.test(body)) return [body];
  const shape = body.replace(/\$\{[^}]*\}/g, "${}");
  if (shape === body || !/^[a-z][a-z0-9_]*(?:\.[a-z0-9_${}]+)+$/.test(shape)) return [];
  return EXPANSIONS[shape] ?? [`UNEXPANDED:${shape}`];
}

/** Kind-shaped string literals in the balanced argument list that opens at `open` (a "("), and where that list ends. Strings are skipped
 *  whole, so a paren inside SQL never ends the list, and no line window applies. */
function argsFrom(text: string, open: number): { kinds: string[]; end: number } {
  const kinds: string[] = [];
  let depth = 0, i = open;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")") { if (--depth === 0) break; }
    else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      const body = text.slice(i + 1, j);
      kinds.push(...kindsOfBody(body));
      i = j;
    }
  }
  return { kinds, end: i };
}
const literalsInArgs = (text: string, open: number): string[] => argsFrom(text, open).kinds;

function raisedKinds(): Map<string, string> {
  const found = new Map<string, string>();
  const note = (kind: string, path: string, text: string, at: number) => {
    if (!NOT_KINDS.has(kind) && !found.has(kind)) found.set(kind, `${path}:${text.slice(0, at).split("\n").length}`);
  };
  for (const [path, text] of Object.entries(sources)) {
    if (path.endsWith("/alert-tiers.ts")) continue;
    for (const m of text.matchAll(CALLS)) for (const kind of literalsInArgs(text, m.index! + m[0].length - 1)) note(kind, path, text, m.index!);
    for (const m of text.matchAll(ALERT_CONST)) note(m[1], path, text, m.index!);
    // A raw INSERT INTO cloud_alerts: the kind is a quoted literal in the SQL, or in the call that holds the SQL (q("INSERT ...", id, home,
    // "kind", ...)), or in the .bind( that follows .prepare("INSERT ..."). Take all three.
    for (const m of text.matchAll(/INSERT INTO cloud_alerts/g)) {
      const end = text.slice(m.index!).search(/[`"]/);
      for (const k of text.slice(m.index!, end < 0 ? undefined : m.index! + end).matchAll(SQL_KIND)) note(k[1], path, text, m.index!);
      const quote = Math.max(text.lastIndexOf("`", m.index!), text.lastIndexOf('"', m.index!));
      const open = text.slice(0, quote).search(/\(\s*$/);
      if (open < 0) continue;
      const call = argsFrom(text, open);
      for (const kind of call.kinds) note(kind, path, text, m.index!);
      const bind = /^\s*\.bind\(/.exec(text.slice(call.end + 1, call.end + 40));
      if (bind) for (const kind of literalsInArgs(text, call.end + bind[0].length)) note(kind, path, text, m.index!);
    }
  }
  return found;
}

describe("alert tiers", () => {
  it("scans the source (a sanity floor, so an empty scan cannot pass)", () => {
    const found = raisedKinds();
    expect(found.size).toBeGreaterThan(100);
    for (const k of ["provision.failed", "home.heartbeat_missed", "pool.secret_misuse", "billing.webhook_stuck", "image.sales_hold"]) expect(found.has(k)).toBe(true);
  });
  it("classifies every kind raised in src/: a new kind must be added to ALERT_TIER", () => {
    const missing = [...raisedKinds()].filter(([kind]) => !(kind in ALERT_TIER)).map(([kind, where]) => `${kind} (${where})`);
    expect(missing).toEqual([]);
  });
  it("lists every checkout rejection kind in the template expansion, and classifies each expanded kind as digest", () => {
    expect([...EXPANSIONS["checkout.${}"]].sort()).toEqual(REJECT_KINDS.map((k) => `checkout.${k}`).sort());
    expect(alertTier("image.sig_expiry_30d.some-image").tier).toBe("digest");
    for (const kinds of Object.values(EXPANSIONS)) for (const k of kinds) expect(alertTier(k).tier, k).toBe("digest");
  });
  it("gives every page entry a group that exists and a 'Do this' action", () => {
    expect(PAGE_KINDS.length).toBeGreaterThan(10);
    for (const kind of PAGE_KINDS) {
      const e = ALERT_TIER[kind];
      expect(e.tier).toBe("page");
      if (e.tier !== "page") continue;
      expect(typeof e.action === "string" && e.action.trim().length > 10, `${kind} has no action`).toBe(true);
      expect(PAGE_GROUPS[e.group], `${kind} names an unknown group`).toBeDefined();
    }
  });
  it("keeps house copy in the page words: no dashes, and none of the banned words", () => {
    const words = [...PAGE_KINDS.map((k) => { const e = ALERT_TIER[k]; return e.tier === "page" ? e.action : ""; }), ...Object.values(PAGE_GROUPS).map((g) => g.title)];
    for (const w of words) { expect(w).not.toMatch(/[\u2013\u2014]/); expect(w).not.toMatch(/\b(safe|unsafe|safety)\b/i); }
  });
  it("lists the design's page kinds, and treats an unknown kind as digest", () => {
    const group = (k: string) => { const e = alertTier(k); return e.tier === "page" ? e.group : "digest"; };
    expect(group("provision.failed")).toBe("homes.not_created");
    expect(group("home.heartbeat_missed")).toBe("homes.unhealthy");
    expect(group("home.watchdog_exhausted")).toBe("homes.repair_gave_up");
    expect(group("update.stuck")).toBe("homes.repair_gave_up");
    expect(group("rollout.halted")).toBe("rollout.halted");
    expect(group("image.env_conflict")).toBe("sales.stopped");
    expect(group("billing.webhook_stuck")).toBe("checkout.stuck");
    expect(group("pool.secret_misuse")).toBe("account.compromise");
    expect(group("access.provider_action_unexpected")).toBe("account.compromise");
    expect(group("home.disk_high")).toBe("digest");
    expect(group("home.backup_stale")).toBe("digest");
    expect(group("access.unmonitored")).toBe("digest");
    expect(group("never.heard.of.it")).toBe("digest");
  });
  it("the page tier holds money taken with nothing delivered: a charged top-up or plan grant the router will not take", () => {
    for (const k of ["flux.account_not_fresh", "topup.paid_not_granted", "credit.topup_ceiling", "credit.grant_exhausted"]) {
      const e = alertTier(k); expect(e.tier, k).toBe("page");
      if (e.tier === "page") expect(e.group).toBe("credit.undelivered");
    }
    expect(PAGE_GROUPS["credit.undelivered"]).toBeDefined();
    // Raised with no charge, or about money we owe back rather than a customer left without credit: digest.
    for (const k of ["topup.flux_ineligible", "topup.precheck_refused", "topup.not_applied", "credit.reversal_ceiling", "credit.grant_suppressed", "credit.grant_pending"]) expect(alertTier(k).tier, k).toBe("digest");
  });
  it("pages Flux switched on with a secret missing: both credential alerts, one group (PRODFLUX, MurageMain)", () => {
    for (const k of ["credit.flux_service_token_absent", "credit.grants_token_absent"]) {
      const e = alertTier(k); expect(e.tier, k).toBe("page");
      if (e.tier === "page") expect(e.group).toBe("flux.secret_missing");
    }
    expect(PAGE_GROUPS["flux.secret_missing"]).toBeDefined();
    expect(alertTier("credit.grants_url_absent").tier).toBe("digest");
  });
  it("pages a held email check and a disputed proof on a linked account, each with a runbook action (FLUX-ENSURE-EMAIL-VERIFIED)", () => {
    for (const [k, g] of [["credit.email_unverified_hold", "credit.email_unverified"], ["credit.email_proof_disputed", "credit.email_proof_disputed"]] as const) {
      const e = alertTier(k); expect(e.tier, k).toBe("page");
      if (e.tier === "page") { expect(e.group).toBe(g); expect(e.action).toContain("runbook"); }
      expect(PAGE_GROUPS[g]).toBeDefined();
    }
  });
  it("CLOUD-DISPUTE-UNLINKED-DIGEST: a disputed proof on an unlinked account is DIGEST, never a page; the linked one still pages", () => {
    expect(alertTier("credit.email_proof_disputed_unlinked")).toEqual({ tier: "digest" });
    expect(Object.prototype.hasOwnProperty.call(ALERT_TIER, "credit.email_proof_disputed_unlinked")).toBe(true);
    expect(PAGE_KINDS).not.toContain("credit.email_proof_disputed_unlinked");
    expect(alertTier("credit.email_proof_disputed").tier).toBe("page");
  });
  it("ITEM4-PROOF-CURRENT: the wake that ran out, a 202 to a proven call and the M-d link mismatch each page, with a runbook action", () => {
    for (const [k, g] of [["flux.email_wake_exhausted", "flux.email_wake_exhausted"], ["flux.ensure_verified_refused", "flux.ensure_verified_refused"],
      ["flux.link_email_mismatch_unlinked", "flux.link_email_mismatch"]] as const) {
      const e = alertTier(k); expect(e.tier, k).toBe("page");
      if (e.tier === "page") { expect(e.group).toBe(g); expect(e.action).toMatch(/runbook/); }
      expect(PAGE_GROUPS[g]).toBeDefined();
    }
    const md = alertTier("flux.link_email_mismatch_unlinked");
    if (md.tier === "page") expect(md.action).toContain("It is an automatic page to the Cloud alerts channel for its owner (MurageCloud), and to Sean personally only if money is involved. Flux (FluxMain) re-points the link on MurageMain's word, and that decision is posted in the same channel. Do not change anything yourself.");
  });
  it("never holds back or folds a compromise page under the cap", () => {
    expect(PAGE_GROUPS["account.compromise"].bypassCap).toBe(true);
    expect(PAGE_GROUPS["control.down"].bypassCap).toBe(true);
  });
  it("CH1: a spending stop Flux has not confirmed and a never-delivered key still not revoked are PAGES, each with an action and a group", () => {
    for (const [k, g] of [["flux.spending_off_unconfirmed", "flux.spending_off"], ["flux.undelivered_key_unrevoked", "flux.key_unrevoked"]] as const) {
      const e = alertTier(k); expect(e.tier, k).toBe("page");
      if (e.tier === "page") { expect(e.group).toBe(g); expect(e.threshold).toBeUndefined(); expect(e.action.length).toBeGreaterThan(30); }
      expect(PAGE_GROUPS[g]).toBeDefined();
      expect(PAGE_KINDS).toContain(k);
    }
  });
  it("CH1: flux.stop_pending pages only once it is an hour old (minAgeMs on its threshold); it is in its own group", () => {
    const e = alertTier("flux.stop_pending");
    expect(e.tier).toBe("page");
    if (e.tier === "page") { expect(e.group).toBe("flux.stop_stuck"); expect(e.threshold).toEqual({ minHomes: 1, minAgeMs: 60 * 60_000 }); }
    expect(PAGE_GROUPS["flux.stop_stuck"]).toBeDefined();
  });
  it("CH1: the new copy has no dashes and none of the banned words", () => {
    const banned = /\b(safe|unsafe|safety|free|forge|will fail)\b/i;
    for (const k of ["flux.spending_off_unconfirmed", "flux.undelivered_key_unrevoked", "flux.stop_pending"]) {
      const e = alertTier(k); if (e.tier !== "page") throw new Error(k);
      for (const w of [e.action, PAGE_GROUPS[e.group].title]) { expect(w).not.toMatch(/[\u2013\u2014]/); expect(w).not.toMatch(banned); }
    }
  });
});
