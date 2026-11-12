// SPDX-License-Identifier: AGPL-3.0-or-later
// G3 step 1: the environment policy (MURAGE_ENV), its run-time assertion at every entry point, the provider image check, and the same policy
// over the resolved wrangler.jsonc for both environments.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import wranglerText from "../wrangler.jsonc?raw";
import worker from "../src/index";
import { createLiveProvider } from "../src/b5-provisioner";
import { readConfig } from "../src/config";
import { HTTPError } from "../src/http";
import {
  assertEnvIsolation, assertEnvIsolationAsync, assertHetznerImagesApproved, setSigningCheckForTests, signingKeyMatchesPin,
} from "../src/env-isolation";
import {
  APPROVED_HETZNER_IMAGE_IDS, LIVE_KMS_ARN, MURAGE_AI_ZONE_ID, PRODUCTION_ACCOUNT, SIGNING_PINS, STAGING_ACCOUNT, STAGING_KMS_ARN,
  envPolicy, isDenialEnvelope,
} from "../src/env-policy.mjs";
import { checkDeploy, checkPolicy, environmentPolicy, NO_QUARANTINE_RELAY_IPV4, PRODUCTION_HOME_IMAGES, STAGING_ONLY_STRINGS, stripJsonc } from "../scripts/check-deploy.mjs";

const IMAGES = { hetzner: { x86: "452494027", arm: "452471210" }, vultr: {} };
const OTHER_ZONE = "0".repeat(32);

/** A configuration that is consistent for live / staging (before the legacy staging values move). */
const LIVE_OK: Record<string, unknown> = {
  MURAGE_ENV: "live", CLOUDFLARE_ACCOUNT_ID: PRODUCTION_ACCOUNT, CLOUDFLARE_ZONE_ID: MURAGE_AI_ZONE_ID, COMPANION_HOST_SUFFIX: "murage.ai",
  CLOUD_HOME_ACCOUNT_ID: PRODUCTION_ACCOUNT, CLOUD_HOME_ZONE_ID: MURAGE_AI_ZONE_ID, CLOUD_HOME_HOST_SUFFIX: "murage.ai",
  AWS_KMS_KEY_ARN: LIVE_KMS_ARN, STRIPE_SECRET_KEY: ["rk_live_", "examplee", "xampleex", "ample"].join(""), SENDLANE_LIST_ID: "37", // secret-scan: fixture
  B5_PROVISIONER_CONFIG: JSON.stringify({ images: { hetzner: {}, vultr: {} }, opsSshFrom: [] }),
};
const STAGING_OK: Record<string, unknown> = {
  MURAGE_ENV: "staging", CLOUDFLARE_ACCOUNT_ID: STAGING_ACCOUNT, CLOUDFLARE_ZONE_ID: OTHER_ZONE, COMPANION_HOST_SUFFIX: "staging.example",
  AWS_KMS_KEY_ARN: STAGING_KMS_ARN, STRIPE_SECRET_KEY: ["rk_test_", "examplee", "xampleex", "ample"].join(""), SENDLANE_WRITES: "off", SENDLANE_LIST_ID: "412",
  CLOUD_CP0_STAGING: "1", STAGING_MAIL_SINK: "1", MAIL_SINK: {}, VULTR_API_KEY: "vu-test",
  B5_PROVISIONER_CONFIG: JSON.stringify({ images: IMAGES, opsSshFrom: ["203.0.113.0/24"] }),
};
const problems = (input: Record<string, unknown>) => envPolicy(input).problems;
beforeAll(() => { setSigningCheckForTests(); }); // the real signing check for this file

