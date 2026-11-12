// SPDX-License-Identifier: AGPL-3.0-or-later
// The signed terms proof (src/home-terms.ts, src/home-terms-map.ts; browser-owner/DESIGN.md section 11) and the checkout sentence that carries
// the age. The proof is built from the acceptance the customer gave at checkout, never from anything the home says.
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { verifyPayload } from "../src/b3-signatures";
import { directSubmitMessage, langOf, renderDisclosure, stringsFor, submitText } from "../src/checkout-strings";
import { FLUX_TERMS_URL, FLUX_TERMS_VERSION, submitLinksFor } from "../src/b5-config";
import { HOME_TERMS_MAP, HOME_TERMS_VERSION, coversHome, knownHomeAcceptance, type HomeTermsRow } from "../src/home-terms-map";
import { ageShown, mintTermsProof, NOTICE_GRACE_FALLBACK_MS, type TermsProofClaims } from "../src/home-terms";
import { AGE_REACCEPT_WORDINGS, AGE_SCREENS, SCREEN_VERSION, WORDING, currentVersions, prepareConsent, recordAcceptanceAtCompletion } from "../src/legal-flows";
import { HTTPError } from "../src/http";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { createWorker } from "../src/index";
import { authFetch, cloudMember, jwksFetch, supabaseEnv } from "./cloud-member";
import { consentFor } from "./legal-helpers";

const HOME = "home-terms";
const H1 = "2026-10-10";
const OLD_SCREEN = "checkout-clickwrap-2026-10-11.6";
const NOW = Date.UTC(2026, 9, 31, 12, 0, 0);
const DAY = 86_400_000;
const cur = () => currentVersions();

let signingJwk: JsonWebKey;
let publicJwk: JsonWebKey;
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  signingJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
});
const e = () => ({ ...env, CLOUD_B3_SIGNING_JWK: JSON.stringify(signingJwk) }) as unknown as Env;

/** Fills every NOT NULL column of `table` with a neutral value, then the given ones (a seed for rows whose other columns no case reads). */
async function seed(table: string, values: Record<string, unknown>) {
  const cols = (await env.DB.prepare(`SELECT name,type,"notnull" AS nn,dflt_value FROM pragma_table_info('${table}')`).all<{ name: string; type: string; nn: number; dflt_value: string | null }>()).results;
  const row: Record<string, unknown> = {};
  for (const c of cols) if (c.nn === 1 && c.dflt_value === null) row[c.name] = c.type.toUpperCase().startsWith("INT") ? 0 : "x";
  Object.assign(row, values);
  const k = Object.keys(row);
  await env.DB.prepare(`INSERT INTO ${table} (${k.join(",")}) VALUES (${k.map(() => "?").join(",")})`).bind(...k.map((x) => row[x])).run();
}
let n = 0;
/** A checkout acceptance as the verified completion writes it: the consent (completed unless said otherwise) and its terms_acceptances row. */
async function checkoutAcceptance(userId: string, over: { screen?: string; completed?: boolean; tos?: string; privacy?: string; cloud?: string; at?: number } = {}) {
  const id = `consent-t-${++n}`;
  const tos = over.tos ?? cur().termsOfService;
  const privacy = over.privacy ?? cur().privacyPolicy;
  await seed("checkout_consents", { id, home_id: HOME, user_id: userId, screen_version: over.screen ?? SCREEN_VERSION, cloud_terms_version: over.cloud ?? cur().cloudTerms,
    tos_version: tos, privacy_version: privacy, completed_at: over.completed === false ? null : (over.at ?? NOW - DAY), created_at: NOW - 2 * DAY });
  await seed("terms_acceptances", { id: `accept-t-${n}`, user_id: userId, cloud_terms_version: over.cloud ?? cur().cloudTerms, tos_version: tos, privacy_version: privacy,
    source: "checkout", consent_id: id, wording: "x", accepted_at: over.at ?? NOW - DAY });
  return { consentId: id, acceptanceId: `accept-t-${n}` };
}
async function reaccept(userId: string, wording: string, at = NOW - DAY, over: { tos?: string; privacy?: string } = {}) {
  await seed("terms_acceptances", { id: `accept-r-${++n}`, user_id: userId, cloud_terms_version: cur().cloudTerms, tos_version: over.tos ?? cur().termsOfService,
    privacy_version: over.privacy ?? cur().privacyPolicy, source: "reaccept", consent_id: null, wording, accepted_at: at });
  return `accept-r-${n}`;
}
let owner: { userId: string };
let stranger: { userId: string };
beforeEach(async () => {
  owner = await cloudMember("terms-owner@example.test");
  stranger = await cloudMember("terms-stranger@example.test");
});
const mint = (version = H1, ownerId = owner.userId, now = NOW) => mintTermsProof(e(), { homeId: HOME, generation: 3, ownerId, homeTermsVersion: version, now });
const claimsOf = async (a: Awaited<ReturnType<typeof mint>>) => {
  expect(a.status).toBe("proof");
  return await verifyPayload((a as Extract<typeof a, { status: "proof" }>).proof, publicJwk) as TermsProofClaims;
};
/** Replaces the map for one case and puts it back. */
async function withMap(rows: HomeTermsRow[], run: () => Promise<void>) {
  const map = HOME_TERMS_MAP as HomeTermsRow[];
  const saved = map.splice(0, map.length, ...rows);
  try { await run(); } finally { map.splice(0, map.length, ...saved); }
}
afterEach(() => { /* each case seeds its own users and rows */ });

