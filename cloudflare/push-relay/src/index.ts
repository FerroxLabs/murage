// The Worker. Configuration comes from wrangler.jsonc vars and secrets;
// a platform whose secret is missing simply cannot register or deliver:
// its provider is null and its sends are "rejected", never guessed at.
//
// Secrets, none of them ever logged. Upload them with `wrangler secret bulk
// <file.json>` (docs/mobile/phase3/RELAY.md), never `wrangler secret put`
// fed on stdin: that stored APNS_KEY empty on 2026-09-27, and a platform
// whose secret is empty is silently off.
//   APNS_KEY                         the APNs .p8 key, PEM text
//   FCM_SERVICE_ACCOUNT              the Firebase service-account JSON
//   PLAY_INTEGRITY_SERVICE_ACCOUNT   optional; FCM's is used when absent
//   ANDROID_DEBUG_CERT_SHA256        optional, comma separated
//   IP_HASH_KEY                      random HMAC key; isolate fallback if absent
//   APPROVAL_STATEMENT_KEY           JSON {"kid","pkcs8"}: an Ed25519 PKCS#8 key (standard base64)
//                                    that signs approval-key statements; without it the route answers 503
// Vars: APPLE_TEAM_ID (App Attest and the APNs JWT issuer), APNS_KEY_ID,
// IOS_BUNDLE_ID (the APNs topic),
// ANDROID_PACKAGE, ANDROID_RELEASE_CERT_SHA256 and ANDROID_TESTER_CERT_SHA256
// (comma separated; approval statements only), GLOBAL_DAILY_CAP, RELAY_PAUSED. The APNs host follows
// each device's registered environment (development goes to sandbox).
import { loadStatementKey, type StatementKey } from "./approval-statement";
import { combineVerifiers, createAppAttestVerifier, createPlayIntegrityVerifier } from "./attestation";
import { APPLE_APP_ATTEST_ROOT_PEM } from "./apple-root";
import type { Db } from "./db";
import { createEvents, relayPaused } from "./events";
import type { ServiceAccount } from "./google";
import { createProviders } from "./providers";
import { createRelay } from "./relay";

interface Env {
  DB: D1Database;
  IP_HASH_KEY?: string;
  APPLE_TEAM_ID?: string;
  APNS_KEY_ID?: string;
  IOS_BUNDLE_ID: string;
  ANDROID_PACKAGE: string;
  GLOBAL_DAILY_CAP: string;
  RELAY_PAUSED: string;
  APNS_KEY?: string;
  FCM_SERVICE_ACCOUNT?: string;
  PLAY_INTEGRITY_SERVICE_ACCOUNT?: string;
  ANDROID_DEBUG_CERT_SHA256?: string;
  ANDROID_RELEASE_CERT_SHA256?: string;
  ANDROID_TESTER_CERT_SHA256?: string;
  APPROVAL_STATEMENT_KEY?: string;
  // Rate Limiting bindings (wrangler.jsonc "ratelimits"). Optional: without
  // one its gate is open and only the D1 limits apply.
  EDGE_OPEN_LIMIT?: RateLimit;
  EDGE_BEARER_LIMIT?: RateLimit;
}
const parse = <T>(raw: string | undefined): T | null => { try { return raw ? (JSON.parse(raw) as T) : null; } catch { return null; } };

/** The APNs key: the PEM secret with the APPLE_TEAM_ID and APNS_KEY_ID vars, or all three as one JSON secret. */
function apnsKey(env: Env): { teamId: string; keyId: string; privateKey: string } | null {
  const raw = env.APNS_KEY?.trim();
  if (!raw) return null;
  if (raw.startsWith("{")) {
    const key = parse<{ teamId?: unknown; keyId?: unknown; privateKey?: unknown }>(raw);
    return key && typeof key.teamId === "string" && typeof key.keyId === "string" && typeof key.privateKey === "string"
      ? { teamId: key.teamId, keyId: key.keyId, privateKey: key.privateKey } : null;
  }
  return env.APPLE_TEAM_ID && env.APNS_KEY_ID && raw.includes("-----BEGIN PRIVATE KEY-----") ? { teamId: env.APPLE_TEAM_ID, keyId: env.APNS_KEY_ID, privateKey: raw } : null;
}

let apnsOffWarnedAt = -Infinity;
function apnsOffDue(at: number): boolean {
  if (at - apnsOffWarnedAt < 60_000) return false;
  apnsOffWarnedAt = at;
  return true;
}