describe("G3 environment policy: the consistent configurations pass", () => {
  it("live and staging baselines have no problems", () => {
    expect(problems(LIVE_OK)).toEqual([]);
    expect(problems(STAGING_OK)).toEqual([]);
  });
  it("staging may still carry the legacy live zone, account, suffix and list: warnings, never problems; live gets no such pass", () => {
    const legacy = { ...STAGING_OK, CLOUDFLARE_ACCOUNT_ID: PRODUCTION_ACCOUNT, CLOUD_HOME_ZONE_ID: MURAGE_AI_ZONE_ID, CLOUD_HOME_HOST_SUFFIX: "murage.ai", SENDLANE_LIST_ID: "37" };
    const r = envPolicy(legacy);
    expect(r.problems).toEqual([]);
    expect(r.warnings.length).toBe(4);
    expect(problems({ ...LIVE_OK, CLOUDFLARE_ACCOUNT_ID: STAGING_ACCOUNT })).not.toEqual([]);
  });
});

describe("G3 environment policy: MURAGE_ENV is exactly staging or live", () => {
  it("missing, empty, wrong case, padded, other words and non-strings are all refused, with nothing else consulted", () => {
    for (const value of [undefined, "", "Live", "LIVE", "Staging", " live", "live ", "prod", "production", "test", "dev", 1, true, null, {}]) {
      const input = { ...LIVE_OK, MURAGE_ENV: value };
      if (value === undefined) delete (input as Record<string, unknown>).MURAGE_ENV;
      expect(envPolicy(input).problems, String(value)).toEqual(["MURAGE_ENV must be exactly staging or live"]);
      expect(envPolicy(input).env).toBeNull();
    }
  });
});