describe("the map", () => {
  it("names a row for the documents in force: a legal change cannot ship without somebody saying which home version it answers", () => {
    expect(HOME_TERMS_MAP.some((r) => r.tos === cur().termsOfService && r.privacy === cur().privacyPolicy), "currentVersions() has no HOME_TERMS_MAP row: add one for the home version it answers").toBe(true);
  });
  it("holds the home version the desktop app ships today, and that version has the shape a home sends", () => {
    expect(HOME_TERMS_MAP.map((r) => r.home)).toContain(H1);
    for (const r of HOME_TERMS_MAP) expect(r.home).toMatch(HOME_TERMS_VERSION);
    // shared/terms.ts (the home's TERMS_VERSION) is on the home line; when it is present it must be a version the map names.
    // @ts-expect-error import.meta.glob is Vite's (vitest transforms it); the worker tsconfig does not load vite/client types.
    const found = import.meta.glob("../../../shared/terms.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    for (const text of Object.values(found)) {
      const v = /TERMS_VERSION\s*=\s*"(\d{4}-\d{2}-\d{2})"/.exec(text)?.[1];
      expect(HOME_TERMS_MAP.map((r) => r.home)).toContain(v);
    }
  });
  it("an acceptance covers home version H only by exactly the ids a row names; the Cloud terms are not part of the match", () => {
    const row = HOME_TERMS_MAP.find((r) => r.home === H1)!;
    expect(coversHome(H1, row.tos, row.privacy)).toBe(true);
    expect(coversHome(H1, row.tos, "privacy-policy-other")).toBe(false);
    expect(coversHome(H1, "terms-of-service-other", row.privacy)).toBe(false);
    expect(coversHome("2027-01-01", row.tos, row.privacy)).toBe(false);
    expect(knownHomeAcceptance(row.tos, row.privacy)).toBe(true);
    expect(knownHomeAcceptance("a", "b")).toBe(false);
  });
});

