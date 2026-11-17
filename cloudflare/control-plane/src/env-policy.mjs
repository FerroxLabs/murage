// SPDX-License-Identifier: AGPL-3.0-or-later
// One environment policy for the control plane, shared by the Worker (src/config.ts, src/env-isolation.ts) and the deploy scripts
// (scripts/check-deploy.mjs, scripts/deploy.mjs). Plain JavaScript with no dependencies so node can import it.
//
// `MURAGE_ENV` is "staging" or "live" and nothing else. Each environment has a positive description (the identities it may use) and a
// list of names it must not carry. Everything here is a configuration guard: the provider-side scope of each credential is the boundary,
// and this code makes a mixed configuration fail closed before it can act.
//
// Inputs are plain name -> value maps. A name is "present" when its value is not undefined (an empty string counts as present).

export const ENV_STAGING = "staging";
export const ENV_LIVE = "live";
export const ENVIRONMENTS = Object.freeze([ENV_STAGING, ENV_LIVE]);

export const STAGING_WORKER = "murage-control-plane-staging";
export const STAGING_ACCOUNT = "874fe1689a53e6f56ff74816a9f23b26";
export const PRODUCTION_WORKER = "murage-control-plane";
export const PRODUCTION_ACCOUNT = "b83123326a4b9ad76831b9cb9365b33b";
export const PRODUCTION_DB_ID = "5b7763a9-6674-451e-a5ba-4ba49ab30014";
export const STAGING_DB_ID = "2bbc01ca-09b4-4ca9-8cb1-5471f8abb070";
export const SINK_DATABASE_NAME = "murage-cloud-staging-mailsink";
export const SINK_DATABASE_ID = "7c9c6777-f7a1-4804-8596-7933a523d392";

export const MURAGE_AI_ZONE_ID = "98521dceb5535df78337fc26a9dc4d73";
export const MURAGE_AI_SUFFIX = "murage.ai";
export const LIVE_SENDLANE_LIST_ID = "37";
export const STAGING_KMS_ARN = "arn:aws:kms:eu-west-1:149471050106:key/0c7fb20d-226b-4ccc-91c5-93fd414c1afb";
export const LIVE_KMS_ARN = "arn:aws:kms:eu-west-1:149471050106:key/b79b4dba-d9f8-485a-937b-c4704faba55b";

/** Public halves of the control-plane signing keys (the pins the desktop and the images carry). */
export const SIGNING_PINS = Object.freeze({
  [ENV_STAGING]: Object.freeze({ kty: "EC", crv: "P-256", x: "i5M-386m8yAMLeXSx5h7WbET_2AafxG1j1slNbR0ryw", y: "QkbUUqaVFP311VUhx04G7cOXxalr_Xs6AmekK1JJX88" }),
  [ENV_LIVE]: Object.freeze({ kty: "EC", crv: "P-256", x: "B3u5CZzfv4sBQKMvGYS-zblweYQNdEx_fBpOnpc8_KY", y: "bt8PYOR1VLwj1b-WbG6M81RHC_NJ4N1BX8OV0ai3gyU" }),
});

/** Independently approved provider snapshot ids per environment. Live is empty until its images exist in its own project. */
export const APPROVED_HETZNER_IMAGE_IDS = Object.freeze({
  // 452494027 (x86) and 452471210 (arm) are what new staging homes get; 452086092, 452016490, 451603575 and 451260442 stay approved so a held home built on them can rebuild (452086092 also backs the warm-pool servers).
  [ENV_STAGING]: Object.freeze(["452494027", "452471210", "452086092", "452016490", "451603575", "451260442"]),
  // 451878214 (x86) and 451877100 (arm) are what new prod homes get; 449759230 and 449759735 stay approved so a home built on them can rebuild.
  [ENV_LIVE]: Object.freeze(["451878214", "451877100", "449759230", "449759735"]),
});

/**
 * Staging values that still point at the live zone, account or list until migration steps 5 and 9 move them. They are reported as
 * warnings for staging, and are refused outright for live-only reasons elsewhere. Remove each entry when its step lands.
 */
export const LEGACY_STAGING_EXCEPTIONS = Object.freeze({
  murage_ai_zone: "home zone is the murage.ai zone (until migration step 5)",
  live_account_for_homes: "home account is the live Cloudflare account (until migration step 5)",
  murage_ai_suffix: "home host suffix is murage.ai (until migration step 5)",
  live_sendlane_list: "Sendlane list id is the live list (until migration step 9; writes are off)",
});

/** Variables and bindings that must not exist at all in live. */
export const LIVE_FORBIDDEN = Object.freeze([
  "CLOUD_CP0_STAGING", "CLOUD_KEK_V1", "MAIL_SINK", "STAGING_MAIL_SINK", "MAIL_SINK_ALLOWLIST", "VULTR_API_KEY",
]);
/** Variables that must not exist at all in staging. */
export const STAGING_FORBIDDEN = Object.freeze(["STRIPE_ALLOW_LIVE"]);