describe("G3 environment policy: table test, each field taken from the other environment fails", () => {
  const liveCases: [string, Record<string, unknown>][] = [
    ["CLOUD_CP0_STAGING", { CLOUD_CP0_STAGING: "1" }],
    ["CLOUD_CP0_STAGING present but empty", { CLOUD_CP0_STAGING: "" }],
    ["CLOUD_CP0_STAGING set to 0", { CLOUD_CP0_STAGING: "0" }],
    ["CLOUD_KEK_V1", { CLOUD_KEK_V1: "x" }],
    ["MAIL_SINK binding", { MAIL_SINK: {} }],
    ["STAGING_MAIL_SINK", { STAGING_MAIL_SINK: "1" }],
    ["MAIL_SINK_ALLOWLIST", { MAIL_SINK_ALLOWLIST: "@example.test" }],
    ["VULTR_API_KEY", { VULTR_API_KEY: "x" }],
    ["opsSshFrom", { B5_PROVISIONER_CONFIG: JSON.stringify({ images: { hetzner: {}, vultr: {} }, opsSshFrom: ["203.0.113.0/24"] }) }],
    ["opsSshFrom not an array", { B5_PROVISIONER_CONFIG: JSON.stringify({ opsSshFrom: "x" }) }],
    ["Vultr images", { B5_PROVISIONER_CONFIG: JSON.stringify({ images: { hetzner: {}, vultr: { x86: "snap" } } }) }],
    ["a staging build host image id", { B5_PROVISIONER_CONFIG: JSON.stringify({ images: IMAGES }) }],
    ["unparseable provisioner config", { B5_PROVISIONER_CONFIG: "{" }],
    ["staging KMS key", { AWS_KMS_KEY_ARN: STAGING_KMS_ARN }],
    ["a KMS key that is neither", { AWS_KMS_KEY_ARN: "arn:aws:kms:eu-west-1:149471050106:key/b79b4dba" }],
    ["home zone", { CLOUDFLARE_ZONE_ID: OTHER_ZONE }],
    ["home zone (machine endpoints)", { CLOUD_HOME_ZONE_ID: OTHER_ZONE }],
    ["staging account for the edge settings", { CLOUDFLARE_ACCOUNT_ID: STAGING_ACCOUNT }],
    ["staging account for homes", { CLOUD_HOME_ACCOUNT_ID: STAGING_ACCOUNT }],
    ["other host suffix", { COMPANION_HOST_SUFFIX: "staging.example" }],
    ["other home host suffix", { CLOUD_HOME_HOST_SUFFIX: "staging.example" }],
    ["test-mode Stripe key (rk)", { STRIPE_SECRET_KEY: ["rk_test_", "examplee", "xampleex", "ample"].join("") }],
    ["test-mode Stripe key (sk)", { STRIPE_SECRET_KEY: ["sk_test_", "examplee", "xampleex", "ample"].join("") }],
  ];
  const stagingCases: [string, Record<string, unknown>][] = [
    ["STRIPE_ALLOW_LIVE", { STRIPE_ALLOW_LIVE: "1" }],
    ["STRIPE_ALLOW_LIVE present but empty", { STRIPE_ALLOW_LIVE: "" }],
    ["live KMS key", { AWS_KMS_KEY_ARN: LIVE_KMS_ARN }],
    ["a KMS key that is neither", { AWS_KMS_KEY_ARN: "arn:aws:kms:eu-west-1:149471050106:key/00000000-0000-0000-0000-000000000000" }],
    ["live-mode Stripe key (rk)", { STRIPE_SECRET_KEY: ["rk_live_", "examplee", "xampleex", "ample"].join("") }], // secret-scan: fixture
    ["live-mode Stripe key (sk)", { STRIPE_SECRET_KEY: ["sk_live_", "examplee", "xampleex", "ample"].join("") }], // secret-scan: fixture
    ["SENDLANE_WRITES on", { SENDLANE_WRITES: "on" }],
    ["SENDLANE_WRITES true", { SENDLANE_WRITES: "true" }],
    ["SENDLANE_WRITES empty", { SENDLANE_WRITES: "" }],
    ["a build host image id that is not approved", { B5_PROVISIONER_CONFIG: JSON.stringify({ images: { hetzner: { x86: "1" } } }) }],
    ["a build host image block of the wrong shape", { B5_PROVISIONER_CONFIG: JSON.stringify({ images: { hetzner: [] } }) }],
    ["unparseable provisioner config", { B5_PROVISIONER_CONFIG: "[1]" }],
  ];
  for (const [name, change] of liveCases) it(`live refuses ${name}`, () => { expect(problems({ ...LIVE_OK, ...change }).length, name).toBeGreaterThan(0); });
  for (const [name, change] of stagingCases) it(`staging refuses ${name}`, () => { expect(problems({ ...STAGING_OK, ...change }).length, name).toBeGreaterThan(0); });
  it("the live approved image set is the new prod pair in murage-live plus the previous pair a home still runs on; staging's is the new staging pair plus the previous pair a held home still runs on", () => {
    expect([...APPROVED_HETZNER_IMAGE_IDS.live].sort()).toEqual(["449759230", "449759735", "451877100", "451878214"]);
    expect([...APPROVED_HETZNER_IMAGE_IDS.staging].sort()).toEqual(["451260442", "451603575", "452016490", "452086092", "452471210", "452494027"]);
  });
  it("a Stripe key of no known shape is left to billing configuration, which rejects it", () => {
    for (const key of ["whsec_example", "", "garbage"]) {
      expect(problems({ ...LIVE_OK, STRIPE_SECRET_KEY: key }), key).toEqual([]);
      expect(problems({ ...STAGING_OK, STRIPE_SECRET_KEY: key }), key).toEqual([]);
    }
  });
  it("a complete swap of one environment's values into the other is refused both ways", () => {
    const swappedToLive = { ...STAGING_OK, MURAGE_ENV: "live" };
    const swappedToStaging = { ...LIVE_OK, MURAGE_ENV: "staging" };
    expect(problems(swappedToLive).length).toBeGreaterThan(0);
    expect(problems(swappedToStaging).length).toBeGreaterThan(0);
  });
});