describe("the age", () => {
  it("is shown by a checkout screen in AGE_SCREENS and by the current re-accept words, and by nothing else", () => {
    expect(AGE_SCREENS).toContain(SCREEN_VERSION);
    expect(AGE_SCREENS).not.toContain(OLD_SCREEN);
    expect(ageShown({ source: "checkout", wording: "x", screen_version: SCREEN_VERSION })).toBe(true);
    expect(ageShown({ source: "checkout", wording: "x", screen_version: OLD_SCREEN })).toBe(false);
    expect(ageShown({ source: "checkout", wording: "x", screen_version: null })).toBe(false);
    expect(ageShown({ source: "reaccept", wording: WORDING.reaccept, screen_version: null })).toBe(true);
    expect(ageShown({ source: "reaccept", wording: "I have read and agree to the updated Murage Cloud terms, the Terms of Service and the Privacy Policy", screen_version: null })).toBe(false);
    expect(ageShown({ source: "notice-period", wording: WORDING.reaccept, screen_version: SCREEN_VERSION })).toBe(false);
    expect(AGE_REACCEPT_WORDINGS).toEqual(["I confirm I am 18 or older, and I have read and agree to the updated Murage Cloud terms, the Terms of Service and the Privacy Policy", WORDING.reaccept]);
    expect(WORDING.reaccept).toContain("18 or older");
  });
  it("the checkout sentence carries the age, in English and in German, byte for byte", () => {
    const en = renderDisclosure("pro", "US", "en", "ferrox");
    expect(en.lines.acceptance).toBe("You confirm you are 18 or older, and you accept the [Murage Cloud terms], [Terms of Service] and [Flux Router Terms of Service] when you submit your order on the payment page. [Privacy Policy].");
    const de = renderDisclosure("pro", "DE", "de", "ferrox");
    expect(de.lines.acceptance).toBe("Sie bestätigen, dass Sie mindestens 18 Jahre alt sind, und akzeptieren mit dem Absenden Ihrer Bestellung auf der Zahlungsseite die [Murage-Cloud-Bedingungen], die [Nutzungsbedingungen] und die [Nutzungsbedingungen von Flux Router]. [Datenschutzerklärung].");
    expect(en.renewalText.split("\n").at(-1)).toBe(en.lines.acceptance);
    // The Stripe page's own words say the same (the direct path's submit message).
    expect(submitText("en", "full")).toContain("you confirm you are 18 or older");
    expect(submitText("en", "short")).toContain("18 or older");
    expect(submitText("de", "full")).toContain("mindestens 18 Jahre alt");
    expect(submitText("de", "short")).toContain("mindestens 18 Jahre alt");
    expect(langOf("de")).toBe("de");
  });
  it("a consent made on the screen from before the change is stale (409 disclosure_stale); one that echoes the old sentence is stale too", () => {
    const body = consentFor("pro", NOW);
    const ctx = { seller: "ferrox" as const, policyVersion: "p1" };
    const meta = { claimed: { ip: "198.51.100.7" }, observed: { ip: "203.0.113.1" } } as never;
    expect(() => prepareConsent(body, "pro", NOW, meta, ctx)).not.toThrow();
    const stale = (b: typeof body) => { try { prepareConsent(b, "pro", NOW, meta, ctx); return null; } catch (x) { return x instanceof HTTPError ? [x.status, x.code] : x; } };
    expect(stale({ ...body, screenVersion: OLD_SCREEN })).toEqual([409, "disclosure_stale"]);
    const old = "You accept the [Murage Cloud terms] and [Terms of Service] when you submit your order on the payment page. [Privacy Policy].";
    expect(stale({ ...body, renewalText: body.renewalText.replace(/[^\n]*$/, old) })).toEqual([409, "disclosure_stale"]);
  });
  it("the consent keeps the words shown, age included, in its frozen lines (the age is proven by the words, not by a column)", () => {
    const body = consentFor("pro", NOW);
    const prepared = prepareConsent(body, "pro", NOW, { claimed: { ip: "198.51.100.7" }, observed: { ip: "203.0.113.1" } } as never, { seller: "ferrox", policyVersion: "p1" });
    expect(prepared.wording.acceptance).toContain("You confirm you are 18 or older");
    expect(JSON.parse(prepared.disclosure).lines.acceptance).toContain("18 or older");
    expect(prepared.screenVersion).toBe(SCREEN_VERSION);
  });
});