/** Flux for Cloud. The switch (src/b4-flux-config.ts fluxRoutesEnabled) is absent (off) or exactly "1" (on). Live may switch it on only
 *  with BOTH Flux secrets required (scripts/check-deploy.mjs; at run time a missing one holds every new Flux activation and issuance, see
 *  b4-flux-config.ts fluxCredentialsReady) and ALL THREE Flux hosts set. Every Flux host live names, on or off, is EXACTLY its production
 *  origin (PRODUCTION_FLUX_ORIGINS, one per variable, no suffix rule): anything else is refused by check-deploy and, at run time, is
 *  env_mixed (503) before any work. */
export const FLUX_SWITCH_VAR = "CLOUD_FLUX_ROUTES_ENABLED";
export const PRODUCTION_FLUX_SECRETS = Object.freeze(["FLUX_CLOUD_SERVICE_TOKEN", "FLUX_CLOUD_GRANTS_TOKEN"]);
/** The one production origin each Flux host variable may hold (GrokBuild / Astra PRODFLUX HIGH 1: exact, per variable). */
export const PRODUCTION_FLUX_ORIGINS = Object.freeze({
  FLUX_API_BASE: "https://api.fluxrouter.ai",
  FLUX_CLOUD_GRANTS_URL: "https://api.fluxrouter.ai",
  FLUX_APP_BASE: "https://fluxrouter.ai",
});
/** Every Flux host variable; all three are required while production Flux is on. */
export const FLUX_BASE_VARS = Object.freeze(Object.keys(PRODUCTION_FLUX_ORIGINS));
/** null when `value` is exactly the production origin of Flux host variable `name` (byte for byte: no trailing slash, case, port, path,
 *  credentials, whitespace or other host). Else why not (never the value: run-time refusals log rule text only). THE one validator: the
 *  deploy check (scripts/check-deploy.mjs) and the Worker (envPolicy, src/env-isolation.ts) both call it. */
export function productionFluxOriginProblem(name, value) {
  const want = Object.prototype.hasOwnProperty.call(PRODUCTION_FLUX_ORIGINS, name) ? PRODUCTION_FLUX_ORIGINS[name] : undefined;
  if (want === undefined) return "is not a Flux host variable";
  if (typeof value !== "string") return "must be a string";
  if (value !== want) return `must be exactly ${want}`;
  return null;
}

const present = (input, name) => input[name] !== undefined && input[name] !== null;
const str = (input, name) => (typeof input[name] === "string" ? input[name].trim() : "");
const OFF = new Set(["off", "0", "false"]);

/** The environment label if it is exactly one of the two, else null. */
export function environmentOf(input) {
  const v = input?.MURAGE_ENV;
  return v === ENV_STAGING || v === ENV_LIVE ? v : null;
}

/** The parsed B5_PROVISIONER_CONFIG, null when absent, or the string "invalid" when present but not an object. */
function provisionerOf(input) {
  if (!present(input, "B5_PROVISIONER_CONFIG")) return null;
  try {
    const v = JSON.parse(String(input.B5_PROVISIONER_CONFIG));
    return v && typeof v === "object" && !Array.isArray(v) ? v : "invalid";
  } catch { return "invalid"; }
}

/** provider image ids a provisioner config names (strings), or null if the shape is not understood. */
export function hetznerImageIds(provisioner) {
  const hz = provisioner?.images?.hetzner;
  if (hz === undefined) return [];
  if (!hz || typeof hz !== "object" || Array.isArray(hz)) return null;
  return Object.values(hz).map((v) => String(v));
}

/**
 * The environment policy over an effective configuration. `input` holds the vars, secrets and binding names (a binding is any non-undefined
 * value). `approvedImages` replaces the environment's approved image ids (the deploy check passes the pinned production images). `{ staticCheck: true }` is for a resolved wrangler.jsonc, which holds no secrets: secret-backed checks are listed in `unverified`.
 * Returns { env, problems, warnings, unverified }. Empty `problems` means the configuration is consistent for its environment.
 */
