#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Deploy-time guard for the staging mail sink (TRUST-FIRST-FACTOR.md revision 2, part C; Astra TRUST-2 F2; Astra TRUSTCODE-1 P2-1).
// It is the inner validation module of scripts/deploy.mjs, the only supported way to deploy (`pnpm run deploy:staging`); `pnpm run
// check-deploy` still checks the file alone. `checkDeploy(text, env)` validates the configuration RESOLVED for one environment.
// Refuses (exit 1) when wrangler.jsonc
//   - declares MAIL_SINK or STAGING_MAIL_SINK anywhere outside env.staging (top level, another env, any key or value),
//   - lets env.staging's MAIL_SINK point at any database but the staging sink, or the staging sink id appear outside it,
//   - gives env.staging another Worker name or account than the staging ones (the sink belongs to that Worker only).
// Plain node, no dependencies. `checkConfig(text)` is exported for the tests.

import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { kmsRegionError, kmsKeyArnValid } from "./kms-region.mjs";
import {
  ACCEPTED_CHECK_SHA256, DAY_MS, IMAGE_SIG_MAX_AGE_DAYS, REVOKED_IMAGE_IDS, TRUSTED_IMAGE_KEY_FPS, buildPayload, decodeStoredSig, p1363ToDer, parseCreatedMs,
  parseCustomerEntry, parseVerifiedAtMs, validImageId,
} from "./image-sig.mjs";
import { APPROVED_HETZNER_IMAGE_IDS, ENV_LIVE, ENV_STAGING, FLUX_BASE_VARS, FLUX_SWITCH_VAR, PRODUCTION_FLUX_ORIGINS, PRODUCTION_FLUX_SECRETS, envPolicy, productionFluxOriginProblem } from "../src/env-policy.mjs";

export const STAGING_ENV = "staging";
export const STAGING_WORKER = "murage-control-plane-staging";
export const STAGING_ACCOUNT = "874fe1689a53e6f56ff74816a9f23b26";
export const SINK_BINDING = "MAIL_SINK";
export const SINK_VAR = "STAGING_MAIL_SINK";
export const SINK_DATABASE_NAME = "murage-cloud-staging-mailsink";
export const SINK_DATABASE_ID = "7c9c6777-f7a1-4804-8596-7933a523d392";
export const SALES_VAR = "CLOUD_SALES_OPEN";
/** The dark-launch invite list (b5-config.ts salesAllowed): comma-separated exact email addresses, or empty. */
export const SALES_ALLOWLIST_VAR = "CLOUD_SALES_ALLOWLIST";
const PLAIN_EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
/** Cloudflare refuses a deploy whose text binding (a string var) is over 5.1 kB ("Text binding ... is too large", code 10054). Refuse it here, before wrangler, naming the var. */
export const TEXT_BINDING_MAX_BYTES = 5100;
export function checkTextBindingSizes(vars, target) {
  if (!vars || typeof vars !== "object") return [];
  const out = [];
  for (const [k, v] of Object.entries(vars)) {
    if (typeof v !== "string") continue;
    const n = new TextEncoder().encode(v).length;
    if (n > TEXT_BINDING_MAX_BYTES) out.push(`${target}: vars.${k} is ${n} bytes, over the ${TEXT_BINDING_MAX_BYTES}-byte limit Cloudflare puts on a text binding (code 10054); retire image ids or move the value into a secret`);
  }
  return out;
}
/** Refuses a CLOUD_SALES_ALLOWLIST that is not a string, or holds an entry that is not one plain email address (no wildcard, no bare
 *  domain, no display name). Empty entries are ignored, like the Worker does. Messages name the entry's position, never its value. */
export function checkSalesAllowlist(vars, target) {
  if (!vars || typeof vars !== "object" || !(SALES_ALLOWLIST_VAR in vars)) return [];
  const v = vars[SALES_ALLOWLIST_VAR];
  if (typeof v !== "string") return [`${target}: vars.${SALES_ALLOWLIST_VAR} must be a string (a comma list of plain email addresses, or empty)`];
  const out = [];
  v.split(",").forEach((raw, i) => {
    const e = raw.trim();
    if (e.length > 0 && !PLAIN_EMAIL.test(e)) out.push(`${target}: vars.${SALES_ALLOWLIST_VAR} entry ${i + 1} is not a plain email address`);
  });
  return out;
}
/** Freeze mode (KMS-SIGNING-DESIGN 12.4, 12.5 H1): production vars that say provisioning is off and that the deploy is a freeze. Provisioning off = no home create,
 *  rebuild or pool fill. The marker is committed in wrangler.jsonc (so it is reviewed and is part of the provenance-checked tree). */
export const PROVISIONING_VAR = "CLOUD_PROVISIONING_OPEN";
export const FREEZE_VAR = "CLOUD_FREEZE";
/** The checks a --freeze deploy SKIPS, and only these (the code lists what is skipped; every other check still runs). */
export const FREEZE_SKIPPED_CHECKS = Object.freeze([
  "checkHomeAllowlist", "checkSupersededDecoded", "raw superseded-image scan", "image-format checks (imageDigest format, canonical snapshot ids, x86 != arm)",
  "approved-image requirement (the pinned-vs-approved intersection and the policy approved-set test)",
  "checkImageSignatures (signed-image entries, accepted checks, B5_IMAGE_VERIFY_PUBKEY requirement; the vultr.sshKeyIds restriction is NOT skipped)",
]);
/** What a freeze ADDS to the normal check: production sshKeyIds [] (in checkProduction), provisioning off, sales off, and the marker set. */
export const FREEZE_ADDED_CHECKS = Object.freeze(["sshKeyIds exactly []", `vars.${PROVISIONING_VAR} exactly "false"`, `vars.${SALES_VAR} exactly "false"`, `vars.${FREEZE_VAR} exactly "true"`]);
/** The freeze vars of a resolved production block. A freeze needs them off/on as above; a normal deploy only refuses a malformed value. */
export function checkFreezeVars(resolved, freeze) {
  const vars = resolved?.vars && typeof resolved.vars === "object" ? resolved.vars : {};
  const out = [];
  for (const k of [PROVISIONING_VAR, FREEZE_VAR]) if (k in vars && !["true", "false"].includes(vars[k])) out.push(`production: vars.${k} must be exactly "true" or "false"`);
  if (!freeze) return out;
  if (vars[PROVISIONING_VAR] !== "false") out.push(`production: a freeze deploy needs vars.${PROVISIONING_VAR} exactly "false" (provisioning off)`);
  if (vars[SALES_VAR] !== "false") out.push(`production: a freeze deploy needs vars.${SALES_VAR} exactly "false" (sales off)`);
  if (vars[FREEZE_VAR] !== "true") out.push(`production: a freeze deploy needs vars.${FREEZE_VAR} exactly "true" (the freeze marker)`);
  return out;
}
/** True when the resolved block carries the freeze marker. */
export const freezeMarkerSet = (resolved) => resolved?.vars?.[FREEZE_VAR] === "true";

/** Dark-prod mode (`check-deploy --dark`, `deploy.mjs production --dark`; lanes/cloud-v2/DARK-PROD-CHECKLIST.md): production is deployed but closed. The resolved
 *  env.production block must show sales off, B3 off, no Stripe secret bound or required, no mail sink, and the home images empty or pinned. Every rule fails closed. */