describe("mint: the proof from the checkout acceptance", () => {
  it("an acceptance on an age screen, completed, for the home's owner, covering the version: a proof with exactly these claims, the row's own ids, no expiry", async () => {
    const { consentId, acceptanceId } = await checkoutAcceptance(owner.userId);
    const a = await mint();
    const c = await claimsOf(a);
    expect(Object.keys(c)).toEqual(["type", "homeId", "generation", "account", "homeTermsVersion", "documents", "ageConfirmed", "acceptedAt", "source", "acceptanceId", "consentId",
      "screenVersion", "graceUntil", "issuedAt"]);
    expect(c).toMatchObject({ type: "murage-terms-v1", homeId: HOME, generation: 3, account: owner.userId, homeTermsVersion: H1, ageConfirmed: true, acceptedAt: NOW - DAY,
      source: "checkout", acceptanceId, consentId, screenVersion: SCREEN_VERSION, graceUntil: null, issuedAt: NOW });
    expect(c.documents).toEqual({ cloudTerms: cur().cloudTerms, termsOfService: cur().termsOfService, privacyPolicy: cur().privacyPolicy });
    expect(Object.keys(c)).not.toContain("expiresAt");
  });
  it("acceptedAt is the checkout's completion, never the time of the pull", async () => {
    await checkoutAcceptance(owner.userId, { at: NOW - 3 * DAY });
    expect((await claimsOf(await mint())).acceptedAt).toBe(NOW - 3 * DAY);
    expect((await claimsOf(await mint(H1, owner.userId, NOW + 40 * DAY))).acceptedAt).toBe(NOW - 3 * DAY);
  });
  it("a home version no row names is none, even with an acceptance on file", async () => {
    await checkoutAcceptance(owner.userId);
    expect(await mint("2027-03-04")).toEqual({ status: "none" });
  });
  it("wrong owner: the home's owner has no acceptance, somebody else does: none", async () => {
    await checkoutAcceptance(stranger.userId);
    expect(await mint()).toEqual({ status: "none" });
  });
  it("no age screen: an acceptance from the screen before the age words proves no age: none", async () => {
    await checkoutAcceptance(owner.userId, { screen: OLD_SCREEN });
    expect(await mint()).toEqual({ status: "none" });
  });
  it("an order that never completed is not an acceptance: none", async () => {
    await checkoutAcceptance(owner.userId, { completed: false });
    expect(await mint()).toEqual({ status: "none" });
  });
  it("no acceptance row at all: none", async () => {
    expect(await mint()).toEqual({ status: "none" });
  });
  it("an acceptance stamped after the pull is not evidence yet: none", async () => {
    await checkoutAcceptance(owner.userId, { at: NOW + DAY });
    expect(await mint()).toEqual({ status: "none" });
  });
  it("a site re-acceptance with the age words counts (source reaccept, no consent); one from before the age words does not", async () => {
    const id = await reaccept(owner.userId, WORDING.reaccept);
    const c = await claimsOf(await mint());
    expect(c).toMatchObject({ source: "reaccept", acceptanceId: id, consentId: null, screenVersion: null, ageConfirmed: true });
    await env.DB.prepare("DELETE FROM terms_acceptances WHERE user_id=?").bind(owner.userId).run();
    await reaccept(owner.userId, "I have read and agree to the updated Murage Cloud terms, the Terms of Service and the Privacy Policy");
    expect(await mint()).toEqual({ status: "none" });
  });
  it("a newer legal document with no row covers nothing, and with a row the proof still names the ROW's ids, not the documents in force", async () => {
    await checkoutAcceptance(owner.userId, { tos: "terms-of-service-new", privacy: "privacy-policy-new" });
    expect(await mint()).toEqual({ status: "none" });
    expect(await mint("2026-12-01")).toEqual({ status: "none" });
    await withMap([...HOME_TERMS_MAP, { home: "2026-12-01", tos: "terms-of-service-new", privacy: "privacy-policy-new" }], async () => {
      const c = await claimsOf(await mint("2026-12-01"));
      expect(c.documents).toMatchObject({ termsOfService: "terms-of-service-new", privacyPolicy: "privacy-policy-new" });
      expect(c.homeTermsVersion).toBe("2026-12-01");
      // The older home version is not covered by the newer ids.
      expect(await mint(H1)).toEqual({ status: "none" });
    });
  });
  it("the key is the pinned B3 key: a proof signed by another key does not verify, and the proof says nothing a home could have chosen", async () => {
    await checkoutAcceptance(owner.userId);
    const a = await mint();
    const other = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    await expect(verifyPayload((a as Extract<typeof a, { status: "proof" }>).proof, await crypto.subtle.exportKey("jwk", other.publicKey))).rejects.toThrow();
  });
});