export function envPolicy(input, { staticCheck = false, approvedImages = undefined } = {}) {
  const problems = []; const warnings = []; const unverified = [];
  const env = environmentOf(input ?? {});
  if (!env) return { env: null, problems: ["MURAGE_ENV must be exactly staging or live"], warnings, unverified };
  const live = env === ENV_LIVE;
  const bad = (m) => problems.push(`${env}: ${m}`);

  // Names that must not exist.
  for (const name of live ? LIVE_FORBIDDEN : STAGING_FORBIDDEN) if (present(input, name)) bad(`${name} must not be set`);

  // Home zone, account and suffix (and the legacy edge settings that name the same things).
  const zones = ["CLOUDFLARE_ZONE_ID", "CLOUD_HOME_ZONE_ID"].filter((n) => present(input, n));
  const accounts = ["CLOUDFLARE_ACCOUNT_ID", "CLOUD_HOME_ACCOUNT_ID"].filter((n) => present(input, n));
  const suffixes = ["COMPANION_HOST_SUFFIX", "CLOUD_HOME_HOST_SUFFIX"].filter((n) => present(input, n));
  if (live) {
    for (const n of zones) if (str(input, n) !== MURAGE_AI_ZONE_ID) bad(`${n} must be the murage.ai zone`);
    for (const n of accounts) if (str(input, n) !== PRODUCTION_ACCOUNT) bad(`${n} must be the live Cloudflare account`);
    for (const n of suffixes) if (str(input, n) !== MURAGE_AI_SUFFIX) bad(`${n} must be ${MURAGE_AI_SUFFIX}`);
  } else {
    if (zones.some((n) => str(input, n) === MURAGE_AI_ZONE_ID)) warnings.push(LEGACY_STAGING_EXCEPTIONS.murage_ai_zone);
    if (accounts.some((n) => str(input, n) === PRODUCTION_ACCOUNT)) warnings.push(LEGACY_STAGING_EXCEPTIONS.live_account_for_homes);
    if (suffixes.some((n) => str(input, n) === MURAGE_AI_SUFFIX)) warnings.push(LEGACY_STAGING_EXCEPTIONS.murage_ai_suffix);
  }

  // KMS key: exact full ARN of this environment when configured.
  if (present(input, "AWS_KMS_KEY_ARN")) {
    if (str(input, "AWS_KMS_KEY_ARN") !== (live ? LIVE_KMS_ARN : STAGING_KMS_ARN)) bad("AWS_KMS_KEY_ARN is not this environment's key");
  }

  // Stripe: a key of the other mode is a breach. A key of no known shape cannot act in either mode; billing configuration rejects it.
  if (present(input, "STRIPE_SECRET_KEY")) {
    const key = str(input, "STRIPE_SECRET_KEY");
    if (/^(rk|sk)_(live|test)_/.test(key) && !new RegExp(`^(rk|sk)_${live ? "live" : "test"}_`).test(key)) bad(`STRIPE_SECRET_KEY must be a ${live ? "live" : "test"}-mode key`);
  } else if (staticCheck) unverified.push("STRIPE_SECRET_KEY");

  // Sendlane.
  if (!live) {
    if (present(input, "SENDLANE_WRITES") && !OFF.has(str(input, "SENDLANE_WRITES").toLowerCase())) bad("SENDLANE_WRITES must be off");
    if (str(input, "SENDLANE_LIST_ID") === LIVE_SENDLANE_LIST_ID) warnings.push(LEGACY_STAGING_EXCEPTIONS.live_sendlane_list);
  }

  // Provisioner: images, Vultr, operator ssh.
  const provisioner = provisionerOf(input);
  if (provisioner === "invalid") bad("B5_PROVISIONER_CONFIG is not a JSON object");
  else if (provisioner) {
    const ids = hetznerImageIds(provisioner);
    const approved = new Set(approvedImages ?? APPROVED_HETZNER_IMAGE_IDS[env]);
    if (ids === null) bad("B5_PROVISIONER_CONFIG.images.hetzner has an unknown shape");
    else for (const id of ids) if (!approved.has(id)) bad("a build host image id is not in this environment's approved set");
    if (live) {
      const vultr = provisioner.images?.vultr;
      if (vultr !== undefined && (typeof vultr !== "object" || vultr === null || Object.keys(vultr).length > 0)) bad("Vultr images are not allowed");
      const ops = provisioner.opsSshFrom;
      if (ops !== undefined && (!Array.isArray(ops) || ops.length > 0)) bad("opsSshFrom must be empty");
    }
  }

  // Flux: live talks to production Flux only, on or off; the switch is "1" or absent.
  if (live) {
    for (const n of FLUX_BASE_VARS) if (present(input, n)) { const why = productionFluxOriginProblem(n, input[n]); if (why) bad(`${n} ${why}`); }
    if (present(input, FLUX_SWITCH_VAR) && input[FLUX_SWITCH_VAR] !== "1") bad(`${FLUX_SWITCH_VAR} must be absent or exactly "1"`);
    if (input[FLUX_SWITCH_VAR] === "1") for (const n of FLUX_BASE_VARS) if (!present(input, n)) bad(`${n} must be set while Flux is on`);
  }

  // Signing key: the public half is checked against the pin at run time (src/env-isolation.ts); a wrangler.jsonc holds no secrets.
  if (staticCheck) unverified.push("CLOUD_B3_SIGNING_JWK");

  return { env, problems, warnings, unverified: [...new Set(unverified)] };
}

/** Whether a signing key's declared public half equals the pin of this environment (no cryptography; the Worker also signs a challenge). */
export function jwkMatchesPin(jwk, env) {
  const pin = SIGNING_PINS[env];
  return Boolean(pin && jwk && jwk.kty === pin.kty && jwk.crv === pin.crv && jwk.x === pin.x && jwk.y === pin.y);
}

/** The Cloudflare "may this token list Workers in an account" answer, per the preflight rule: pass only on 403 with code 10000. */
export function isDenialEnvelope(status, body) {
  if (status !== 403 || !body || typeof body !== "object" || body.success !== false || !Array.isArray(body.errors)) return false;
  return body.errors.some((e) => e && typeof e === "object" && e.code === 10000);
}