export const B3_VAR = "CLOUD_B3_MODE";
export const B3_OFF = "off";
/** The live-billing gate (billingConfig reads exactly "1"). Dark refuses it in every form. */
export const STRIPE_LIVE_GATE = "STRIPE_ALLOW_LIVE";
/** Worker secrets that carry Stripe credentials: a dark deploy must neither require nor define them, and no deploy may carry one as a plain var. */
export const STRIPE_SECRET_NAMES = Object.freeze(["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]);
/** The shape of a Stripe LIVE secret or webhook signing secret written into a config value (never matched against test keys: those are refused elsewhere). */
const STRIPE_SECRET_LITERAL = /(?:^|[^A-Za-z0-9])(?:(?:sk|rk)_live_|whsec_)[A-Za-z0-9]/;

/** A refusal message never carries a Stripe live-key or webhook-secret shaped token (it can appear as a config KEY in a path): it prints "redacted" instead. */
export const redactSecretShapes = (m) => String(m).replace(/(?:(?:sk|rk)_live_|whsec_)[A-Za-z0-9_+\/=-]*/g, "redacted");
/** Every production deploy, dark or not: no Stripe secret as a plain var, and no Stripe live-secret or webhook-secret literal anywhere in the block. Reports paths only, never a value. */
export function checkNoStripeSecretsInConfig(resolved) {
  const out = [];
  for (const k of Object.keys(resolved?.vars && typeof resolved.vars === "object" ? resolved.vars : {})) {
    if (STRIPE_SECRET_NAMES.includes(k)) out.push(`production vars.${k}: a Stripe secret is a Worker secret, never a plain var`);
  }
  for (const [path, s] of walk(resolved, "$.env.production")) if (STRIPE_SECRET_LITERAL.test(s)) out.push(`production ${path}: a Stripe live key or webhook secret literal is written into the config`);
  return out;
}

/** PRODUCTION_HOME_IMAGES (or its injected stand-in) is empty (null) or a well-formed pin: two distinct snapshot ids and a sha256 digest. */
export function checkHomeImagesShape(home) {
  if (home === null || home === undefined) return [];
  const bad = (m) => [`PRODUCTION_HOME_IMAGES: ${m}`];
  if (typeof home !== "object" || Array.isArray(home)) return bad("must be empty (null) or an object { x86, arm, digest }");
  const id = /^[1-9][0-9]{0,18}$/;
  const out = [];
  if (typeof home.x86 !== "string" || !id.test(home.x86) || typeof home.arm !== "string" || !id.test(home.arm)) out.push(...bad("x86 and arm must be snapshot ids (decimal, no leading zero)"));
  else if (home.x86 === home.arm) out.push(...bad("x86 and arm must differ"));
  if (typeof home.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(home.digest)) out.push(...bad("digest must be sha256:<64 lowercase hex>"));
  return out;
}

/** Dark skips the image-format checks when no image is pinned, but a revoked snapshot id named in the decoded B5 config is still refused. */
export function checkRevokedIds(resolved, revoked) {
  const out = [];
  const set = new Set((revoked ?? []).map((v) => canonId(v)).filter((v) => v !== null));
  if (set.size === 0) return out;
  // Every string and key of the block (raw vars, keys such as imageKinds ids) and of every JSON document held in a string (CLOUD_B3_CONFIG, B5_PROVISIONER_CONFIG, nested), by whole digit run.
  const seen = new Set();
  const scan = (node, path, depth) => {
    for (const [pth, str] of walk(node, path)) {
      for (const run of str.match(/[0-9]+/g) ?? []) { const c = canonId(run); if (c !== null && set.has(c)) seen.add(`${pth}: revoked home image ${c}`); }
      if (depth < 4 && /^\s*[\[{]/.test(str)) { let v; try { v = JSON.parse(str); } catch { v = undefined; } if (v && typeof v === "object") scan(v, pth, depth + 1); }
    }
  };
  scan(resolved, "$.env.production", 0);
  for (const m of seen) out.push(`production dark: ${m}`);
  return out;
}

/** The dark-prod conditions on the RESOLVED env.production block (see DARK-PROD-CHECKLIST.md). `home` is the pinned production images, or null when empty. */
export function checkDarkProd(resolved, home) {
  const out = [];
  const bad = (m) => out.push(`production dark: ${m}`);
  const vars = resolved?.vars && typeof resolved.vars === "object" ? resolved.vars : {};
  if (vars[SALES_VAR] !== "false") bad(`vars.${SALES_VAR} must be exactly "false" (sales closed)`);
  // STRIPE_ALLOW_LIVE in ANY form refuses (billingConfig reads exactly "1", but a dark deploy must not carry the live-billing gate at all, as a var, a required secret or a value).
  if (STRIPE_LIVE_GATE in vars) bad(`vars.${STRIPE_LIVE_GATE} must not exist (live billing is not allowed while dark)`);
  if (Array.isArray(resolved?.secrets?.required) && resolved.secrets.required.includes(STRIPE_LIVE_GATE)) bad(`secrets.required must not name ${STRIPE_LIVE_GATE}`);
  if (B3_VAR in vars && vars[B3_VAR] !== B3_OFF) bad(`vars.${B3_VAR} must be absent or exactly ${JSON.stringify(B3_OFF)} (B3 off)`);
  for (const k of [SINK_BINDING, SINK_VAR, "MAIL_SINK_ALLOWLIST"]) if (k in vars) bad(`vars.${k}: the mail sink must not exist in production`);
  for (const d of Array.isArray(resolved?.d1_databases) ? resolved.d1_databases : []) if (d?.binding === SINK_BINDING) bad(`${SINK_BINDING} binding must not exist`);
  const required = Array.isArray(resolved?.secrets?.required) ? resolved.secrets.required : [];
  for (const n of STRIPE_SECRET_NAMES) if (required.includes(n)) bad(`secrets.required must not name ${n} (no Stripe live key or webhook secret is bound while dark)`);
  for (const n of STRIPE_SECRET_NAMES) if (n in vars) bad(`vars.${n} must not exist`);
  if (home === null || home === undefined) {
    if (vars[PROVISIONING_VAR] !== "false") bad(`vars.${PROVISIONING_VAR} must be exactly "false" while PRODUCTION_HOME_IMAGES is empty`);
  } else out.push(...checkHomeImagesShape(home).map((m) => `production dark: ${m}`));
  return out;
}
/**
 * FLUX-ENSURE-EMAIL-VERIFIED (design-ev3 section 7, M4 of astra-code1): links made before the inbox proof existed bypass it, so production must
 * hold NO flux_links row when this FIRST ships. It is a ONE-TIME first-rollout check: migration 0143 adds flux_email_proof_rollout, and the
 * deploy runner (scripts/deploy.mjs deployWithPreflight) reads the marker and the count in ONE statement before anything is written or
 * uploaded. Marker absent: the count must be exactly the integer 0, and the marker is written once that deploy succeeded. Marker present: the
 * count is not judged (real links exist after launch). check-deploy is offline, so the row is read by the runner and judged here. Staging is
 * not gated (its links are a listed follow-up). Only RAW integers pass: null, false, "", strings and NaN refuse (fail closed).
 */
export const FLUX_LINKS_SQL = "SELECT COUNT(*) AS n FROM flux_links";
export const FLUX_ROLLOUT_SQL = "SELECT (SELECT COUNT(*) FROM flux_email_proof_rollout WHERE id='first') AS marker, (SELECT COUNT(*) FROM flux_links) AS n";
/** The marker, written after the first production deploy that passed the zero-link check. `at` is a millisecond timestamp (an integer). */
export const fluxRolloutMarkSql = (at) => `INSERT OR IGNORE INTO flux_email_proof_rollout (id,at) VALUES ('first',${Math.trunc(Number(at)) || 0})`;
const rawCount = (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
export function checkFluxLinksCount(target, count) {
  if (target !== "production") return [];
  if (!rawCount(count)) return ["flux links: the production flux_links count could not be read (refused; nothing was deployed)"];
  if (count > 0) return [`flux links: production holds ${count} flux_links row(s) made before the email proof; this release needs 0 (refused; nothing was deployed)`];
  return [];
}
/** Judges the FLUX_ROLLOUT_SQL row. Returns the problems, and whether this deploy is the first rollout (the marker is then written after it). */
export function checkFluxRollout(target, row) {
  if (target !== "production") return { problems: [], firstRollout: false };
  const marker = row && typeof row === "object" ? row.marker : undefined;
  if (marker === 1) return { problems: [], firstRollout: false };
  if (marker !== 0) return { problems: ["flux links: the email proof rollout marker could not be read (refused; nothing was deployed; is migration 0143 applied?)"], firstRollout: false };
  const problems = checkFluxLinksCount(target, row.n);
  return { problems, firstRollout: problems.length === 0 };
}

export const SINK_ALLOWLIST_VAR = "MAIL_SINK_ALLOWLIST";
export const PRODUCTION_WORKER = "murage-control-plane";
export const PRODUCTION_ACCOUNT = "b83123326a4b9ad76831b9cb9365b33b";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const STAGING_DB_ID = "2bbc01ca-09b4-4ca9-8cb1-5471f8abb070";
/** Marks every value that does not exist yet in env.production. check-deploy refuses a production deploy while any remains. */
export const PLACEHOLDER = "PROD_TODO_";
export const PRODUCTION_ENV = "production";
export const PRODUCTION_ROUTE = "accounts.murage.ai";
export const PRODUCTION_SENDER = "noreply@murage.ai";
/** Every home image that a newer one has replaced. Production pins only the image proven on staging, so none of these may appear anywhere in env.production.
 *  Add each image here when a newer one is pinned (Astra LAUNCHCP1 P2). */
export const SUPERSEDED_HOME_IMAGES = [
  { name: "4B", ids: ["444270047", "444255243"], digest: "d77cab88bb1e3bb89552d997e3ba984a45920237ce93d34e2e6c8bf3407711b8" },
  { name: "4C", ids: ["444341978", "444341910"], digest: "b0a7d691ccfe5060492521f5b31a1fb40fad504a86af7c4d7ce2e464c5612bcb" },
  { name: "4D", ids: ["444544265", "444544247"], digest: "8c609edec1e65bf8dc4302e5e6d7b42b2ec98312ae09a76da965ac986726673c" },
  { name: "4F staging", ids: ["444743708", "444744086"], digest: "76e0233d07517e0ed0f0c2307eb686270a019c1448fde30cf1fe0d1dd2ea8e51" },
  { name: "4G staging (80 GB disk)", ids: ["447987145", "447986942"], digest: "b69a495ff8fb69582ed0cabd9940670d67338520a14f2a0e8e3638c0c93ce71a" },
  { name: "4H staging (40 GB disk)", ids: ["448333202", "448333205"], digest: "8fb42d71c9c4991bc38f912b82113332591fc6fb702450d74e45ecd4c4f125d8" },
  { name: "4I staging (40 GB disk)", ids: ["448605239", "448605187"], digest: "587b36fd6348d9834eef5222cb84755fee93622e7ca86156e1a145ac04be3f77" },
  { name: "4J staging (40 GB disk)", ids: ["448671725"], digest: "24d2d710e16c3a78ecfc234e14cf66c6c7cb0d9de08130b0319e692f000a0eed" },
  { name: "4K staging (40 GB disk)", ids: ["448790563", "448605631"], digest: "5a70963c70fcd46ab803e976aec4e07441f97af5cd97d53bc43659279e6c1780" },
  { name: "4L prod (1.0.8)", ids: ["449326227", "449326301"], digest: "78cea1a1e0b6b1b3bb29b800c18462ead9b49406c28216e9881a155211720ce0" },
  { name: "4L staging (1.0.8, 40 GB disk)", ids: ["449078615", "449077225"], digest: "37dcde2c40070a1990c8ac313cb21dada7516ee0c5ce8e97ade979338f97755b" },
  { name: "4M staging (1.0.9, 40 GB disk)", ids: ["449691199", "449691057"], digest: "522588f8776fd60ed0329453c3bd38955946a0dd71d8233fa4c7dd8f2a305932" },
  { name: "staging 1.1.0 before key delivery", ids: ["450202069", "450188435"], digest: "119d012f1276f523291b4ca2cab1062e3c364153b5a896a95896063a2de88a8d" },
  { name: "staging 1.1.0 before Inbox sign-in", ids: ["450509039", "450508886"], digest: "a7ae3dce0b1e58511a83fddc2662c4ef83f0e7a73ec10eb0ffad3c969283be7b" },
  { name: "staging 1.1.0 before Fuigo userns policy fix", ids: ["451187091", "451183667"], digest: "8cb63f20d8eea57bc5361f419cbe42eb47e8e5471290c7628e088a75f2de4e21" },
  { name: "staging 1.1.0 before routed Fuigo base names", ids: ["451260480", "451260442"], digest: "dc4c7584f8b69b41d7c10fbd2104005a3674f175d3667a4aa5f37499386dd7a4" },
  { name: "staging 1.1.0 before Ember Flux re-pick", ids: ["450638586", "450633709"], digest: "97dbd05b8cf37d244859c02c62df894307b122864caf4d080dfeb1bc003a1e37" },
];
/** The ONLY home images production may use (allowlist): { x86: "<snapshot id>", arm: "<snapshot id>", digest: "sha256:<64 lowercase hex>" }, or null while not pinned.
 *  Filled in by the commit that pins image 4F. A production check fails unless env.production's decoded B5_PROVISIONER_CONFIG images.provider.x86/arm and
 *  CLOUD_B3_CONFIG imageDigest equal this exactly (Astra LAUNCHCP4 P1-2). It must never equal a staging or superseded value. */
export const PRODUCTION_HOME_IMAGES = { x86: "451878214", arm: "451877100", digest: "sha256:7211bb35fcb80520d72e8496df143d2491531ae047a1b4ff766235e69aec4796" };
/** The entrypoint production (top level and env.production) must resolve to; no env-level override may differ (Astra LAUNCHCP4 P2-3). */
export const PRODUCTION_ENTRYPOINT = "src/index.ts";
/** Keys that install or reach a prototype in some parsers; refused at any depth of the config and of the decoded JSON vars (Astra LAUNCHCP4 P2-4). */
export const PROTOTYPE_KEYS = ["__proto__", "constructor", "prototype"];
/** Staging-only identifiers that must never appear anywhere in env.production (test Stripe objects, the staging KMS key, staging capacity). */
export const STAGING_ONLY_STRINGS = [
  "price_1UOhbTItXbM6YxLOQ0atYN61", "price_1UOhbWItXbM6YxLOwJykFVw7", "price_1UOhbYItXbM6YxLOU1qRe6aB", "bpc_1UOhbjItXbM6YxLOsFQw5RCz",
  "0c7fb20d-226b-4ccc-91c5-93fd414c1afb",
  "mcq-staging", "murage-site-preview", "workers.dev", "murage.test", "192.0.2.", "u687784", "669748", "130782531", "11725298", "11769359",
  STAGING_DB_ID, SINK_DATABASE_ID, STAGING_ACCOUNT, "murage-identity-reader-staging", "sk_test_", "pk_test_", "rk_test_",
];
/** Quarantine has no relay server: fenced homes sit behind the quarantine firewall with no reachable egress. Production records this sentinel. */
export const NO_QUARANTINE_RELAY_IPV4 = "198.51.100.20";
/** Vars that exist only to make staging testable. */
export const STAGING_ONLY_VARS = ["LOG_INTERNAL_ERRORS", "CLOUD_CP0_STAGING", "CLOUD_STAGING_FAULT", SINK_VAR, SINK_ALLOWLIST_VAR];
// Flux for Cloud: the switch, the two secrets and the production Flux hosts live in src/env-policy.mjs (the Worker runs the host rule too).
export { FLUX_BASE_VARS, FLUX_SWITCH_VAR, PRODUCTION_FLUX_ORIGINS, PRODUCTION_FLUX_SECRETS, productionFluxOriginProblem };
/** Secrets env.production must require (a deploy without them is refused by wrangler). */
export const PRODUCTION_REQUIRED_SECRETS = [
  "BETTER_AUTH_SECRET", "CLOUDFLARE_API_TOKEN", "SENDLANE_API_KEY", "SENDLANE_HASH_KEY", "CLOUD_ADMIN_TOKEN", "CHECKOUT_DISCLOSURE_TOKEN_SECRET",
  "CANCELLATION_MAIL_KEY", "NOTICE_MAIL_KEY", "REFUND_KEY_SECRET", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "CLOUD_HOME_API_TOKEN", "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY", "HCLOUD_TOKEN", "STORAGEBOX_API_TOKEN", "STORAGEBOX_MAIN_PASSWORD", "CLOUD_B3_SIGNING_JWK", "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY",
];

/** Secrets env.production may hold but does not require (deploy is never refused without them). SITE_FORWARDER_TOKEN: unset means the
 *  announcement signup has no site forwarder path. Each must never be a plain var. */
export const PRODUCTION_OPTIONAL_SECRETS = ["SITE_FORWARDER_TOKEN"];

/** JSONC to JSON: drops // and block comments and trailing commas, leaving string contents (URLs included) untouched. */
export function stripJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i < 0) throw new Error("unterminated comment");
      i += 1;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** Every [path, key-or-string] in the tree, for "does this name appear here at all". */
function* walk(node, path) {
  if (typeof node === "string") yield [path, node];
  else if (Array.isArray(node)) for (let i = 0; i < node.length; i += 1) yield* walk(node[i], `${path}[${i}]`);
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      yield [`${path}.${k}`, k];
      yield* walk(v, `${path}.${k}`);
    }
  }
}

/** Paths of every PROTOTYPE_KEYS key at any depth, descending also into strings that hold JSON (decoded vars). JSON.parse makes such keys ordinary own
 *  properties, so Object.keys sees them even though wrangler's own parser would install a prototype. */
export function protoKeyPaths(node, path = "$", depth = 0) {
  const out = [];
  if (typeof node === "string") {
    const t = node.trim();
    if (depth < 6 && (t.startsWith("{") || t.startsWith("["))) { let d; try { d = JSON.parse(t); } catch { return out; } out.push(...protoKeyPaths(d, `${path}(json)`, depth + 1)); }
  } else if (Array.isArray(node)) node.forEach((v, i) => out.push(...protoKeyPaths(v, `${path}[${i}]`, depth)));
  else if (node && typeof node === "object") {
    for (const k of Object.keys(node)) {
      if (PROTOTYPE_KEYS.includes(k)) out.push(`${path}.${k}`);
      out.push(...protoKeyPaths(node[k], `${path}.${k}`, depth));
    }
  }
  return out;
}
/** Staging hostnames matched STRUCTURALLY, by DNS label suffix on the canonical host (not as a substring): "x.workers.dev" and "workers.dev" are
 *  staging, "my-workers.dev" is not. 192.0.2.0/24 (documentation range used by staging capacity) is matched on the canonical IPv4 form. */
const STAGING_HOST_SUFFIXES = ["workers.dev", "murage.test"];
const STAGING_IPV4_PREFIX = "192.0.2.";
const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** WHATWG URL input cleaning: leading/trailing C0 control or space stripped, every ASCII tab, LF and CR removed ("ht\ntps://x" is "https://x"). */
const whatwgInput = (v) => {
  let a = 0; let b = v.length;
  while (a < b && v.charCodeAt(a) <= 0x20) a += 1;
  while (b > a && v.charCodeAt(b - 1) <= 0x20) b -= 1;
  return v.slice(a, b).replace(/[\t\n\r]/g, "");
};
/** ONE canonical host for any host / origin / URL / bare-host string: WHATWG-parsed (lowercase, percent-decoded, numeric IPv4 forms dotted),
 *  IPv4-mapped/compatible IPv6 ([::ffff:c000:214]) mapped to dotted IPv4, trailing dots stripped. null when it is not a host. */
const hostMemo = new Map();
export function canonicalHost(value) {
  if (typeof value !== "string") return null;
  if (hostMemo.has(value)) return hostMemo.get(value);
  const r = canonicalHostUncached(value);
  if (hostMemo.size > 50000) hostMemo.clear();
  hostMemo.set(value, r);
  return r;
}
function canonicalHostUncached(value) {
  const t = whatwgInput(value.trim());
  if (t === "") return null;
  // Exactly what the runtime does with the value: new URL() first, any scheme, input pre-cleaned as WHATWG does. Only when that throws or yields
  // no host ("workers.dev", "localhost:8080") is the value a bare host.
  let u = null;
  // (A string that does not start with a scheme can never parse without a base, so skipping the attempt is only a speed-up.)
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(t)) { try { const a = new URL(t); if (a.hostname !== "") u = a; } catch { /* not absolute */ } }
  if (!u) { try { u = new URL(`http://${t}`); } catch { return null; } }
  let h = u.hostname;
  const m = /^\[::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(h);
  if (m) { const hi = parseInt(m[1], 16); const lo = parseInt(m[2], 16); h = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`; }
  return h.replace(/\.+$/, "");
}
/** The runtime's list preprocessing, in its order, in ONE place: split on "," exactly as readConfig() does, then String.prototype.trim() each entry
 *  (every Unicode whitespace and U+FEFF), THEN (in canonicalHost) the WHATWG input cleaning and the new URL() attempt. Every list-valued or
 *  host-valued setting goes through this. */
export const listPieces = (s) => s.split(",").map((x) => x.trim());
/** Canonical host of every comma-separated entry of s (list-valued settings such as ALLOWED_ORIGINS split exactly as readConfig() does). */
function entryHosts(s) {
  const out = [];
  for (const piece of listPieces(s)) { const h = canonicalHost(piece); if (h !== null) out.push(h); }
  return out;
}
/** Identity match on token boundaries: `bad` counts only when the characters around it are not letters or digits (hostname labels, URL parts, JSON
 *  punctuation, "-", "_", "." all delimit). "u687784" is found in "u687784.your-storagebox.de" and "https://u687784.x/", never in "u6877840". A bad
 *  string that ends in a delimiter ("sk_test_") is a prefix: what follows it is free. The host-shaped identities (workers.dev, murage.test, 192.0.2.)
 *  are matched on the canonical host of every entry by DNS label suffix, plus the raw text on label boundaries (no "-" or letter before). */
export function hasIdentity(s, bad) {
  const isSuffix = STAGING_HOST_SUFFIXES.includes(bad);
  if (isSuffix || bad === STAGING_IPV4_PREFIX) {
    if (typeof s !== "string") return false;
    const raw = new RegExp(`(?<![A-Za-z0-9-])${escRe(bad)}${isSuffix ? "(?![A-Za-z0-9])" : ""}`, "i");
    // A piece that canonicalizes to a host is decided by that host alone (label suffix / IPv4 prefix); only a piece that is not a host or URL
    // (JSON, prose) gets the raw text scan. "https://workers.dev.example.com" is example.com, not workers.dev.
    return listPieces(s).some((piece) => {
      const h = canonicalHost(piece);
      if (h === null) return raw.test(piece);
      return isSuffix ? h === bad || h.endsWith(`.${bad}`) : h.startsWith(bad);
    });
  }
  const tail = /[A-Za-z0-9]$/.test(bad) ? "(?![A-Za-z0-9])" : "";
  const re = new RegExp(`(?<![A-Za-z0-9])${escRe(bad)}${tail}`, "i");
  return variants(s).some((v) => re.test(v));
}
/** The string plus, for each comma-separated entry, its WHATWG-normalized URL and canonical host (lowercase, percent-decoded, numeric IPv4
 *  canonical, mapped IPv6 dotted): "https://%6durage-site-preview.PAGES.dev" and ",https://0xc0000214" both name staging. */
export function variants(s) {
  if (typeof s !== "string") return [s];
  const out = [s];
  for (const t of listPieces(s)) {
    if (t === "") continue;
    out.push(t);
    const w = whatwgInput(t);
    if (w !== t) out.push(w);
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(w)) { try { out.push(new URL(w).href); } catch { /* not a URL */ } }
    const h = canonicalHost(t);
    if (h !== null) out.push(h);
  }
  return out;
}
/** A string var that holds a JSON object or array: the decoded scans cover its contents, so the raw scan must not re-read the numbers inside it. */
const holdsJson = (s) => { const t = s.trim(); if (!(t.startsWith("{") || t.startsWith("["))) return false; try { JSON.parse(t); return true; } catch { return false; } };
const HOST_IDENTITIES = [...STAGING_HOST_SUFFIXES, STAGING_IPV4_PREFIX];
const isNumeric = (s) => /^[0-9]+$/.test(s);

/** The problems with this wrangler.jsonc text; empty means it may be deployed. */
export function checkConfig(text) {
  let config;
  try { config = JSON.parse(stripJsonc(text)); } catch (e) { return [`wrangler.jsonc does not parse: ${e instanceof Error ? e.message : String(e)}`]; }
  const problems = [];
  for (const path of protoKeyPaths(config)) problems.push(`${path}: prototype-setting key not allowed (parser disagreement with wrangler)`);
  const staging = config?.env?.[STAGING_ENV];
  const outside = { ...config, env: { ...(config.env ?? {}) } };
  delete outside.env[STAGING_ENV];
  for (const [path, s] of walk(outside, "$")) {
    if (s.includes(SINK_BINDING) || s.includes(SINK_VAR)) problems.push(`${path}: ${s.includes(SINK_VAR) ? SINK_VAR : SINK_BINDING} outside env.${STAGING_ENV}`);
    if (s.includes(SINK_DATABASE_ID) || s.includes(SINK_DATABASE_NAME)) problems.push(`${path}: the staging sink database outside env.${STAGING_ENV}`);
  }
  if (staging) {
    const sinks = (staging.d1_databases ?? []).filter((d) => d?.binding === SINK_BINDING);
    if (sinks.length > 1) problems.push(`env.${STAGING_ENV}: ${SINK_BINDING} declared more than once`);
    for (const d of sinks) {
      if (d.database_id !== SINK_DATABASE_ID) problems.push(`env.${STAGING_ENV}.${SINK_BINDING}: database_id must be ${SINK_DATABASE_ID}`);
      if (d.database_name !== SINK_DATABASE_NAME) problems.push(`env.${STAGING_ENV}.${SINK_BINDING}: database_name must be ${SINK_DATABASE_NAME}`);
    }
    for (const d of staging.d1_databases ?? []) {
      if (d?.binding !== SINK_BINDING && (d?.database_id === SINK_DATABASE_ID || d?.database_name === SINK_DATABASE_NAME)) {
        problems.push(`env.${STAGING_ENV}.${d?.binding}: the sink database bound under another name`);
      }
    }
    const mentions = [...walk(staging, `$.env.${STAGING_ENV}`)].some(([, s]) => s.includes(SINK_BINDING) || s.includes(SINK_VAR));
    if (mentions) {
      if (staging.name !== STAGING_WORKER) problems.push(`env.${STAGING_ENV}.name must be ${STAGING_WORKER} where the sink is declared`);
      if (staging.account_id !== STAGING_ACCOUNT) problems.push(`env.${STAGING_ENV}.account_id must be ${STAGING_ACCOUNT} where the sink is declared`);
      if (config.account_id === STAGING_ACCOUNT) problems.push("the top-level (production) account_id is the staging account");
    }
  }
  return problems;
}

/**
 * The problems with deploying this wrangler.jsonc text to `env` ("staging" or "production"); empty means it may be deployed.
 * On top of checkConfig: the Worker name, account id and every D1 database id of the RESOLVED environment must be exactly the known ones,
 * MAIL_SINK exists only for staging (with the exact staging sink id), and STAGING_MAIL_SINK / MAIL_SINK_ALLOWLIST may appear only as keys
 * of env.staging.vars.
 * @param {string} text
 * @param {string} target
 * @param {{ homeImages?: { x86: string, arm: string, digest: string } | null, runtimeApprovedLive?: readonly string[] }} [opts] homeImages overrides PRODUCTION_HOME_IMAGES (tests only); runtimeApprovedLive overrides APPROVED_provider_IMAGE_IDS.live (tests only; when homeImages is injected and this is not, the injected ids stand in for it)
 */
export function checkDeploy(text, target, opts = {}) { return checkDeployRaw(text, target, opts).map(redactSecretShapes); }
function checkDeployRaw(text, target, opts = {}) {
  const freeze = opts.freeze === true;
  const dark = opts.dark === true;
  if (freeze && target !== "production") return ["freeze mode applies to production only"];
  if (dark && target !== "production") return ["dark mode applies to production only"];
  if (dark && freeze) return ["dark mode and freeze mode are exclusive"];
  const homeImages = opts.homeImages === undefined ? PRODUCTION_HOME_IMAGES : opts.homeImages;
  // Empty home images (dark only) mean no home can be created, exactly the situation a freeze describes: the image checks have nothing to check and are skipped.
  const skipImages = freeze || (dark && (homeImages === null || homeImages === undefined));
  const imageOpts = skipImages ? { ...opts, freeze: true } : opts;
  if (target !== STAGING_ENV && target !== "production") return [`unknown environment ${JSON.stringify(target)} (staging or production)`];
  const problems = checkConfig(text);
  let config;
  try { config = JSON.parse(stripJsonc(text)); } catch { return problems; }
  const staging = target === STAGING_ENV;
  // Neither environment inherits from the top level: wrangler does not inherit bindings or vars, so only the env block is deployed.
  const resolved = staging ? config?.env?.[STAGING_ENV] : config?.env?.[PRODUCTION_ENV];
  if (!resolved) return [...problems, `no ${target} configuration`];
  const want = staging
    ? { name: STAGING_WORKER, account: STAGING_ACCOUNT, db: STAGING_DB_ID }
    : { name: PRODUCTION_WORKER, account: PRODUCTION_ACCOUNT, db: null };
  if (resolved.name !== want.name) problems.push(`${target}: Worker name must be ${want.name}`);
  if (resolved.account_id !== want.account) problems.push(`${target}: account_id must be ${want.account}`);
  const dbs = Array.isArray(resolved.d1_databases) ? resolved.d1_databases : [];
  const main = dbs.filter((d) => d?.binding === "DB");
  if (staging && (main.length !== 1 || main[0].database_id !== want.db)) problems.push(`${target}: the DB binding must be exactly one database, id ${want.db}`);
  if (!staging && (main.length !== 1 || typeof main[0].database_id !== "string" || !UUID.test(main[0].database_id) || main[0].database_id === STAGING_DB_ID || main[0].database_id === SINK_DATABASE_ID)) {
    problems.push(`${target}: the DB binding must be exactly one database with its own real id (not a ${PLACEHOLDER} placeholder, not a staging id)`);
  }
  // Production must say what customer sales are: CLOUD_SALES_OPEN exactly "true", "invite" or "false" (the Worker treats anything else as shut,
  // b5-config.ts salesMode, but a forgotten or mistyped line is still refused here). Staging is not held to it.
  if (!staging && !["true", "invite", "false"].includes(resolved.vars?.[SALES_VAR])) problems.push(`${target}: vars.${SALES_VAR} must be exactly "true", "invite" or "false"`);
  problems.push(...checkSalesAllowlist(resolved.vars, target));
  problems.push(...checkTextBindingSizes(resolved.vars, target));
  const sinks = dbs.filter((d) => d?.binding === SINK_BINDING);
  if (staging && (sinks.length !== 1 || sinks[0].database_id !== SINK_DATABASE_ID)) problems.push(`staging: ${SINK_BINDING} must be present exactly once, id ${SINK_DATABASE_ID}`);
  if (!staging && sinks.length > 0) problems.push(`${target}: ${SINK_BINDING} must not exist`);
  for (const d of dbs) if (d?.binding !== "DB" && d?.binding !== SINK_BINDING) problems.push(`${target}: unexpected D1 binding ${JSON.stringify(d?.binding)}`);
  // The sink vars: only as keys of env.staging.vars (checkConfig already refuses them anywhere outside env.staging).
  if (staging) {
    for (const [path, s] of walk(resolved, `$.env.${STAGING_ENV}`)) {
      if (!(s.includes(SINK_VAR) || s.includes(SINK_ALLOWLIST_VAR))) continue;
      if (!new RegExp(`^\\$\\.env\\.${STAGING_ENV}\\.vars\\.(${SINK_VAR}|${SINK_ALLOWLIST_VAR})$`).test(path)) problems.push(`${path}: ${s.includes(SINK_VAR) ? SINK_VAR : SINK_ALLOWLIST_VAR} only belongs in env.${STAGING_ENV}.vars`);
    }
  }
  // The entrypoint: top level and the resolved env must both be the reviewed one (an env-level `main` replaces the uploaded code).
  if (config.main !== PRODUCTION_ENTRYPOINT) problems.push(`top level main must be ${PRODUCTION_ENTRYPOINT}`);
  if ("main" in resolved && resolved.main !== PRODUCTION_ENTRYPOINT) problems.push(`${target}: main must be ${PRODUCTION_ENTRYPOINT} (no env-level override)`);
  if (!staging) problems.push(...checkProduction(resolved, { freeze: skipImages, dark }), ...checkNotStagingImages(resolved, [config?.env?.[STAGING_ENV], config]),
    ...checkNoOverrides(config, resolved), ...(skipImages ? [] : checkHomeAllowlist(resolved, homeImages, [config?.env?.[STAGING_ENV], config])));
  // Every production deploy: no Stripe secret literal or secret-named var in the config, and the pinned home images empty or well-formed.
  if (!staging) problems.push(...checkNoStripeSecretsInConfig(resolved), ...checkHomeImagesShape(homeImages));
  if (dark) problems.push(...checkDarkProd(resolved, homeImages), ...checkRevokedIds(resolved, opts.trust?.revoked ?? REVOKED_IMAGE_IDS));
  if (!staging) problems.push(...checkFreezeVars(resolved, freeze));
  // The build environment is a property of the bundle (wrangler `define`), never of a var: it must be exactly this environment's value.
  if (!buildEnvDefineOk(resolved, target)) problems.push(`${target}: define must be exactly {${JSON.stringify(BUILD_ENV_DEFINE_KEY)}: ${JSON.stringify(JSON.stringify(target))}} (the signed-image gate reads it)`);
  // Freeze skips ONLY image checks (Astra G3-KMS H8): the Vultr ssh-key restriction is not one, so it runs in every mode, apart from the signed-image check.
  problems.push(...checkNoOperatorSshKeys(resolved, target));
  // Freeze creates no home, so no image can be used: the signed-image check (pubkey requirement, accepted checks, imageKinds) is one of the skipped image checks.
  if (!skipImages) problems.push(...checkImageSignatures(resolved, target, opts).problems);
  const policy = environmentPolicy(resolved, target, imageOpts);
  problems.push(...policy.problems);
  return [...new Set(problems)];
}

/** Warnings only (a staging deploy may proceed): what the image-signature checks found that production would refuse. */
export function deployWarnings(text, target, opts = {}) {
  if (opts.freeze === true || opts.dark === true) return []; // freeze (and dark, whose image checks may be skipped) skips the image checks, so there is nothing to warn about
  let config;
  try { config = JSON.parse(stripJsonc(text)); } catch { return []; }
  const resolved = target === STAGING_ENV ? config?.env?.[STAGING_ENV] : config?.env?.[PRODUCTION_ENV];
  return resolved ? checkImageSignatures(resolved, target, opts).warnings : [];
}

// ---- signed images (KMS signing, design sections 2, 5.2, 8-9) -------------------------------------------------------------------------

/** The wrangler `define` that tells the bundle which environment it is. The only `define` any block may carry. */
export const BUILD_ENV_DEFINE_KEY = "__MURAGE_BUILD_ENV__";
const buildEnvDefineOk = (blk, target) => {
  const d = blk?.define;
  return d !== null && typeof d === "object" && !Array.isArray(d) && Object.keys(d).length === 1 && d[BUILD_ENV_DEFINE_KEY] === JSON.stringify(target);
};
const sha256Hex = (buf) => createHash("sha256").update(buf).digest("hex");

/** The B5_IMAGE_VERIFY_PUBKEY var: one or two comma-separated base64 SPKIs, each a P-256 key whose fingerprint is pinned in code. */
export function loadPubkeys(raw, trustedFps = TRUSTED_IMAGE_KEY_FPS) {
  const problems = []; const keys = [];
  if (typeof raw !== "string" || !raw.trim()) return { keys, problems: ["B5_IMAGE_VERIFY_PUBKEY is missing or empty"] };
  const parts = raw.split(",").map((x) => x.trim());
  if (parts.length > 2 || parts.some((x) => !x)) return { keys, problems: ["B5_IMAGE_VERIFY_PUBKEY must hold one or two base64 keys"] };
  for (const [i, part] of parts.entries()) {
    const name = `B5_IMAGE_VERIFY_PUBKEY[${i}]`;
    const der = /^[A-Za-z0-9+/]+={0,2}$/.test(part) ? Buffer.from(part, "base64") : null;
    if (!der || der.toString("base64") !== part) { problems.push(`${name} is not canonical base64`); continue; }
    let key;
    try { key = createPublicKey({ key: der, format: "der", type: "spki" }); } catch { problems.push(`${name} is not an SPKI public key`); continue; }
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") { problems.push(`${name} is not a P-256 key`); continue; }
    const fp = sha256Hex(der);
    if (!trustedFps.includes(fp)) { problems.push(`${name} fingerprint ${fp} is not pinned in TRUSTED_IMAGE_KEY_FPS`); continue; }
    keys.push({ fp, key });
  }
  return { keys, problems };
}

/** One imageKinds entry for one image id, checked offline the way the Worker checks it. Returns the problems (empty = valid). */
export function checkSignedEntry(id, raw, want, keys, trust, now) {
  const bad = [];
  if (!validImageId(id)) return [`imageKinds key ${JSON.stringify(String(id).slice(0, 40))} is not a canonical image id`];
  const parsed = parseCustomerEntry(raw);
  if (!parsed.ok) return [`imageKinds[${id}] is not a valid signed customer entry (strict schema)`];
  const e = parsed.entry;
  if (e.env !== want) bad.push(`imageKinds[${id}].env is ${e.env}, this environment needs ${want}`);
  if (trust.revoked.includes(id)) bad.push(`imageKinds[${id}]: image ${id} is revoked`);
  if (!trust.checks.includes(e.checkSha256)) bad.push(`imageKinds[${id}].checkSha256 is not in ACCEPTED_CHECK_SHA256`);
  const verified = parseVerifiedAtMs(e.verifiedAt); const created = parseCreatedMs(e.createdAt);
  if (verified === null || created === null || verified > now + 300_000 || verified < created) bad.push(`imageKinds[${id}].verifiedAt is in the future or before the image was created`);
  else if (now - verified > IMAGE_SIG_MAX_AGE_DAYS * DAY_MS) bad.push(`imageKinds[${id}] signature is older than ${IMAGE_SIG_MAX_AGE_DAYS} days; re-sign it`);
  const key = keys.find((k) => k.fp === e.keyFp);
  if (!key) { bad.push(`imageKinds[${id}].keyFp is not one of the loaded keys`); return bad; }
  let ok = false;
  try {
    const payload = buildPayload({ imageId: id, createdAt: e.createdAt, imageSize: e.imageSize, env: want, checkSha256: e.checkSha256, verdict: "pass", verifiedAt: e.verifiedAt });
    ok = cryptoVerify("sha256", Buffer.from(payload), key.key, Buffer.from(p1363ToDer(decodeStoredSig(e.sig))));
  } catch { ok = false; }
  if (!ok) bad.push(`imageKinds[${id}] signature does not verify`);
  return bad;
}

/** Production creates no home with an operator ssh key at the Vultr rung either; NOT an image check, so a freeze deploy runs it too (KMS 12.5 H1, 5.2). */
export function checkNoOperatorSshKeys(blk, target) {
  if (target !== PRODUCTION_ENV) return [];
  const b5 = parseVar(blk, "B5_PROVISIONER_CONFIG");
  if (!b5 || typeof b5 !== "object") return [];
  const v = b5.vultr?.sshKeyIds;
  return v !== undefined && !(Array.isArray(v) && v.length === 0) ? [`${target}: B5_PROVISIONER_CONFIG.vultr.sshKeyIds must be empty`] : [];
}

/** The image-signature rules for one resolved block. `opts.trust` ({fps, checks, revoked}) and `opts.now` are for the tests. Production refuses what
 *  staging only warns about (a missing key var, an empty accepted-check list, an image without a signed entry). */
export function checkImageSignatures(blk, target, opts = {}) {
  const prod = target === PRODUCTION_ENV; const want = prod ? "prod" : "staging";
  const trust = { fps: opts.trust?.fps ?? TRUSTED_IMAGE_KEY_FPS, checks: opts.trust?.checks ?? ACCEPTED_CHECK_SHA256, revoked: opts.trust?.revoked ?? REVOKED_IMAGE_IDS };
  const now = opts.now ?? Date.now();
  const problems = []; const warnings = [];
  // KMS 5.2: staging needs the verification key and a signed entry for each configured snapshot exactly as production does, so every finding is a problem.
  // `warnings` stays in the return shape for callers but nothing is downgraded to it any more (Astra G3-KMS H7).
  const say = (msg) => problems.push(`${target}: ${msg}`);
  const b5 = parseVar(blk, "B5_PROVISIONER_CONFIG");
  if (!b5 || typeof b5 !== "object") return { problems, warnings };
  const rawKey = blk?.vars?.B5_IMAGE_VERIFY_PUBKEY;
  const kinds = b5.imageKinds !== null && typeof b5.imageKinds === "object" && !Array.isArray(b5.imageKinds) ? b5.imageKinds : {};
  let keys = [];
  if (rawKey === undefined || (typeof rawKey === "string" && !rawKey.trim())) say("B5_IMAGE_VERIFY_PUBKEY is not set: no signed image can be used");
  else { const l = loadPubkeys(rawKey, trust.fps); keys = l.keys; for (const m of l.problems) say(m); }
  if (trust.checks.length === 0) say("ACCEPTED_CHECK_SHA256 is empty (TODO in scripts/image-sig.mjs): no signature can name an accepted check script");
  if (prod) {
    if (Object.values(kinds).some((v) => v !== null && typeof v === "object" && v.kind === "staging-ops-ssh")) say("imageKinds holds a staging-ops-ssh entry");
  }
  const imgs = [b5.images?.hetzner?.x86, b5.images?.hetzner?.arm].map((v) => canonId(v)).filter(Boolean);
  for (const id of imgs) {
    const entry = Object.hasOwn(kinds, id) ? kinds[id] : undefined;
    if (entry === undefined) say(`images.hetzner image ${id} has no imageKinds entry`);
  }
  // Every present customer entry is verified: production needs its two pinned images valid; staging verifies whatever is listed.
  const check = (id) => { for (const m of checkSignedEntry(id, kinds[id], want, keys, trust, now)) say(m); };
  if (prod) { for (const id of imgs) if (Object.hasOwn(kinds, id)) check(id); }
  else for (const id of Object.keys(kinds)) { const v = kinds[id]; if (v !== null && typeof v === "object" && v.kind === "staging-ops-ssh") continue; check(id); }
  return { problems: [...new Set(problems)], warnings: [...new Set(warnings)] };
}

/** MURAGE_ENV label per deploy target. */
const LABEL_OF = { staging: ENV_STAGING, production: ENV_LIVE };
/** The shared environment policy (src/env-policy.mjs, the same rules the Worker runs) over a resolved env block. A wrangler.jsonc holds no
 *  secrets, so the secret-backed checks come back as `unverified` and are enforced at run time. */
export function environmentPolicy(resolved, target, opts = {}) {
  const label = LABEL_OF[target];
  const vars = resolved?.vars && typeof resolved.vars === "object" ? resolved.vars : {};
  const problems = [];
  if (vars.MURAGE_ENV !== label) problems.push(`${target}: vars.MURAGE_ENV must be exactly ${JSON.stringify(label)}`);
  const input = { ...vars, MURAGE_ENV: label };
  if ((Array.isArray(resolved?.d1_databases) ? resolved.d1_databases : []).some((d) => d?.binding === SINK_BINDING)) input.MAIL_SINK = true;
  // Production's approved provider images are the INTERSECTION of the pinned production images and the run-time set
  // APPROVED_provider_IMAGE_IDS.live (src/env-policy.mjs). An image in only one of the two is refused, and an empty intersection fails closed.
  const freeze = opts.freeze === true && target === "production";
  const home = opts.homeImages === undefined ? PRODUCTION_HOME_IMAGES : opts.homeImages;
  const injected = opts.homeImages === undefined ? APPROVED_HETZNER_IMAGE_IDS[ENV_LIVE] : (home ? [home.x86, home.arm] : []);
  const runtimeLive = new Set((opts.runtimeApprovedLive ?? injected).map(String));
  // Freeze: no image can be used (provisioning is off), so the approved-image requirement is one of the skipped image checks: the config's own ids stand in.
  let b5vars = null; if (freeze) { try { b5vars = JSON.parse(vars.B5_PROVISIONER_CONFIG); } catch { b5vars = null; } }
  const approvedImages = freeze ? Object.values(b5vars?.images?.hetzner ?? {}).map(String)
    : target === "production" ? (home ? [home.x86, home.arm] : []).filter((id) => runtimeLive.has(String(id))) : undefined;
  if (target === "production" && !freeze && approvedImages.length === 0) problems.push("production: no build host image is both pinned in PRODUCTION_HOME_IMAGES and approved in APPROVED_HETZNER_IMAGE_IDS.live");
  const result = envPolicy(input, { staticCheck: true, ...(target === "production" ? { approvedImages } : {}) });
  for (const p of result.problems) problems.push(`policy: ${p}`);
  return { problems, warnings: result.warnings, unverified: result.unverified };
}
/** Policy report (problems, warnings, unverified) for the wrangler.jsonc text and target, for the CLI. */
export function checkPolicy(text, target, opts = {}) {
  let config;
  try { config = JSON.parse(stripJsonc(text)); } catch { return { problems: ["wrangler.jsonc does not parse"], warnings: [], unverified: [] }; }
  const resolved = config?.env?.[target === "production" ? PRODUCTION_ENV : STAGING_ENV];
  if (!resolved || !LABEL_OF[target]) return { problems: [`no ${target} configuration`], warnings: [], unverified: [] };
  return environmentPolicy(resolved, target, opts);
}

const parseVar = (blk, k) => { try { return JSON.parse(blk?.vars?.[k]); } catch { return null; } };
/** Canonical decimal form of an image id the way the runtime reads it (digit strings become numbers): "0444544265" and 444544265 are the same image. */
const canonId = (v) => {
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? String(v) : null;
  if (typeof v === "string" && /^[0-9]{1,40}$/.test(v)) return String(BigInt(v));
  return null;
};
/** Digest compared lowercase, without the sha256: prefix. */
const canonDigest = (v) => (typeof v === "string" ? v.toLowerCase().replace(/^sha256:/, "") : null);
const show = (k, v) => (k === "digest" ? `sha256:${v}` : v);
const imagesOf = (b5, b3) => ({ x86: canonId(b5?.images?.hetzner?.x86), arm: canonId(b5?.images?.hetzner?.arm), digest: canonDigest(b3?.imageDigest) });
/** Home images bake in the control plane's public key, so an image used by staging can never be valid in production. A missing or unparsable staging reference is itself a problem. */
export function checkNotStagingImages(prod, others) {
  const out = [];
  const pick = (blk) => imagesOf(parseVar(blk, "B5_PROVISIONER_CONFIG"), parseVar(blk, "CLOUD_B3_CONFIG"));
  const [staging, ...rest] = others;
  const sb5 = parseVar(staging, "B5_PROVISIONER_CONFIG"); const sb3 = parseVar(staging, "CLOUD_B3_CONFIG");
  const ref = imagesOf(sb5, sb3);
  if (!sb5 || typeof sb5 !== "object" || !sb3 || typeof sb3 !== "object" || !ref.x86 || !ref.arm || !ref.digest) out.push("cannot verify production images differ from staging: staging config missing");
  const mine = pick(prod);
  // Every production id (x86 AND arm) against the full set of staging/top-level ids, so swapped architecture fields cannot slip through (Astra LAUNCHCP3 P2).
  const theirIds = new Set(); const theirDigests = new Set();
  for (const o of [staging, ...rest]) { const t = pick(o); for (const k of ["x86", "arm"]) if (t[k]) theirIds.add(t[k]); if (t.digest) theirDigests.add(t.digest); }
  for (const k of ["x86", "arm"]) if (mine[k] && theirIds.has(mine[k])) out.push(`production home image ${mine[k]} is a staging image (staging control key)`);
  if (mine.digest && theirDigests.has(mine.digest)) out.push(`production home image ${show("digest", mine.digest)} is a staging image (staging control key)`);
  return [...new Set(out)];
}
/** Production home images by ALLOWLIST: decoded x86/arm ids and imageDigest must equal `allow` exactly; `allow` itself must be well-formed and never a staging or superseded value. */
export function checkHomeAllowlist(prod, allow, stagingBlocks) {
  if (!allow) return ["production home images not pinned in PRODUCTION_HOME_IMAGES"];
  const out = [];
  const ids = { x86: canonId(allow.x86), arm: canonId(allow.arm) };
  if (!ids.x86 || !ids.arm || ids.x86 === "0" || ids.arm === "0" || ids.x86 !== allow.x86 || ids.arm !== allow.arm || ids.x86 === ids.arm) out.push("PRODUCTION_HOME_IMAGES: x86 and arm must be distinct canonical snapshot ids");
  if (typeof allow.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(allow.digest)) out.push("PRODUCTION_HOME_IMAGES: digest must be sha256:<64 lowercase hex>");
  const bad = new Set(); const badDigests = new Set();
  for (const img of SUPERSEDED_HOME_IMAGES) { for (const i of img.ids) bad.add(canonId(i)); badDigests.add(img.digest.toLowerCase()); }
  const pick = (blk) => imagesOf(parseVar(blk, "B5_PROVISIONER_CONFIG"), parseVar(blk, "CLOUD_B3_CONFIG"));
  for (const b of stagingBlocks) { const t = pick(b); for (const k of ["x86", "arm"]) if (t[k]) bad.add(t[k]); if (t.digest) badDigests.add(t.digest); }
  for (const k of ["x86", "arm"]) if (ids[k] && bad.has(ids[k])) out.push(`PRODUCTION_HOME_IMAGES.${k} ${ids[k]} is a staging or superseded image`);
  if (badDigests.has(canonDigest(allow.digest))) out.push("PRODUCTION_HOME_IMAGES.digest is a staging or superseded image");
  const b5 = parseVar(prod, "B5_PROVISIONER_CONFIG"); const b3 = parseVar(prod, "CLOUD_B3_CONFIG");
  const got = imagesOf(b5, b3);
  for (const k of ["x86", "arm"]) if (got[k] !== ids[k]) out.push(`production B5_PROVISIONER_CONFIG.images.hetzner.${k} is not the pinned production image (PRODUCTION_HOME_IMAGES.${k})`);
  if (b3?.imageDigest !== allow.digest) out.push("production CLOUD_B3_CONFIG.imageDigest is not the pinned production digest (PRODUCTION_HOME_IMAGES.digest)");
  return out;
}
/** Wrangler keys that can inject or replace bindings, vars or code at upload/bundle time. wrangler 4.149.0 merges unsafe.metadata (e.g. bindings) over the generated bindings,
 *  and define/alias rewrite the bundle, build runs a command, rules/unsafe_hello_world add modules or bindings. None may appear in env.production or at the top level (Astra LAUNCHCP3 P2). */
export const PRODUCTION_FORBIDDEN_KEYS = ["unsafe", "define", "alias", "build", "rules", "unsafe_hello_world"];
export function checkNoOverrides(config, prod) {
  const out = [];
  for (const [where, blk] of [["env.production", prod], ["top level", config]]) {
    if (!blk || typeof blk !== "object") continue;
    for (const k of PRODUCTION_FORBIDDEN_KEYS) {
      if (!(k in blk)) continue;
      // The one exception: env.production.define may hold exactly the build-environment key with this environment's value. Never at the top level.
      if (k === "define" && where === "env.production") {
        if (buildEnvDefineOk(blk, PRODUCTION_ENV)) continue;
        out.push(`production ${where}.define: anything but {${JSON.stringify(BUILD_ENV_DEFINE_KEY)}: ${JSON.stringify(JSON.stringify(PRODUCTION_ENV))}} is not allowed in production`);
        continue;
      }
      out.push(k === "unsafe" ? `production ${where}.unsafe: unsafe bindings/metadata are not allowed in production`
        : `production ${where}.${k}: ${k} can inject or override code or bindings and is not allowed in production`);
    }
  }
  return out;
}
/** Staging identifiers checked against the DECODED values of the two JSON-string vars (JSON escapes and number encodings cannot hide them):
 *  - every decoded string leaf and key against the non-numeric staging strings (storage box user "u687784", hostnames such as
 *    "u687784.your-storagebox.de", KMS and Stripe ids ...), as whole identities on token boundaries (hasIdentity: "u6877840" is a different
 *    Storage Box and passes; the raw scan in checkProduction uses the same match);
 *  - numeric staging provider ids (firewalls, ssh keys, storage box ...) only in RESOURCE-ID fields, canonicalized the way the runtime reads
 *    them, so 1.1725298e7, 11725298.0, "11725298" and "011725298" all count as 11725298. Resource-id fields are the schema's id fields
 *    (b5-config.ts: sshKeyIds, firewallIds, quarantineFirewallId, storageBox[].id; b3: any key ending in Id/Ids or named id). Other numeric
 *    settings (reservationMs, graceMs, caps ...) are never compared, here or in the raw scan (which skips strings that hold JSON): a
 *    coincidental value there is not an identifier. */
const RESOURCE_ID_KEY = /(^id$|Ids?$)/;
function checkStagingIdsDecoded(b3, b5, at, others = []) {
  const badNum = new Set(STAGING_ONLY_STRINGS.filter(isNumeric).map(canonId));
  const badStr = STAGING_ONLY_STRINGS.filter((x) => !isNumeric(x));
  const scan = (name, v, path, key, depth) => {
    if (depth > 20 || v === null || v === undefined) return;
    if (typeof v === "string") {
      // A JSON document inside a string leaf is decoded and scanned instead of being host-matched as text (the raw host scan exempts every
      // JSON-holding string). It is decoded from the same trimmed text holdsJson validated, as the runtime readers trim before JSON.parse.
      if (holdsJson(v)) scan(name, JSON.parse(v.trim()), `${path}(json)`, "", depth + 1);
      else for (const bad of badStr) if (hasIdentity(v, bad)) at(`${name}${path}`, `staging-only value ${bad}`);
    }
    if ((typeof v === "number" || typeof v === "string") && RESOURCE_ID_KEY.test(key)) {
      let c = canonId(v);
      if (c === null && typeof v === "number" && Number.isFinite(v) && Number.isInteger(v)) c = String(BigInt(v));
      if (c !== null && badNum.has(c)) at(`${name}${path}`, `staging provider resource id ${c} (decoded value ${JSON.stringify(v)})`);
    } else if (Array.isArray(v)) v.forEach((x, i) => scan(name, x, `${path}[${i}]`, key, depth + 1));
    else if (typeof v === "object") for (const [k, x] of Object.entries(v)) { scan(name, k, `${path}.<key>`, "", depth + 1); scan(name, x, `${path}.${k}`, k, depth + 1); }
  };
  if (b3) scan("CLOUD_B3_CONFIG", b3, "", "", 0);
  if (b5) scan("B5_PROVISIONER_CONFIG", b5, "", "", 0);
  for (const [name, v] of others) scan(name, v, "", "", 0);
}
/** Superseded images checked against the DECODED values of the two JSON-string vars (JSON escapes cannot hide an id), canonicalized. */
function checkSupersededDecoded(b3, b5, at) {
  const ids = new Map(); const digests = new Map();
  for (const img of SUPERSEDED_HOME_IMAGES) { for (const i of img.ids) ids.set(canonId(i), img); digests.set(img.digest.toLowerCase(), img); }
  for (const a of ["x86", "arm"]) {
    const raw = b5?.images?.hetzner?.[a]; const hit = ids.get(canonId(raw));
    if (hit) at(`B5_PROVISIONER_CONFIG.images.hetzner.${a}`, `home image ${canonId(raw)} is superseded (${hit.name})`);
  }
  const hit = digests.get(canonDigest(b3?.imageDigest));
  if (hit) at("CLOUD_B3_CONFIG.imageDigest", `home image ${canonDigest(b3.imageDigest)} is superseded (${hit.name})`);
}

/** The production-only rules for the RESOLVED env.production block: no placeholder, nothing staging-only, no test Stripe, real mail, sales closed or explicitly open. */
export function checkProduction(p, opts = {}) {
  const freeze = opts.freeze === true;
  const dark = opts.dark === true;
  const out = [];
  const at = (path, msg) => out.push(`production ${path}: ${msg}`);
  const vars = p.vars && typeof p.vars === "object" ? p.vars : {};
  // 1. Placeholders, anywhere (keys, values, and inside the JSON-string vars).
  for (const [path, s] of walk(p, "$.env.production")) if (s.includes(PLACEHOLDER)) at(path, `still a ${PLACEHOLDER} placeholder (${s.slice(s.indexOf(PLACEHOLDER)).split(/["\\,\s]/)[0]})`);
  // 2. Staging-only strings, anywhere. This is also the test-Stripe refusal: the staging price and portal ids, and any sk_test_/pk_test_/rk_test_ literal.
  for (const [path, s] of walk(p, "$.env.production")) for (const bad of STAGING_ONLY_STRINGS) if (isNumeric(bad) || HOST_IDENTITIES.includes(bad) ? (!holdsJson(s) && hasIdentity(s, bad)) : hasIdentity(s, bad)) at(path, `staging-only value ${bad}`);
  if (!freeze || dark) for (const [path, s] of walk(p, "$.env.production")) for (const img of SUPERSEDED_HOME_IMAGES) for (const bad of [...img.ids, img.digest]) if (hasIdentity(s, bad)) at(path, `home image ${bad} is superseded (${img.name})`);
  // 3. Staging-only vars and the mail sink.
  for (const k of STAGING_ONLY_VARS) if (k in vars) at(`vars.${k}`, "staging-only variable");
  if ((p.d1_databases ?? []).some((d) => d?.binding === SINK_BINDING)) at("d1_databases", `${SINK_BINDING} must not exist`);
  // 4. Worker surface.
  if (p.workers_dev !== false) at("workers_dev", "must be false");
  const routes = p.routes;
  if (!Array.isArray(routes) || routes.length !== 1 || routes[0]?.pattern !== PRODUCTION_ROUTE || routes[0]?.custom_domain !== true) at("routes", `must be exactly one custom domain ${PRODUCTION_ROUTE}`);
  if (vars.BETTER_AUTH_URL !== `https://${PRODUCTION_ROUTE}`) at("vars.BETTER_AUTH_URL", `must be https://${PRODUCTION_ROUTE}`);
  // 5. Real mail through Email Sending from the murage.ai sender.
  const se = p.send_email;
  if (!Array.isArray(se) || se.length !== 1 || se[0]?.name !== "EMAIL" || JSON.stringify(se[0]?.allowed_sender_addresses) !== JSON.stringify([PRODUCTION_SENDER])) at("send_email", `must be one EMAIL binding allowed to send only as ${PRODUCTION_SENDER}`);
  if (vars.EMAIL_FROM !== PRODUCTION_SENDER) at("vars.EMAIL_FROM", `must be ${PRODUCTION_SENDER}`);
  // 6. Stripe: live objects only; sales stay closed unless STRIPE_ALLOW_LIVE is exactly "1".
  if ("STRIPE_ALLOW_LIVE" in vars && vars.STRIPE_ALLOW_LIVE !== "1") at("vars.STRIPE_ALLOW_LIVE", 'absent (sales closed) or exactly "1" (open)');
  for (const k of ["STRIPE_PRICE_STARTER", "STRIPE_PRICE_PRO", "STRIPE_PRICE_MAX"]) if (!/^price_[A-Za-z0-9]{6,64}$/.test(vars[k] ?? "")) at(`vars.${k}`, "must be a live price id");
  if (new Set(["STRIPE_PRICE_STARTER", "STRIPE_PRICE_PRO", "STRIPE_PRICE_MAX"].map((k) => vars[k])).size !== 3) at("vars.STRIPE_PRICE_*", "the three prices must differ");
  if (!/^bpc_[A-Za-z0-9]{6,64}$/.test(vars.STRIPE_PORTAL_CONFIGURATION ?? "")) at("vars.STRIPE_PORTAL_CONFIGURATION", "must be the live portal configuration id");
  if (!kmsKeyArnValid(vars.AWS_KMS_KEY_ARN)) at("vars.AWS_KMS_KEY_ARN", "must be the production KMS key ARN");
  // key-wrapper.ts kmsFromEnv: with the ARN set, the region must be set too (else every pairing/provisioning is 500 cloud_key_unavailable); it must be the ARN's own region (the Worker's cloudOperating applies the same scripts/kms-region.mjs rule).
  if (kmsRegionError(vars.AWS_KMS_REGION, vars.AWS_KMS_KEY_ARN) !== null) at("vars.AWS_KMS_REGION", "must be set to the region of AWS_KMS_KEY_ARN");
  // 7. Homes: opaque names on the murage.ai zone in this account, live provisioning, EU only.
  if (vars.CLOUD_HOME_HOST_SUFFIX !== "murage.ai") at("vars.CLOUD_HOME_HOST_SUFFIX", "must be murage.ai");
  if (vars.CLOUD_HOME_ACCOUNT_ID !== PRODUCTION_ACCOUNT || vars.CLOUDFLARE_ACCOUNT_ID !== PRODUCTION_ACCOUNT) at("vars.CLOUD_HOME_ACCOUNT_ID", "must be the production account");
  if (!vars.CLOUD_HOME_ZONE_ID || vars.CLOUD_HOME_ZONE_ID !== vars.CLOUDFLARE_ZONE_ID) at("vars.CLOUD_HOME_ZONE_ID", "must equal CLOUDFLARE_ZONE_ID (the murage.ai zone)");
  if (dark) { if (B3_VAR in vars && vars[B3_VAR] !== B3_OFF) at(`vars.${B3_VAR}`, `must be absent or ${JSON.stringify(B3_OFF)} in a dark deploy`); }
  else if (vars.CLOUD_B3_MODE !== "live") at("vars.CLOUD_B3_MODE", "must be live");
  let b3; let b5;
  const decode = (k) => {
    let v; try { v = JSON.parse(vars[k]); } catch { at(`vars.${k}`, "is not JSON"); return undefined; }
    if (!v || typeof v !== "object" || Array.isArray(v)) { at(`vars.${k}`, "must decode to a JSON object (not null, false, 0, \"\" or an array)"); return undefined; }
    return v;
  };
  b3 = decode("CLOUD_B3_CONFIG"); b5 = decode("B5_PROVISIONER_CONFIG");
  if (b3) {
    if (!freeze || dark) checkSupersededDecoded(b3, undefined, at);
    if (!freeze && !/^sha256:[0-9a-f]{64}$/.test(b3.imageDigest ?? "")) at("CLOUD_B3_CONFIG.imageDigest", "must be the pinned 4C image digest");
    // The provider provisioner ignores the relay IP: a fence moves the home onto B5 quarantineFirewallId (full isolation, no relay server).
    // Production must carry exactly the TEST-NET-2 sentinel NO_QUARANTINE_RELAY_IPV4 (TEST-NET-1 is the staging marker), so no routable relay creeps in.
    if (b3.quarantineRelayIP !== NO_QUARANTINE_RELAY_IPV4) at("CLOUD_B3_CONFIG.quarantineRelayIP", `must be the no-relay sentinel ${NO_QUARANTINE_RELAY_IPV4} (quarantine is the firewall, there is no relay server)`);
    // Slots are listed rows (capacity) and/or blocks (capacityBlocks: prefix-1 .. prefix-count). Production needs at least one, every one an
    // available EU prd- slot, and no id twice.
    const blocks = b3.capacityBlocks === undefined ? [] : b3.capacityBlocks;
    if (!Array.isArray(b3.capacity) || !Array.isArray(blocks)) at("CLOUD_B3_CONFIG.capacity", "capacity and capacityBlocks must be arrays");
    else {
      const ids = b3.capacity.map((c) => c?.id);
      for (const b of blocks) if (Number.isInteger(b?.count) && b.count >= 1 && b.count <= 1000) for (let i = 1; i <= b.count; i += 1) ids.push(`${b.prefix}-${i}`);
      if (ids.length < 1) at("CLOUD_B3_CONFIG.capacity", "needs admission slots");
      if (new Set(ids).size !== ids.length) at("CLOUD_B3_CONFIG.capacity", "an admission slot id appears twice");
    }
    for (const c of b3.capacity ?? []) if (!["fsn1", "nbg1", "hel1"].includes(c.location) || c.outcome !== "available" || !/^[\w-]{1,128}$/.test(c.projectId ?? "") || !/^[\w-]{1,64}$/.test(c.serverType ?? "") || !/^prd-\d+$/.test(c.id ?? "")) { at("CLOUD_B3_CONFIG.capacity", `slot ${JSON.stringify(c?.id)} is not an available EU prd- slot`); break; }
    for (const b of Array.isArray(blocks) ? blocks : []) if (b?.prefix !== "prd" || !Number.isInteger(b?.count) || b.count < 1 || b.count > 1000 || !["fsn1", "nbg1", "hel1"].includes(b.location) || b.outcome !== "available" || !/^[\w-]{1,128}$/.test(b.projectId ?? "") || !/^[\w-]{1,64}$/.test(b.serverType ?? "")) { at("CLOUD_B3_CONFIG.capacityBlocks", `block ${JSON.stringify(b?.prefix)} is not an available EU prd block of 1..1000 slots`); break; }
  }
  // EVERY other JSON-holding string in the block gets the same decoded-leaf scan, so the raw scan's JSON exemption always has decoded coverage.
  const others = [];
  for (const [path, str] of walk(p, "$.env.production")) {
    if (!holdsJson(str) || /\.(?:CLOUD_B3_CONFIG|B5_PROVISIONER_CONFIG)$/.test(path)) continue;
    others.push([path, JSON.parse(str.trim())]);
  }
  checkStagingIdsDecoded(b3, b5, at, others);
  if (b5) {
    const img = b5.images?.hetzner ?? {};
    if (!freeze || dark) checkSupersededDecoded(undefined, b5, at);
    if (!freeze) for (const a of ["x86", "arm"]) if (typeof img[a] !== "string" || !/^[1-9][0-9]{0,18}$/.test(img[a]) || !Number.isSafeInteger(Number(img[a]))) at(`B5_PROVISIONER_CONFIG.images.hetzner.${a}`, "must be a canonical numeric 4C snapshot id (no leading zeros, no escapes, a safe integer the runtime reads exactly)");
    if (!freeze && img.x86 && canonId(img.x86) === canonId(img.arm)) at("B5_PROVISIONER_CONFIG.images.hetzner", "x86 and arm must differ");
    if (Object.keys(b5.images?.vultr ?? {}).length > 0) at("B5_PROVISIONER_CONFIG.images.vultr", "no Vultr rung at launch");
    if (JSON.stringify(b5.opsSshFrom ?? []) !== "[]") at("B5_PROVISIONER_CONFIG.opsSshFrom", "customer homes have no operator ssh in production");
    if (!(b5.forbiddenTypePrefixes ?? []).includes("cpx")) at("B5_PROVISIONER_CONFIG.forbiddenTypePrefixes", "must forbid cpx");
    // Production homes never carry operator ssh keys (a freeze deploy needs the same: sshKeyIds exactly []); firewalls are mandatory in both modes.
    if (!Array.isArray(b5.sshKeyIds) || b5.sshKeyIds.length !== 0) at("B5_PROVISIONER_CONFIG.sshKeyIds", "must be [] (no operator ssh key on a production home)");
    if (!Array.isArray(b5.firewallIds) || b5.firewallIds.length < 1 || !b5.firewallIds.every(Number.isInteger)) at("B5_PROVISIONER_CONFIG.firewallIds", "needs real integer ids");
    if (!Number.isInteger(b5.quarantineFirewallId) || b5.quarantineFirewallId < 1) at("B5_PROVISIONER_CONFIG.quarantineFirewallId", "needs the real firewall id");
    else if (Array.isArray(b5.firewallIds) && b5.firewallIds.includes(b5.quarantineFirewallId)) at("B5_PROVISIONER_CONFIG.quarantineFirewallId", "must be its own firewall, not one of firewallIds");
    if (!Array.isArray(b5.storageBox) || b5.storageBox.length < 1 || !b5.storageBox.every((x) => Number.isInteger(x?.id) && /^u\d+$/.test(x?.mainUser ?? ""))) at("B5_PROVISIONER_CONFIG.storageBox", "needs a real Storage Box (integer id, uNNN main user)");
    const loc = b5.hetznerLocations ?? ["fsn1", "nbg1", "hel1"];
    if (!loc.every((l) => ["fsn1", "nbg1", "hel1"].includes(l))) at("B5_PROVISIONER_CONFIG.hetznerLocations", "EU locations only");
    const types = [...Object.values(b5.ladders ?? {}).flat().map((r) => r.serverType), ...Object.values(b5.pool?.classes ?? {}).flatMap((c) => (c.rungs ?? []).map((r) => r.serverType))];
    if (types.some((x) => String(x).startsWith("cpx"))) at("B5_PROVISIONER_CONFIG", "no cpx server type in production");
    if ((Object.values(b5.ladders ?? {}).flat()).some((r) => r.provider !== "hetzner")) at("B5_PROVISIONER_CONFIG.ladders", "build host only at launch");
    const pool = b5.pool;
    if (!pool) at("B5_PROVISIONER_CONFIG.pool", "the warm pool is configured for launch");
    else {
      if (pool.env !== "production") at("B5_PROVISIONER_CONFIG.pool.env", "must be production");
      if (!(pool.monthlyIdleCapEur > 0 && pool.monthlyIdleCapEur <= 700)) at("B5_PROVISIONER_CONFIG.pool.monthlyIdleCapEur", "must be set and at most EUR 700");
    }
  }
  // 8. Required secrets.
  const req = new Set(p.secrets?.required ?? []);
  for (const s of PRODUCTION_REQUIRED_SECRETS) if (!req.has(s) && !(dark && STRIPE_SECRET_NAMES.includes(s))) at("secrets.required", `must name ${s}`);
  for (const s of req) if (s === "MAIL_SINK_ALLOWLIST" || s === "STAGING_MAIL_SINK") at("secrets.required", `${s} is staging-only`);
  for (const s of PRODUCTION_OPTIONAL_SECRETS) if (s in vars) at(`vars.${s}`, "is a secret: put it with wrangler secret put, never as a var");
  // 9. Flux (FLUX_SWITCH_VAR): off (absent) or on with both secrets required and all three Flux hosts; each host exactly its production origin.
  if (FLUX_SWITCH_VAR in vars && vars[FLUX_SWITCH_VAR] !== "1") at(`vars.${FLUX_SWITCH_VAR}`, 'absent (Flux off) or exactly "1" (Flux on)');
  if (vars[FLUX_SWITCH_VAR] === "1") {
    for (const s of PRODUCTION_FLUX_SECRETS) if (!req.has(s)) at("secrets.required", `must name ${s} while Flux is on`);
    for (const k of FLUX_BASE_VARS) if (!(k in vars)) at(`vars.${k}`, "must be set while Flux is on");
  }
  for (const k of FLUX_BASE_VARS) if (k in vars) { const why = productionFluxOriginProblem(k, vars[k]); if (why) at(`vars.${k}`, why); }
  for (const s of PRODUCTION_FLUX_SECRETS) if (s in vars) at(`vars.${s}`, "is a secret: put it with wrangler secret put, never as a var");
  return out;
}

/** True when a PROD_TODO_ placeholder is a VALUE in env.production. A marker in a comment or a key never counts (Astra G3-KMS H6). */
export function productionHasPlaceholderValue(text) {
  let config;
  try { config = JSON.parse(stripJsonc(text)); } catch { return false; }
  const prod = config?.env?.[PRODUCTION_ENV];
  if (prod === undefined || prod === null) return false;
  for (const [, str] of walk(prod, `$.env.${PRODUCTION_ENV}`)) if (str.includes(PLACEHOLDER)) return true;
  return false;
}

/**
 * The CLI's whole decision, pure so tests can run it: { code, out, err } for the wrangler.jsonc `text`. Every mode runs the FULL checkDeploy (signatures included).
 * The one allowance: while a PROD_TODO_ placeholder remains as a VALUE in env.production, that block's problems are reported as "not deployable yet" instead of
 * refusing (the checked-in config is not deployable yet). A staging problem is always a refusal.
 * @param {string} text @param {string} file @param {{ freeze?: boolean, homeImages?: any, trust?: any, now?: number }} [opts]
 */
export function cliCheck(text, file, opts = {}) {
  const out = []; const err = [];
  if (opts.dark && opts.freeze) return { code: 1, out, err: ["check-deploy: --dark and --freeze are exclusive"] };
  if (opts.dark) {
    const { dark, freeze: _f, ...rest } = opts;
    const problems = checkDeploy(text, "production", { ...rest, dark: true });
    if (problems.length > 0) return { code: 1, out, err: [`check-deploy --dark: REFUSED (${file})\n${problems.map((p) => `  - ${p}`).join("\n")}`] };
    return { code: 0, out: [`check-deploy --dark: ok (${file}); config checked: sales off, B3 off, no Stripe secret required or in config, ${STRIPE_LIVE_GATE} absent, no mail sink, home images empty or pinned. NOT checked here: the Worker's bound secrets; \`deploy.mjs production --dark\` runs the live wrangler secret list preflight`], err };
  }
  if (opts.freeze) {
    const { freeze, ...rest } = opts;
    const frozen = checkDeploy(text, "production", { ...rest, freeze: true });
    if (frozen.length > 0) return { code: 1, out, err: [`check-deploy --freeze: REFUSED (${file})\n${frozen.map((p) => `  - ${p}`).join("\n")}`] };
    return { code: 0, out: [`check-deploy --freeze: ok (${file}); skipped: ${FREEZE_SKIPPED_CHECKS.join("; ")}`], err };
  }
  const problems = checkConfig(text).map(redactSecretShapes);
  const { freeze: _unused, ...rest } = opts;
  for (const target of [STAGING_ENV, PRODUCTION_ENV]) {
    const report = checkPolicy(text, target, rest);
    if (report.unverified.length > 0) out.push(`check-deploy: unverified here (${target}), enforced at run time: ${report.unverified.join(", ")}`);
    const pending = target === PRODUCTION_ENV && productionHasPlaceholderValue(text);
    for (const p of checkDeploy(text, target, rest)) (pending ? err.push(`check-deploy: not deployable yet (${target}): ${p}`) : problems.push(p));
  }
  const unique = [...new Set(problems)];
  if (unique.length > 0) return { code: 1, out, err: [...err, `check-deploy: REFUSED (${file})\n${unique.map((p) => `  - ${p}`).join("\n")}`] };
  return { code: 0, out: [...out, `check-deploy: ok (${file})`], err };
}

const invokedDirectly = typeof process !== "undefined" && Array.isArray(process.argv) && typeof process.argv[1] === "string"
  && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").slice(-2).join("/"));
async function main() {
  const { readFileSync } = await import("node:fs");
  const freeze = process.argv.slice(2).includes("--freeze");
  const dark = process.argv.slice(2).includes("--dark");
  const file = process.argv.slice(2).find((a) => a !== "--freeze" && a !== "--dark") ?? "wrangler.jsonc";
  const r = cliCheck(readFileSync(file, "utf8"), file, { freeze, dark });
  for (const m of r.out) console.log(m);
  for (const m of r.err) console.error(m);
  if (r.code !== 0) process.exit(r.code);
}
if (invokedDirectly) void main();