describe("mint: the notice period", () => {
  const H2 = "2026-12-01";
  const OLD = { tos: "terms-of-service-old", privacy: "privacy-policy-old" };
  const rows = (): HomeTermsRow[] => [{ home: H1, ...OLD }, { home: H2, tos: cur().termsOfService, privacy: cur().privacyPolicy }];
  const notice = (effectiveAt: number) => seed("terms_change_notices", { user_id: owner.userId, cloud_terms_version: cur().cloudTerms, tos_version: cur().termsOfService,
    privacy_version: cur().privacyPolicy, home_id: HOME, notified_at: NOW - DAY, effective_at: effectiveAt });
  it("with an earlier acceptance and no notice yet: a grace proof from the OLDER acceptance, 7 days, source notice-period", async () => {
    await withMap(rows(), async () => {
      const old = await checkoutAcceptance(owner.userId, { ...OLD, at: NOW - 40 * DAY });
      const c = await claimsOf(await mint(H2));
      expect(c).toMatchObject({ source: "notice-period", homeTermsVersion: H2, graceUntil: NOW + NOTICE_GRACE_FALLBACK_MS, acceptanceId: old.acceptanceId, acceptedAt: NOW - 40 * DAY });
      expect(c.documents).toMatchObject({ termsOfService: OLD.tos, privacyPolicy: OLD.privacy });
    });
  });
  it("with a delivered notice: grace until the notice's effective date", async () => {
    await withMap(rows(), async () => {
      await checkoutAcceptance(owner.userId, { ...OLD, at: NOW - 40 * DAY });
      await notice(NOW + 12 * DAY);
      expect((await claimsOf(await mint(H2))).graceUntil).toBe(NOW + 12 * DAY);
    });
  });
  it("after the effective date with no acceptance: none (the screen, then the site)", async () => {
    await withMap(rows(), async () => {
      await checkoutAcceptance(owner.userId, { ...OLD, at: NOW - 40 * DAY });
      await notice(NOW - 1000);
      expect(await mint(H2)).toEqual({ status: "none" });
    });
  });
  it("no earlier acceptance at all: none, never a grace out of nothing", async () => {
    await withMap(rows(), async () => { expect(await mint(H2)).toEqual({ status: "none" }); });
  });
  it("once the customer has accepted the new documents on the site, the proof is the real one, not a grace", async () => {
    await withMap(rows(), async () => {
      await checkoutAcceptance(owner.userId, { ...OLD, at: NOW - 40 * DAY });
      await reaccept(owner.userId, WORDING.reaccept, NOW - 1000);
      const c = await claimsOf(await mint(H2));
      expect(c).toMatchObject({ source: "reaccept", graceUntil: null });
      expect(c.documents.termsOfService).toBe(cur().termsOfService);
    });
  });
  it("a grace never covers a home version whose documents are not the ones in force", async () => {
    await withMap([{ home: H1, ...OLD }, { home: H2, tos: "terms-of-service-future", privacy: "privacy-policy-future" }], async () => {
      await checkoutAcceptance(owner.userId, { ...OLD, at: NOW - 40 * DAY });
      expect(await mint(H2)).toEqual({ status: "none" });
    });
  });
  it("a grace proof is never written anywhere: minting one leaves terms_acceptances as it was", async () => {
    await withMap(rows(), async () => {
      await checkoutAcceptance(owner.userId, { ...OLD, at: NOW - 40 * DAY });
      const count = async () => (await env.DB.prepare("SELECT COUNT(*) n FROM terms_acceptances").first<{ n: number }>())!.n;
      const before = await count();
      await mint(H2);
      expect(await count()).toBe(before);
    });
  });
});