describe("G3 assertion at run time: 503 env_mixed before any work", () => {
  const live = (extra: Record<string, unknown> = {}) => ({ ...env, MURAGE_ENV: "live", ...extra }) as unknown as Env;
  const ctx = () => ({ waitUntil: vi.fn(), passThroughOnException: vi.fn() }) as unknown as ExecutionContext;

  it("the test rig is labelled staging; the same values labelled live are consistent too", () => {
    expect(assertEnvIsolation(env as unknown as Env)).toBe("staging");
    expect(assertEnvIsolation(live())).toBe("live");
    expect(readConfig(live()).cloudflare.accountId).toBe(PRODUCTION_ACCOUNT);
  });
  it("readConfig throws HTTPError 503 env_mixed for a mixed or unlabelled configuration, before any other check", () => {
    for (const extra of [{ MURAGE_ENV: undefined }, { MURAGE_ENV: "prod" }, { CLOUD_CP0_STAGING: "1" }, { STRIPE_SECRET_KEY: ["sk_test_", "examplee", "xampleex", "ample"].join("") }]) {
      let caught: unknown;
      try { readConfig(live({ ...extra, BETTER_AUTH_SECRET: "short" })); } catch (e) { caught = e; }
      expect(caught, JSON.stringify(extra)).toBeInstanceOf(HTTPError);
      expect((caught as HTTPError).status).toBe(503);
      expect((caught as HTTPError).code).toBe("env_mixed");
    }
  });
  it("a request to a mixed Worker answers 503 env_mixed on every path and touches nothing", async () => {
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM sqlite_master").first<{ n: number }>();
    for (const path of ["/healthz", "/v1/billing/webhook", "/v1/public/token/preview", "/v1/billing/reserve", "/anything"]) {
      for (const method of ["GET", "POST"]) {
        const response = await worker.fetch(new Request(`https://accounts.murage.ai${path}`, { method, body: method === "POST" ? "{}" : undefined, headers: { "content-type": "application/json" } }),
          live({ CLOUD_CP0_STAGING: "1" }), ctx());
        expect(response.status, `${method} ${path}`).toBe(503);
        expect(((await response.json()) as { error: string }).error).toBe("env_mixed");
      }
    }
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sqlite_master").first()).toEqual(before);
  });
  it("healthz answers ok for a consistent environment", async () => {
    const response = await worker.fetch(new Request("https://accounts.murage.ai/healthz"), live(), ctx());
    expect(response.status).toBe(200);
  });
  it("a scheduled run on a mixed Worker throws before registering any work", () => {
    const c = ctx();
    expect(() => worker.scheduled!({ scheduledTime: 1, cron: "*/5 * * * *", noRetry() {} } as ScheduledController, live({ MURAGE_ENV: undefined }), c)).toThrow();
    expect(c.waitUntil).not.toHaveBeenCalled();
  });
  it("a scheduled run whose signing key is not this environment's pin fails inside the registered work, before any sweep", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const jwk = JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
    const c = ctx();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    worker.scheduled!({ scheduledTime: 1, cron: "*/5 * * * *", noRetry() {} } as ScheduledController, live({ CLOUD_B3_SIGNING_JWK: jwk }), c);
    expect(c.waitUntil).toHaveBeenCalledTimes(1);
    await expect((c.waitUntil as ReturnType<typeof vi.fn>).mock.calls[0][0]).rejects.toMatchObject({ code: "env_mixed" });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
  it("assertEnvIsolationAsync refuses a signing key that is not the pin of the environment (both ways) and a malformed one", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const jwk = JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
    for (const [label, key] of [["live", jwk], ["staging", jwk], ["live", "{"], ["live", "null"], ["live", ""]] as const) {
      await expect(assertEnvIsolationAsync(live({ MURAGE_ENV: label, CLOUD_B3_SIGNING_JWK: key })), `${label}/${key.slice(0, 3)}`).rejects.toMatchObject({ status: 503, code: "env_mixed" });
    }
    await expect(assertEnvIsolationAsync(live())).resolves.toBe("live");
  });
});

