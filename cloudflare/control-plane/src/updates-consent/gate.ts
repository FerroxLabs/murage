// Updates consent request paths (design UPDATES-CONSENT-1020-CP-v5.md v5.6.1, 3.3): the one bind scheme and the request batches.
// Every statement text comes from ./sql-design (generated from the prepared design SQL). This file only orders them and binds them.
import * as Q from "./sql-design";
import { RS3c } from "./sql-b1";

declare global {
  interface Env {
    /** "1" opens the new signup paths. Refused unless CP_ONECLICK_DKIM_VERIFIED is also "1" (T-C1, design 7.2; test 67). Default off. */
    UPDATES_SIGNUPS_OPEN?: string;
    /** "1" only after T-C1 showed DKIM h= covering List-Unsubscribe and List-Unsubscribe-Post on real CP mail. Set by Sean. Default off. */
    CP_ONECLICK_DKIM_VERIFIED?: string;
    /** The current token key version (3.4). Unset means 1. */
    UPDATES_TOKEN_KEY_VERSION?: string;
  }
  namespace Cloudflare {
    interface Env {
      UPDATES_SIGNUPS_OPEN?: string;
      CP_ONECLICK_DKIM_VERIFIED?: string;
      UPDATES_TOKEN_KEY_VERSION?: string;
    }
  }
}

export const DAY_MS = 24 * 60 * 60 * 1_000;
export const PROVE_TOKEN_MS = 7 * DAY_MS;
export const MAIL_CAP_WINDOW_MS = DAY_MS;

/** T-C1 as a gate (design 7.2, test 67): signups open only when BOTH flags are exactly "1". Both default off. */
export function updatesSignupsOpen(env: Env): boolean {
  return String(env.UPDATES_SIGNUPS_OPEN ?? "").trim() === "1" && String(env.CP_ONECLICK_DKIM_VERIFIED ?? "").trim() === "1";
}

export function tokenKeyVersion(env: Env): number {
  const raw = String(env.UPDATES_TOKEN_KEY_VERSION ?? "").trim();
  const n = raw === "" ? 1 : Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error("updates_token_key_version_invalid");
  return n;
}

/** Binds a design statement by its numbered parameters: exactly as many values as the highest ?N it names, unused numbers NULL. */
export function bindNumbered(db: D1Database, sql: string, values: Readonly<Record<number, unknown>>): D1PreparedStatement {
  let max = 0;
  for (const m of sql.matchAll(/\?(\d+)/g)) max = Math.max(max, Number(m[1]));
  const args: unknown[] = [];
  for (let i = 1; i <= max; i++) args.push(values[i] ?? null);
  return db.prepare(sql).bind(...args);
}

export type RequestPath = "desktop" | "forwarder" | "legacy" | "members";
export type RequestOutcome = "pending" | "refused" | "rate_limited" | "invalid" | "admitted" | "capped" | "noop";
export type ProveTemplate = "prove" | "prove_waitlist";

/** The common binds (3.3 "One bind scheme"). Numbers are the design's. */
export interface GateBinds {
  consentId: string; // ?1
  subjectRef: string | null; // ?2 receiptHash (desktop) or account id (members)
  email: string; // ?3
  emailKey: string; // ?4
  textVersion: string; // ?5
  installId: string | null; // ?6
  appVersion: string; // ?7
  answeredAt: number; // ?8
  now: number; // ?9
  currentReceipt: string | null; // ?10
  proveTokenHash: string; // ?11
  keyVersion: number; // ?12
  outboxId: string; // ?14
  mailCapKey: string; // ?15
  nonce: string; // ?17
  template: ProveTemplate; // ?18
  withGuide: boolean; // ?20
  forwarderSource: string | null; // ?21
  consentWords: string | null; // ?22
  source: string; // ?23
  requestId: string; // ?24
  path: RequestPath; // ?25
  limits?: { firstKey: string; firstCutoff: number; firstMax: number; secondKey: string; secondCutoff: number; secondMax: number }; // ?26-?30, ?32
  subjectId: string; // ?33
  payloadHash: string; // ?34
  emailRevision?: number | null; // ?35
}

export function bindValues(b: GateBinds): Record<number, unknown> {
  return {
    1: b.consentId, 2: b.subjectRef, 3: b.email, 4: b.emailKey, 5: b.textVersion, 6: b.installId, 7: b.appVersion, 8: b.answeredAt,
    9: b.now, 10: b.currentReceipt, 11: b.proveTokenHash, 12: b.keyVersion, 13: b.now + PROVE_TOKEN_MS, 14: b.outboxId, 15: b.mailCapKey,
    16: b.now - MAIL_CAP_WINDOW_MS, 17: b.nonce, 18: b.template, 20: b.withGuide ? 1 : 0, 21: b.forwarderSource, 22: b.consentWords,
    23: b.source, 24: b.requestId, 25: b.path,
    26: b.limits?.firstKey, 27: b.limits?.firstCutoff, 28: b.limits?.firstMax, 29: b.limits?.secondKey, 30: b.limits?.secondMax,
    32: b.limits?.secondCutoff, 33: b.subjectId, 34: b.payloadHash, 35: b.emailRevision ?? null,
  };
}

const MINT = [Q.G, Q.GC, Q.GT, Q.GO, Q.GD, Q.RO] as const;

/** The batch for each path, in the design's order (3.3 table). The last statement of the forwarder and members batches is the read-back. */
export function desktopBatch(db: D1Database, b: GateBinds): D1PreparedStatement[] {
  const v = bindValues(b);
  // RS3c (B1 r3 Astra M): an address change on a receipt record clears its reads whether RQ fixed pending or refused.
  return [Q.RQ, RS3c, Q.RS1, Q.RS2, Q.RS3, Q.RS3r, Q.RS2b, Q.RS4, ...MINT, Q.RQQ].map((s) => bindNumbered(db, s, v));
}

/** Forwarder and 1.0.19 (the same statements; 1.0.19 binds ?21 NULL, ?23 'legacy_desktop', ?25 'legacy'). */
export function signupBatch(db: D1Database, b: GateBinds): D1PreparedStatement[] {
  if (!b.limits) throw new Error("signup_batch_needs_limits");
  const v = bindValues(b);
  return [Q.RQ, Q.FL1, Q.FL2, Q.FL3, Q.FS0, Q.FS1, Q.FS2, Q.FS2b, Q.FS4, ...MINT, Q.RQQ].map((s) => bindNumbered(db, s, v));
}

export function membersOnBatch(db: D1Database, b: GateBinds): D1PreparedStatement[] {
  const v = bindValues(b);
  return [Q.RQ, Q.AO1, Q.AO2, ...MINT, Q.RQQ, Q.AOQ].map((s) => bindNumbered(db, s, v));
}

/** RJ then RJQ: the terminal rejection of an invalid forwarder submission (3.3). */
export function rejectBatch(db: D1Database, v: { requestId: string; path: RequestPath; payloadHash: string; nonce: string; now: number }): D1PreparedStatement[] {
  const values = { 9: v.now, 17: v.nonce, 24: v.requestId, 25: v.path, 34: v.payloadHash };
  return [bindNumbered(db, Q.RJ, values), bindNumbered(db, Q.RJQ, values)];
}

/** The outcome RQQ read (the first delivery's, for a replay too). */
export function outcomeOf(results: D1Result[], index: number): RequestOutcome | null {
  const row = results[index]?.results?.[0] as { outcome?: RequestOutcome } | undefined;
  return row?.outcome ?? null;
}
