// Updates consent B1: the members area (design UPDATES-CONSENT-1020-CP-v5.md v5.6.1, 4.2 and 3.3 "AO and AF").
// GET /v1/updates-consent and GET /v1/updates-consent/history resolve the member read-only (customer-identity.ts); POST resolves it
// with resolveCloudAccount. Switch on is RQ, AO1, AO2, G, GC, GT, GO, GD, RO, RQQ, AOQ (membersOnBatch); switch off is AF (W keyed by
// the account). D1 only: no provider is called.
import { z } from "zod";

import type { CustomerSession } from "../customer-identity";
import { HTTPError, json, readBoundedJSON } from "../http";
import { bindNumbered, membersOnBatch, outcomeOf, tokenKeyVersion, updatesSignupsOpen, type GateBinds } from "./gate";
import { isUpdatesMembersPath, MEMBERS_HISTORY_ROUTE, UPDATES_BASE } from "./paths";
import { proveBinds, selectableTextVersion, validAnsweredAt, withdrawBatch } from "./routes";
import * as B from "./sql-b1";
import * as Q from "./sql-design";
import { emailKeyOf, sha256Hex } from "./tokens";

const ROW = `SELECT id, status, text_version, answered_at, proven_at, email_key FROM updates_consent WHERE subject_id=?1`;
const IDENTITY = `SELECT contact_email, email_revision, email_conflict FROM supabase_identities WHERE user_id=?1`;
/** Read in the switch-on batch, after AOQ: does the identity AO1 checked still stand? (409 `retry` when not.) */
const IDENTITY_STANDS = `SELECT count(*) AS n FROM supabase_identities WHERE user_id=?2 AND lower(trim(contact_email))=?3 AND email_revision=?35
AND email_conflict IS NULL`;
/** otherSignups (4.2, on off): this address's other proven, opted-in rows (receipts and signups), counted only when this row was proven. */
const OTHERS = `SELECT count(*) AS n FROM updates_consent WHERE email_key=?1 AND subject_id<>?2 AND status='opted_in' AND proven_at IS NOT NULL`;

const membersBody = z.strictObject({
  status: z.enum(["opted_in", "withdrawn"]),
  textVersion: z.string().max(40),
  answeredAt: z.unknown(),
  /** The address the page shows; a stale page posting an old one answers 409 `retry`. */
  email: z.string().max(254).optional(),
  appVersion: z.literal("site").optional(),
  source: z.literal("site").optional(),
});

interface Row { id: string; status: string; text_version: string; answered_at: number; proven_at: number | null; email_key: string }
export type MembersConsent = { status: string; textVersion: string; answeredAt: number; proven: boolean; mailPending?: boolean };

/** The GET body's record for an account: null when no row; `mailPending` (AOQ) only while opted in and unproven. */
export async function membersRecord(db: D1Database, accountId: string, now: number, keyVersion: number): Promise<MembersConsent | null> {
  const subject = `account:${accountId}`;
  const [rowResult, aoq] = await db.batch([bindNumbered(db, ROW, { 1: subject }), bindNumbered(db, Q.AOQ, { 9: now, 12: keyVersion, 33: subject })]);
  const row = rowResult?.results?.[0] as Row | undefined;
  if (!row) return null;
  const record: MembersConsent = { status: row.status, textVersion: row.text_version, answeredAt: row.answered_at, proven: row.proven_at !== null };
  const live = aoq?.results?.[0] as Record<string, unknown> | undefined;
  if (live) record.mailPending = Number(Object.values(live)[0] ?? 0) > 0;
  return record;
}

const body = (consent: MembersConsent | null, extra: Record<string, number> = {}) => json({ consent, ...extra, cloudContractVersion: 1 });

/** The account of a resolved session; null for no session or an unresolved read-only one. */
function accountOf(session: CustomerSession | null): string | null {
  return !session || session.unresolved || !session.user.id ? null : session.user.id;
}