describe("G3 signing key check: the private key must be the one behind the pin", () => {
  it("a key whose public half is the pin passes; the same public half with another private scalar, another key, a public-only key and junk fail", async () => {
    const make = async () => crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const a = await make(); const b = await make();
    const privA = await crypto.subtle.exportKey("jwk", a.privateKey) as JsonWebKey;
    const privB = await crypto.subtle.exportKey("jwk", b.privateKey) as JsonWebKey;
    const pinA = { kty: "EC", crv: "P-256", x: privA.x!, y: privA.y! };
    expect(await signingKeyMatchesPin(JSON.stringify(privA), pinA)).toBe(true);
    expect(await signingKeyMatchesPin(JSON.stringify({ ...privA, d: privB.d }), pinA)).toBe(false);
    expect(await signingKeyMatchesPin(JSON.stringify(privB), pinA)).toBe(false);
    expect(await signingKeyMatchesPin(JSON.stringify({ ...privA, d: undefined }), pinA)).toBe(false);
    expect(await signingKeyMatchesPin("not json", pinA)).toBe(false);
  });
  it("the two pins differ and are P-256 public keys", () => {
    expect(SIGNING_PINS.staging).not.toEqual(SIGNING_PINS.live);
    for (const pin of Object.values(SIGNING_PINS)) { expect(pin.kty).toBe("EC"); expect(pin.crv).toBe("P-256"); }
  });
});

