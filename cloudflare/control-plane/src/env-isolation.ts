// SPDX-License-Identifier: AGPL-3.0-or-later
// Environment isolation at run time (G3 step 1). The policy itself lives in env-policy.mjs so the deploy scripts run the very same rules.
// `assertEnvIsolation` is synchronous and runs inside readConfig; `assertEnvIsolationAsync` adds the signing-key check and is awaited at
// every entry point (fetch and scheduled) before any work starts. All failures are 503 `env_mixed` and carry no values.
import { HTTPError } from "./http";
import {
  APPROVED_HETZNER_IMAGE_IDS, FLUX_BASE_VARS, FLUX_SWITCH_VAR, LIVE_FORBIDDEN, STAGING_FORBIDDEN, SIGNING_PINS, envPolicy, environmentOf,
  hetznerImageIds, type Environment,
} from "./env-policy.mjs";

export const ENV_MIXED_CODE = "env_mixed";

const WATCHED = [
  ...new Set([
    ...LIVE_FORBIDDEN, ...STAGING_FORBIDDEN, "MURAGE_ENV", "CLOUDFLARE_ZONE_ID", "CLOUD_HOME_ZONE_ID", "CLOUDFLARE_ACCOUNT_ID", "CLOUD_HOME_ACCOUNT_ID",
    "COMPANION_HOST_SUFFIX", "CLOUD_HOME_HOST_SUFFIX", "AWS_KMS_KEY_ARN", "STRIPE_SECRET_KEY", "SENDLANE_WRITES", "SENDLANE_LIST_ID",
    "B5_PROVISIONER_CONFIG", FLUX_SWITCH_VAR, ...FLUX_BASE_VARS,
  ]),
];

function inputOf(env: Env): Record<string, unknown> {
  const raw = env as unknown as Record<string, unknown>;
  const input: Record<string, unknown> = {};
  for (const name of WATCHED) if (raw[name] !== undefined) input[name] = raw[name];
  return input;
}

/** The environment this Worker runs as, or null when MURAGE_ENV is missing or not exactly staging or live. */
export function runtimeEnvironment(env: Env): Environment | null {
  return environmentOf(inputOf(env));
}

/** Throws 503 env_mixed when the configuration is not consistent for MURAGE_ENV. Logs the names of the failed rules, never values. */
export function assertEnvIsolation(env: Env): Environment {
  const result = envPolicy(inputOf(env));
  if (result.problems.length > 0 || !result.env) {
    console.error(JSON.stringify({ message: "environment isolation refused", errorCode: ENV_MIXED_CODE, rules: result.problems.slice(0, 20) }));
    throw new HTTPError(503, ENV_MIXED_CODE);
  }
  return result.env;
}

const signingChecks = new Map<string, Promise<boolean>>();
let signingCheck: (jwkText: string, pin: Pin) => Promise<boolean> = (jwkText, pin) => signingKeyMatchesPin(jwkText, pin);
/** Test seam, reachable from code only and never from configuration: replaces the signing-key check (no argument restores it). The control-plane
 *  test rig signs with throwaway keys that cannot match the real pins. */
export function setSigningCheckForTests(check?: (jwkText: string, pin: Pin) => Promise<boolean>): void {
  signingCheck = check ?? ((jwkText, pin) => signingKeyMatchesPin(jwkText, pin));
  signingChecks.clear();
}

type Pin = { kty: string; crv: string; x: string; y: string };
/** True when the private signing key is the one behind this pin: its declared public half equals the pin and a signature it makes over a
 *  fresh challenge verifies under the pin. */
export async function signingKeyMatchesPin(jwkText: string, pin: Pin): Promise<boolean> {
  try {
    const jwk = JSON.parse(jwkText) as JsonWebKey | null;
    if (!jwk || typeof jwk.d !== "string" || jwk.kty !== pin.kty || jwk.crv !== pin.crv || jwk.x !== pin.x || jwk.y !== pin.y) return false;
    const algorithm = { name: "ECDSA", namedCurve: "P-256" } as const;
    const priv = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d }, algorithm, false, ["sign"]);
    const pub = await crypto.subtle.importKey("jwk", { kty: pin.kty, crv: pin.crv, x: pin.x, y: pin.y }, algorithm, false, ["verify"]);
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, challenge);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, signature, challenge);
  } catch {
    return false;
  }
}

/** assertEnvIsolation plus the signing-key check. The same key text in the same environment is checked once per isolate. */
export async function assertEnvIsolationAsync(env: Env): Promise<Environment> {
  const label = assertEnvIsolation(env);
  const jwk = (env as unknown as { CLOUD_B3_SIGNING_JWK?: unknown }).CLOUD_B3_SIGNING_JWK;
  if (jwk === undefined) return label;
  const key = `${label}:${String(jwk)}`;
  let check = signingChecks.get(key);
  if (!check) {
    check = signingCheck(String(jwk), SIGNING_PINS[label]);
    signingChecks.set(key, check);
  }
  if (!(await check)) {
    console.error(JSON.stringify({ message: "environment isolation refused", errorCode: ENV_MIXED_CODE, rules: [`${label}: the signing key is not this environment's pin`] }));
    throw new HTTPError(503, ENV_MIXED_CODE);
  }
  return label;
}

type ImageFetch = (input: string, init?: RequestInit) => Promise<Response>;
const IMAGE_CHECK_TIMEOUT_MS = 10_000;

/**
 * Before any provisioning mutation: every provider image the configuration names must be in this environment's approved set and must be an
 * available snapshot that this credential can read (GET 200, the same id back). Any other answer, a timeout or a bad body refuses, so a
 * provisioning attempt that cannot prove its images does not start. Throws Error(`image_check_<reason>`).
 */
export async function assertHetznerImagesApproved(
  env: Env, provisioner: unknown, token: string | undefined, fetcher: ImageFetch = fetch,
): Promise<void> {
  const label = runtimeEnvironment(env);
  if (!label) throw new Error("image_check_environment");
  const ids = hetznerImageIds(provisioner);
  if (ids === null) throw new Error("image_check_shape");
  if (ids.length === 0 && token === undefined) return;
  if (ids.length === 0) throw new Error("image_check_no_images");
  if (token === undefined || token === "") throw new Error("image_check_no_token");
  const approved = new Set<string>(APPROVED_HETZNER_IMAGE_IDS[label]);
  for (const id of ids) if (!approved.has(id)) throw new Error("image_check_not_approved");
  for (const id of ids) {
    let response: Response;
    try {
      response = await fetcher(`https://api.hetzner.cloud/v1/images/${encodeURIComponent(id)}`, {
        method: "GET", headers: { authorization: `Bearer ${token}` }, redirect: "manual", signal: AbortSignal.timeout(IMAGE_CHECK_TIMEOUT_MS),
      });
    } catch {
      throw new Error("image_check_unreachable");
    }
    if (response.status !== 200) throw new Error(`image_check_http_${response.status}`);
    let body: { image?: { id?: unknown; type?: unknown; status?: unknown } } | null;
    try { body = await response.json() as typeof body; } catch { throw new Error("image_check_body"); }
    const image = body?.image;
    if (!image || String(image.id) !== id || image.type !== "snapshot" || image.status !== "available") throw new Error("image_check_mismatch");
  }
}