let statementKeyFor: { raw: string | undefined; key: Promise<StatementKey | null> } | undefined;
let statementOffWarnedAt = -Infinity;
const list = (raw: string | undefined) => (raw ?? "").split(",").map((v) => v.trim()).filter(Boolean);

function build(env: Env) {
  const db = env.DB as unknown as Db;
  const now = Date.now;
  // Bound, not the bare global: a Worker's fetch called as a method of
  // another object throws "Illegal invocation".
  const send: typeof fetch = (input, init) => fetch(input, init);
  const paused = () => relayPaused(db, env.RELAY_PAUSED);
  const fcm = parse<ServiceAccount>(env.FCM_SERVICE_ACCOUNT);
  const integrity = parse<ServiceAccount>(env.PLAY_INTEGRITY_SERVICE_ACCOUNT) ?? fcm;
  const apns = apnsKey(env);
  // Which part is missing, as yes/no only: never the key or its length. Once
  // per isolate a minute (build runs per request and per cron tick), since
  // this is the only sign that a secret upload went wrong.
  if (!apns && apnsOffDue(now())) console.error("push-relay", JSON.stringify({ apns: "off", key: !!env.APNS_KEY?.trim(), pem: !!env.APNS_KEY?.includes("-----BEGIN PRIVATE KEY-----"), team: !!env.APPLE_TEAM_ID, keyId: !!env.APNS_KEY_ID }));
  const providers = createProviders({ apns, fcm, bundleId: env.IOS_BUNDLE_ID, packageName: env.ANDROID_PACKAGE, db, fetch: send, now });
  const events = createEvents({ db, providers, now, paused, globalDailyCap: Number(env.GLOBAL_DAILY_CAP) || 100_000, configured: { ios: !!apns, android: !!fcm } });
  const verifier = combineVerifiers(
    env.APPLE_TEAM_ID ? createAppAttestVerifier({ teamId: env.APPLE_TEAM_ID, bundleId: env.IOS_BUNDLE_ID, rootPem: APPLE_APP_ATTEST_ROOT_PEM, now }) : null,
    integrity ? createPlayIntegrityVerifier({ packageName: env.ANDROID_PACKAGE, serviceAccount: integrity, debugCertDigests: (env.ANDROID_DEBUG_CERT_SHA256 ?? "").split(",").filter(Boolean), fetch: send, now }) : null,
  );
  const approvalVerifier = combineVerifiers(
    env.APPLE_TEAM_ID ? createAppAttestVerifier({ teamId: env.APPLE_TEAM_ID, bundleId: env.IOS_BUNDLE_ID, rootPem: APPLE_APP_ATTEST_ROOT_PEM, now }) : null,
    integrity ? createPlayIntegrityVerifier({ packageName: env.ANDROID_PACKAGE, serviceAccount: integrity, debugCertDigests: [], approval: { releaseCertDigests: list(env.ANDROID_RELEASE_CERT_SHA256), testerCertDigests: list(env.ANDROID_TESTER_CERT_SHA256) }, fetch: send, now }) : null,
  );
  // Memoised on the secret's text, so a rotated secret is picked up.
  const statementKey = async () => {
    if (statementKeyFor?.raw !== env.APPROVAL_STATEMENT_KEY) statementKeyFor = { raw: env.APPROVAL_STATEMENT_KEY, key: loadStatementKey(env.APPROVAL_STATEMENT_KEY) };
    const key = await statementKeyFor!.key;
    if (!key && now() - statementOffWarnedAt >= 60_000) { statementOffWarnedAt = now(); console.error("push-relay", JSON.stringify({ approvalStatement: "off" })); }
    return key;
  };
  return { relay: createRelay({ db, verifier, approvalVerifier, statementKey, now, paused, events: events.admit, ipHashKey: env.IP_HASH_KEY, edge: { open: env.EDGE_OPEN_LIMIT, bearer: env.EDGE_BEARER_LIMIT } }), events };
}

/** The task name and nothing else: a D1 error may quote a token or an id. */
async function guarded(task: "flush" | "sweep", run: () => Promise<unknown>): Promise<void> {
  try { await run(); } catch { console.error("push-relay", JSON.stringify({ task, status: "failed" })); }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return build(env).relay(request, (p) => ctx.waitUntil(p));
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const { events } = build(env);
    // Independent: a failing drain must not skip the sweep, or the reverse.
    ctx.waitUntil(Promise.all([guarded("flush", () => events.flush(20)), guarded("sweep", () => events.sweep())]));
  },
};