describe("G3 build host image check: only a 200 for an approved available snapshot passes", () => {
  const stagingEnv = (extra: Record<string, unknown> = {}) => ({ ...env, MURAGE_ENV: "staging", ...extra }) as unknown as Env;
  const config = { images: IMAGES };
  const image = (id: string, extra: Record<string, unknown> = {}) => ({ image: { id: Number(id), type: "snapshot", status: "available", ...extra } });
  const answering = (answer: (id: string) => Response | Error) => {
    const calls: string[] = [];
    const fetcher = async (url: string) => { calls.push(url); const r = answer(url.split("/").pop()!); if (r instanceof Error) throw r; return r; };
    return { fetcher, calls };
  };
  const ok = (id: string) => new Response(JSON.stringify(image(id)), { status: 200 });

  it("passes when every image is an available snapshot the token can read", async () => {
    const f = answering(ok);
    await expect(assertHetznerImagesApproved(stagingEnv(), config, "token", f.fetcher)).resolves.toBeUndefined();
    expect([...f.calls].sort()).toEqual(["https://api.hetzner.cloud/v1/images/452471210", "https://api.hetzner.cloud/v1/images/452494027"]);
  });
  it("404, 401, 403, 429, 500, 302 and every other status refuse", async () => {
    for (const status of [404, 401, 403, 429, 500, 502, 302, 204, 201]) {
      await expect(assertHetznerImagesApproved(stagingEnv(), config, "token", answering(() => new Response("{}", { status })).fetcher), String(status)).rejects.toThrow(/image_check/);
    }
  });
  it("a thrown fetch, an unparseable body, a different id back, a system image, or an image that is not available refuse", async () => {
    await expect(assertHetznerImagesApproved(stagingEnv(), config, "token", answering(() => new Error("down")).fetcher)).rejects.toThrow("image_check_unreachable");
    await expect(assertHetznerImagesApproved(stagingEnv(), config, "token", answering(() => new Response("nope", { status: 200 })).fetcher)).rejects.toThrow("image_check_body");
    await expect(assertHetznerImagesApproved(stagingEnv(), config, "token", answering(() => new Response(JSON.stringify(image("1")), { status: 200 })).fetcher)).rejects.toThrow("image_check_mismatch");
    await expect(assertHetznerImagesApproved(stagingEnv(), config, "token", answering((id) => new Response(JSON.stringify(image(id, { type: "system" })), { status: 200 })).fetcher)).rejects.toThrow("image_check_mismatch");
    await expect(assertHetznerImagesApproved(stagingEnv(), config, "token", answering((id) => new Response(JSON.stringify(image(id, { status: "creating" })), { status: 200 })).fetcher)).rejects.toThrow("image_check_mismatch");
    await expect(assertHetznerImagesApproved(stagingEnv(), config, "token", answering(() => new Response("{}", { status: 200 })).fetcher)).rejects.toThrow("image_check_mismatch");
  });
  it("one bad image among good ones refuses", async () => {
    await expect(assertHetznerImagesApproved(stagingEnv(), config, "token", answering((id) => (id === "452471210" ? new Response("{}", { status: 404 }) : ok(id))).fetcher)).rejects.toThrow("image_check_http_404");
  });
  it("an id outside the environment's approved set is refused without any request; live approves none", async () => {
    const f = answering(ok);
    await expect(assertHetznerImagesApproved(stagingEnv(), { images: { hetzner: { x86: "999" } } }, "token", f.fetcher)).rejects.toThrow("image_check_not_approved");
    await expect(assertHetznerImagesApproved(stagingEnv({ MURAGE_ENV: "live" }), config, "token", f.fetcher)).rejects.toThrow("image_check_not_approved");
    expect(f.calls).toEqual([]);
  });
  it("a missing or unknown environment, a missing token, an empty image set with a token, or a malformed block refuse; no images and no token is nothing to check", async () => {
    const f = answering(ok);
    await expect(assertHetznerImagesApproved(stagingEnv({ MURAGE_ENV: undefined }), config, "token", f.fetcher)).rejects.toThrow("image_check_environment");
    await expect(assertHetznerImagesApproved(stagingEnv(), config, undefined, f.fetcher)).rejects.toThrow("image_check_no_token");
    await expect(assertHetznerImagesApproved(stagingEnv(), config, "", f.fetcher)).rejects.toThrow("image_check_no_token");
    await expect(assertHetznerImagesApproved(stagingEnv(), { images: { hetzner: {} } }, "token", f.fetcher)).rejects.toThrow("image_check_no_images");
    await expect(assertHetznerImagesApproved(stagingEnv(), { images: { hetzner: [] } }, "token", f.fetcher)).rejects.toThrow("image_check_shape");
    await expect(assertHetznerImagesApproved(stagingEnv(), { images: { hetzner: {} } }, undefined, f.fetcher)).resolves.toBeUndefined();
    expect(f.calls).toEqual([]);
  });
  it("the provider checks before its first mutation: a refused image means no create request is ever sent", async () => {
    const calls: { method: string; url: string }[] = [];
    const fetcher = async (url: string, init?: RequestInit) => { calls.push({ method: init?.method ?? "GET", url }); return new Response("{}", { status: 404 }); };
    const provider = createLiveProvider(stagingEnv({ B5_PROVISIONER_CONFIG: JSON.stringify({ images: IMAGES, quarantineFirewallId: 77, vultr: { sshKeyIds: ["vk-1"], firewallGroupId: "fwg-home", quarantineFirewallGroupId: "fwg-quar" } }), HCLOUD_TOKEN: "token" }), { fetch: fetcher });
    await expect(provider.create_volume({ homeId: "home-1", resourceGeneration: 1, idempotencyKey: ["k-volume", "-gate-00", "1"].join(""), provider: "hetzner" } as never)).rejects.toThrow(/image_check/);
    expect(calls.every((c) => c.method === "GET" && c.url.includes("/v1/images/"))).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe("G3 check-deploy runs the same policy over the resolved wrangler.jsonc, for both environments", () => {
  const config = () => JSON.parse(stripJsonc(wranglerText));
  const block = (name: "staging" | "production", mutate: (b: Record<string, any>) => void = () => undefined) => { const b = config().env[name]; mutate(b); return b; };
  const policy = (name: "staging" | "production", mutate?: (b: Record<string, any>) => void, homeImages?: { x86: string; arm: string; digest: string } | null) =>
    environmentPolicy(block(name, mutate), name, homeImages === undefined ? {} : { homeImages });
  const PINNED = { x86: "555000001", arm: "555000002", digest: `sha256:${"a".repeat(64)}` };

  it("the checked-in staging block passes the policy and the whole staging check: both snapshots carry KMS-signed entries (KMS 5.2, Astra G3-KMS H7)", () => {
    // sign-image.sh signed the staging images 452494027 (x86) and 452471210 (arm) on 2026-11-05; the earlier pairs keep only the id a running home uses
    // (452086092, 452016490, 451603575, 451260442); the entries expire after the signature max age.
    const whole = checkDeploy(wranglerText, "staging");
    expect(whole, whole.join("\n")).toEqual([]);
    const r = checkPolicy(wranglerText, "staging");
    expect(r.problems).toEqual([]);
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.unverified).toEqual(["STRIPE_SECRET_KEY", "CLOUD_B3_SIGNING_JWK"]);
  });
  it("production quarantine is full isolation: the no-relay sentinel plus a quarantine firewall, never a staging marker", () => {
    const vars = config().env.production.vars;
    const relay = JSON.parse(vars.CLOUD_B3_CONFIG).quarantineRelayIP;
    expect(relay).toBe(NO_QUARANTINE_RELAY_IPV4);
    expect(STAGING_ONLY_STRINGS.some((marker: string) => relay.includes(marker))).toBe(false);
    const b5 = JSON.parse(vars.B5_PROVISIONER_CONFIG);
    expect(b5.quarantineFirewallId).toBeGreaterThan(0);
    expect(b5.firewallIds).not.toContain(b5.quarantineFirewallId);
  });
  it("the labels are live in env.production, staging in env.staging, and live at the top level the tests run on", () => {
    expect(config().env.production.vars.MURAGE_ENV).toBe("live");
    expect(config().env.staging.vars.MURAGE_ENV).toBe("staging");
    expect(config().vars.MURAGE_ENV).toBe("live");
  });
  it("a wrong, missing or swapped MURAGE_ENV refuses in each environment", () => {
    for (const value of ["staging", "Live", "", undefined]) {
      expect(policy("production", (b) => { if (value === undefined) delete b.vars.MURAGE_ENV; else b.vars.MURAGE_ENV = value; }, PINNED).problems.length, String(value)).toBeGreaterThan(0);
    }
    for (const value of ["live", "Staging", "", undefined]) {
      expect(policy("staging", (b) => { if (value === undefined) delete b.vars.MURAGE_ENV; else b.vars.MURAGE_ENV = value; }).problems.length, String(value)).toBeGreaterThan(0);
    }
    expect(checkDeploy(wranglerText.replace('"MURAGE_ENV": "staging"', '"MURAGE_ENV": "live"'), "staging").join()).toContain("MURAGE_ENV");
  });
  it("values from the other environment in a block refuse", () => {
    const refuses = (name: "staging" | "production", mutate: (b: Record<string, any>) => void) => expect(policy(name, mutate, PINNED).problems.length).toBeGreaterThan(0);
    refuses("production", (b) => { b.vars.CLOUD_CP0_STAGING = "1"; });
    refuses("production", (b) => { b.vars.AWS_KMS_KEY_ARN = STAGING_KMS_ARN; });
    refuses("production", (b) => { b.vars.CLOUDFLARE_ZONE_ID = OTHER_ZONE; });
    refuses("production", (b) => { b.vars.B5_PROVISIONER_CONFIG = JSON.stringify({ images: IMAGES }); });
    refuses("production", (b) => { b.vars.B5_PROVISIONER_CONFIG = JSON.stringify({ images: { hetzner: {}, vultr: {} }, opsSshFrom: ["203.0.113.0/24"] }); });
    refuses("staging", (b) => { b.vars.AWS_KMS_KEY_ARN = LIVE_KMS_ARN; });
    refuses("staging", (b) => { b.vars.STRIPE_ALLOW_LIVE = "1"; });
    refuses("staging", (b) => { b.vars.SENDLANE_WRITES = "on"; });
    refuses("staging", (b) => { b.vars.SENDLANE_WRITES = ""; });
    refuses("staging", (b) => { b.vars.B5_PROVISIONER_CONFIG = JSON.stringify({ images: { hetzner: { x86: "1" }, vultr: {} } }); });
  });
  it("production approves only the pinned production images", () => {
    const withImages = (x86: string, arm: string) => (b: Record<string, any>) => { b.vars.B5_PROVISIONER_CONFIG = JSON.stringify({ images: { hetzner: { x86, arm }, vultr: {} } }); };
    expect(policy("production", withImages("555000001", "555000002"), PINNED).problems.filter((p) => p.includes("build host image"))).toEqual([]);
    expect(policy("production", withImages("555000001", "555000009"), PINNED).problems.join()).toContain("build host image");
    expect(policy("production", withImages("555000001", "555000002"), null).problems.join()).toContain("build host image");
  });
  it("production approves the INTERSECTION of the pinned images and the run-time live set; empty fails closed", () => {
    const withImages = (x86: string, arm: string) => (b: Record<string, any>) => { b.vars.B5_PROVISIONER_CONFIG = JSON.stringify({ images: { hetzner: { x86, arm }, vultr: {} } }); };
    const run = (home: typeof PINNED | null, runtime: string[], x86: string, arm: string) =>
      environmentPolicy(block("production", withImages(x86, arm)), "production", { homeImages: home, runtimeApprovedLive: runtime });
    expect(run(PINNED, ["555000001", "555000002"], "555000001", "555000002").problems.filter((p) => p.includes("image"))).toEqual([]);
    expect(run(PINNED, ["555000001"], "555000001", "555000002").problems.join()).toContain("build host image");
    expect(run(PINNED, ["555000001", "555000002", "555000003"], "555000003", "555000001").problems.join()).toContain("build host image");
    expect(run(PINNED, [], "555000001", "555000002").problems.join()).toContain("no build host image is both pinned");
    expect(run(null, ["555000001", "555000002"], "555000001", "555000002").problems.join()).toContain("no build host image is both pinned");
    expect(run(PINNED, ["555000009"], "555000001", "555000002").problems.join()).toContain("no build host image is both pinned");
    // the checked-in block with the real pins and the real live set passes; an empty run-time set still fails closed
    expect(environmentPolicy(block("production"), "production", {}).problems.filter((p) => p.includes("build host image"))).toEqual([]);
    expect(environmentPolicy(block("production"), "production", { runtimeApprovedLive: [] }).problems.join()).toContain("no build host image is both pinned");
  });
  it("the run-time approved set for live holds the pinned production images plus the previous prod pair kept for rebuilds (empty while they are not pinned)", () => {
    expect(PRODUCTION_HOME_IMAGES).not.toBeNull();
    expect([...APPROVED_HETZNER_IMAGE_IDS.live].sort()).toEqual([PRODUCTION_HOME_IMAGES!.x86, PRODUCTION_HOME_IMAGES!.arm, "449759230", "449759735"].sort());
  });
});

describe("G3 preflight predicate", () => {
  it("only 403 with success:false and an error code 10000 counts as a denial", () => {
    const denied = { success: false, errors: [{ code: 10000, message: "x" }] };
    expect(isDenialEnvelope(403, denied)).toBe(true);
    for (const [status, body] of [[200, denied], [401, denied], [404, denied], [500, denied], [403, null], [403, {}], [403, "10000"], [403, { success: true, errors: [{ code: 10000 }] }],
      [403, { success: false, errors: [] }], [403, { success: false, errors: [{ code: "10000" }] }], [403, { success: false, errors: [{ code: 9109 }] }], [403, { success: false, errors: "x" }]] as const) {
      expect(isDenialEnvelope(status, body), `${status} ${JSON.stringify(body)}`).toBe(false);
    }
  });
});