describe("an acceptance given before the age screen", () => {
  it("an ageless acceptance of an OLDER version with no change notice sent yet still has a way forward: offered, accepted, then a proof", async () => {
    const m = await cloudMember("ageless-old@example.test");
    await checkoutAcceptance(m.userId, { screen: OLD_SCREEN, cloud: "cloud-terms-0ld0ld0ld0ld" });
    const worker = createWorker(fetch, fetch, {}, {}, {}, { jwksFetch, authFetch });
    const call = async (path: string, method: string, body?: unknown) => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request(`https://auth.murage.test${path}`, { method, headers: { authorization: `Bearer ${m.token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body) }), { ...env, ...supabaseEnv } as Env, ctx);
      await waitOnExecutionContext(ctx);
      return res;
    };
    // No notice row: noticePending. The account page must still offer the age-confirming acceptance, and the accept route must take it.
    const status = await (await call("/v1/account/terms", "GET")).json();
    expect(status, JSON.stringify(status)).toMatchObject({ noticePending: true, reacceptRequired: true, ageConfirmationRequired: true });
    const accepted = await call("/v1/account/terms/accept", "POST", { termsAccepted: true, ageConfirmed: true, screenVersion: SCREEN_VERSION, documentVersions: cur(), client: { ip: "198.51.100.8", userAgent: "ua" } });
    expect(accepted.status).toBe(200);
    expect(await (await call("/v1/account/terms", "GET")).json()).toMatchObject({ reacceptRequired: false, ageConfirmationRequired: false });
    // The accept route stamps the real clock, so the proof is minted at the real clock too (NOW is a fixed date that has now passed).
    expect((await claimsOf(await mint(H1, m.userId, Date.now()))).ageConfirmed).toBe(true);
  });
  it("is offered the age-confirming acceptance although no document changed, and that acceptance yields a proof", async () => {
    const m = await cloudMember("ageless@example.test");
    await checkoutAcceptance(m.userId, { screen: OLD_SCREEN });
    expect((await mint(H1, m.userId)).status).toBe("none");
    const worker = createWorker(fetch, fetch, {}, {}, {}, { jwksFetch, authFetch });
    const call = async (path: string, method: string, body?: unknown) => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request(`https://auth.murage.test${path}`, { method, headers: { authorization: `Bearer ${m.token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body) }), { ...env, ...supabaseEnv } as Env, ctx);
      await waitOnExecutionContext(ctx);
      return res;
    };
    expect(await (await call("/v1/account/terms", "GET")).json()).toMatchObject({ reacceptRequired: true, ageConfirmationRequired: true, changed: [] });
    const accepted = await call("/v1/account/terms/accept", "POST", { termsAccepted: true, ageConfirmed: true, screenVersion: SCREEN_VERSION, documentVersions: cur(), client: { ip: "198.51.100.8", userAgent: "ua" } });
    expect(accepted.status).toBe(200);
    expect(await (await call("/v1/account/terms", "GET")).json()).toMatchObject({ reacceptRequired: false, ageConfirmationRequired: false });
    // The accept route stamps the real clock, so the proof is minted at the real clock too (NOW is a fixed date that has now passed).
    expect((await claimsOf(await mint(H1, m.userId, Date.now()))).ageConfirmed).toBe(true);
  });
});

describe("the Flux Router Terms of Service in the one acceptance (no second screen)", () => {
  const FLUX_EN = "[Flux Router Terms of Service]";
  const FLUX_DE = "[Nutzungsbedingungen von Flux Router]";
  const api = (m: { token: string }) => {
    const worker = createWorker(fetch, fetch, {}, {}, {}, { jwksFetch, authFetch });
    return async (path: string, method: string, body?: unknown) => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request(`https://auth.murage.test${path}`, { method, headers: { authorization: `Bearer ${m.token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body) }), { ...env, ...supabaseEnv } as Env, ctx);
      await waitOnExecutionContext(ctx);
      return res;
    };
  };
  const fluxOf = async (where: string, val: string) => (await env.DB.prepare(`SELECT flux_terms_version AS v FROM terms_acceptances WHERE ${where}=?`).bind(val).first<{ v: string | null }>())?.v;

  it("the constants: Flux's own URL and the dated version, the site links carry the same URL", () => {
    expect(FLUX_TERMS_URL).toBe("https://fluxrouter.ai/terms-of-service");
    expect(FLUX_TERMS_VERSION).toBe("October 31, 2026");
    expect(submitLinksFor({}).flux).toBe(FLUX_TERMS_URL);
    expect(submitLinksFor({ CHECKOUT_SITE_ORIGIN: "https://staging.murage.test" }).flux).toBe(FLUX_TERMS_URL);
  });
  it("English: submitFull, submitShort and the acceptance line name the Flux Router terms, byte for byte", () => {
    const s = stringsFor("en");
    expect(s.submitFull).toBe("By submitting your order you confirm you are 18 or older, and you agree to the [Murage Cloud terms], [Terms of Service] and [Flux Router Terms of Service]. [Privacy Policy].");
    expect(s.submitShort).toBe("You also confirm you are 18 or older, and you agree to the [Terms of Service] and [Flux Router Terms of Service].");
    expect(s.disclosure.acceptance).toBe("You confirm you are 18 or older, and you accept the [Murage Cloud terms], [Terms of Service] and [Flux Router Terms of Service] when you submit your order on the payment page. [Privacy Policy].");
  });
  it("German: the same three, with the Flux label (marked for review)", () => {
    const s = stringsFor("de");
    expect(s.submitFull).toBe("Mit dem Absenden Ihrer Bestellung bestätigen Sie, dass Sie mindestens 18 Jahre alt sind, und stimmen den [Murage-Cloud-Bedingungen], den [Nutzungsbedingungen] und den [Nutzungsbedingungen von Flux Router] zu. [Datenschutzerklärung].");
    expect(s.submitShort).toBe("Sie bestätigen außerdem, dass Sie mindestens 18 Jahre alt sind, und stimmen den [Nutzungsbedingungen] und den [Nutzungsbedingungen von Flux Router] zu.");
    expect(s.disclosure.acceptance).toContain(`und die ${FLUX_DE}. [Datenschutzerklärung].`);
  });
  it("each bracket resolves to its own page on the Stripe page: the Flux label to Flux, ours to the site", () => {
    const links = submitLinksFor({});
    for (const [lang, flux, tos] of [["en", FLUX_EN, "[Terms of Service]"], ["de", FLUX_DE, "[Nutzungsbedingungen]"]] as const) {
      const msg = directSubmitMessage(lang, "pro", "full", links);
      expect(msg).toContain(`${flux.slice(0, -1)}](${FLUX_TERMS_URL})`);
      expect(msg).toContain(`${tos.slice(0, -1)}](https://murage.ai/terms-of-service)`);
      expect(msg.match(/\]\(https:\/\/fluxrouter\.ai\/terms-of-service\)/g)).toHaveLength(1);
    }
  });
  it("a screen from before the Flux line (.7) is refused 409 disclosure_stale, and so is its old sentence", () => {
    const body = consentFor("pro", NOW);
    const ctx = { seller: "ferrox" as const, policyVersion: "p1" };
    const meta = { claimed: { ip: "198.51.100.7" }, observed: { ip: "203.0.113.1" } } as never;
    const stale = (b: typeof body) => { try { prepareConsent(b, "pro", NOW, meta, ctx); return null; } catch (x) { return x instanceof HTTPError ? [x.status, x.code] : x; } };
    expect(stale({ ...body, screenVersion: "checkout-clickwrap-2026-10-30.7" })).toEqual([409, "disclosure_stale"]);
    const old = "You confirm you are 18 or older, and you accept the [Murage Cloud terms] and [Terms of Service] when you submit your order on the payment page. [Privacy Policy].";
    expect(stale({ ...body, renewalText: body.renewalText.replace(/[^\n]*$/, old) })).toEqual([409, "disclosure_stale"]);
    expect(SCREEN_VERSION).toBe("checkout-clickwrap-2026-10-30.8");
    expect(prepareConsent(body, "pro", NOW, meta, ctx).wording.acceptance).toContain(FLUX_EN);
  });
  it("checkout: the completed order writes the Flux version in the same row; a consent from the screen before has none", async () => {
    const m = await cloudMember("flux-checkout@example.test");
    const line = stringsFor("en").disclosure.acceptance;
    const mk = async (screen: string) => {
      const id = `consent-flux-${++n}`;
      await seed("checkout_consents", { id, home_id: HOME, user_id: m.userId, screen_version: screen, cloud_terms_version: cur().cloudTerms, tos_version: cur().termsOfService,
        privacy_version: cur().privacyPolicy, wording: JSON.stringify({ acceptance: line }), start_request_at: null, completed_at: null, created_at: NOW - DAY });
      return id;
    };
    const now = await mk(SCREEN_VERSION);
    expect(await recordAcceptanceAtCompletion(env as unknown as Env, now, NOW)).toBe(true);
    expect(await fluxOf("consent_id", now)).toBe(FLUX_TERMS_VERSION);
    expect((await env.DB.prepare("SELECT wording FROM terms_acceptances WHERE consent_id=?").bind(now).first<{ wording: string }>())?.wording).toContain(FLUX_EN);
    const before = await mk("checkout-clickwrap-2026-10-30.7");
    await recordAcceptanceAtCompletion(env as unknown as Env, before, NOW);
    expect(await fluxOf("consent_id", before)).toBeNull();
  });
  it("re-accept: the row carries the Flux version and the re-accept words name the Flux terms", async () => {
    const m = await cloudMember("flux-reaccept@example.test");
    const call = api(m);
    expect(WORDING.reaccept).toContain("the Flux Router Terms of Service");
    const res = await call("/v1/account/terms/accept", "POST", { termsAccepted: true, ageConfirmed: true, screenVersion: SCREEN_VERSION, documentVersions: cur(), client: { ip: "198.51.100.8", userAgent: "ua" } });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT flux_terms_version AS v, wording FROM terms_acceptances WHERE user_id=? AND source='reaccept'").bind(m.userId).first<{ v: string; wording: string }>();
    expect(row).toEqual({ v: FLUX_TERMS_VERSION, wording: WORDING.reaccept });
    // A stale screen is refused and writes nothing.
    const stale = await call("/v1/account/terms/accept", "POST", { termsAccepted: true, ageConfirmed: true, screenVersion: "checkout-clickwrap-2026-10-30.7", documentVersions: cur(), client: { ip: "198.51.100.8", userAgent: "ua" } });
    expect([stale.status, (await stale.json() as { error: string }).error]).toEqual([409, "disclosure_stale"]);
  });
  it("an old row with no Flux version is still read: no re-accept is forced, its age proof stands", async () => {
    const m = await cloudMember("flux-old@example.test");
    const a = await checkoutAcceptance(m.userId, { screen: "checkout-clickwrap-2026-10-30.7" });
    expect(await fluxOf("id", a.acceptanceId)).toBeNull();
    const call = api(m);
    expect(await (await call("/v1/account/terms", "GET")).json()).toMatchObject({ reacceptRequired: false, ageConfirmationRequired: false, changed: [] });
    expect((await claimsOf(await mint(H1, m.userId))).ageConfirmed).toBe(true);
    const r = await reaccept(m.userId, "I confirm I am 18 or older, and I have read and agree to the updated Murage Cloud terms, the Terms of Service and the Privacy Policy", NOW - DAY / 2);
    expect(await fluxOf("id", r)).toBeNull();
    expect(ageShown({ source: "reaccept", wording: "I confirm I am 18 or older, and I have read and agree to the updated Murage Cloud terms, the Terms of Service and the Privacy Policy", screen_version: null })).toBe(true);
  });
});