/** GET, GET history and POST on the member paths; null for any other method or path. */
export async function updatesMembersRoute(request: Request, env: Env, customer: () => Promise<CustomerSession | null>): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!isUpdatesMembersPath(path)) return null;
  const isGet = request.method === "GET";
  if (!isGet && !(request.method === "POST" && path === UPDATES_BASE)) return null;
  const session = await customer();
  if (!session) throw new HTTPError(401, "unauthorized");
  const now = Date.now();
  const keyVersion = tokenKeyVersion(env);
  const accountId = accountOf(session);
  if (isGet) {
    if (path === MEMBERS_HISTORY_ROUTE) {
      if (!accountId) return json({ consent: null, events: [], cloudContractVersion: 1 });
      const consent = await membersRecord(env.DB, accountId, now, keyVersion);
      const events = await env.DB.prepare(B.EXPORT_EVENTS).bind(`account:${accountId}`).all<Record<string, unknown>>();
      return json({
        consent,
        events: (events.results ?? []).map((e) => ({
          at: e.at as number, fromStatus: (e.from_status as string | null) ?? null, toStatus: (e.to_status as string | null) ?? null,
          generation: e.generation as number, textVersion: (e.text_version as string | null) ?? null, actor: e.actor as string,
        })),
        cloudContractVersion: 1,
      });
    }
    return body(accountId ? await membersRecord(env.DB, accountId, now, keyVersion) : null);
  }
  if (!accountId) throw new HTTPError(401, "unauthorized");
  const parsed = membersBody.safeParse(await readBoundedJSON(request));
  if (!parsed.success) throw new HTTPError(400, "invalid_request");
  const identity = await env.DB.prepare(IDENTITY).bind(accountId)
    .first<{ contact_email: string | null; email_revision: number; email_conflict: string | null }>();
  if (!identity) throw new HTTPError(409, "retry");
  // No usable contact address (NULL or blank): nothing to record consent for. Unreachable through fetch today: resolveCloudAccount
  // (cloud-accounts.ts fromMapped) reads contact_email first and throws on NULL, and a blank one is moved by reconcileEmail.
  const email = (identity.contact_email ?? "").trim().toLowerCase();
  if (!email) throw new HTTPError(409, "no_contact_email");
  if (identity.email_conflict !== null) throw new HTTPError(409, "retry");
  if (parsed.data.email !== undefined && parsed.data.email.trim().toLowerCase() !== email) throw new HTTPError(409, "retry");
  const subject = `account:${accountId}`;

  if (parsed.data.status === "withdrawn") {
    // AF (3.3): W keyed by the account, actor 'account'. otherSignups only when this row was proven (v4 L11, kept).
    const before = await env.DB.prepare(ROW).bind(subject).first<Row>();
    await env.DB.batch(withdrawBatch(env.DB, subject, "account", now));
    const others = before?.proven_at != null
      ? (await env.DB.prepare(OTHERS).bind(before.email_key, subject).first<{ n: number }>())?.n ?? 0 : 0;
    return body(await membersRecord(env.DB, accountId, now, keyVersion), { otherSignups: others });
  }

  const answeredAt = validAnsweredAt(parsed.data.answeredAt, now);
  const textVersion = await selectableTextVersion(env.DB, parsed.data.textVersion);
  // T-C1 (test 67): closed, the switch writes nothing and answers the GET body, as a refused key does.
  if (!updatesSignupsOpen(env)) return body(await membersRecord(env.DB, accountId, now, keyVersion));
  const emailKey = await emailKeyOf(email, env.BETTER_AUTH_SECRET);
  const b: GateBinds = {
    consentId: crypto.randomUUID(), subjectRef: accountId, email, emailKey, textVersion, installId: null, appVersion: "site", answeredAt, now,
    currentReceipt: null, keyVersion, ...await proveBinds(env, emailKey, keyVersion), nonce: crypto.randomUUID(), template: "prove",
    withGuide: false, forwarderSource: null, consentWords: null, source: "site",
    // The identity revision is part of the id (B1 r1 Grok M4): a switch on that met a moved identity (409 `retry` below) leaves its id as
    // a noop tombstone, and the retry after the move reads the new revision, so it is a new request and AO1 runs.
    requestId: `acct:${accountId}:${identity.email_revision}:${answeredAt}`, path: "members",
    subjectId: subject, payloadHash: await sha256Hex(JSON.stringify([accountId, email, answeredAt, textVersion])),
    emailRevision: identity.email_revision,
  };
  const stmts = [...membersOnBatch(env.DB, b), bindNumbered(env.DB, IDENTITY_STANDS, { 2: accountId, 3: email, 35: identity.email_revision })];
  const results = await env.DB.batch(stmts);
  const outcome = outcomeOf(results, stmts.length - 3);
  const stands = Number((results[stmts.length - 1]?.results?.[0] as { n?: number } | undefined)?.n ?? 0) === 1;
  // AO1 matched nothing because the identity moved between the read and the batch: 409 `retry`; G minted nothing (AO1 wrote no nonce).
  if (!stands && outcome !== "refused") throw new HTTPError(409, "retry");
  return body(await membersRecord(env.DB, accountId, now, keyVersion));
}
