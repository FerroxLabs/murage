// Updates consent v5.6.2 text seed (MurageMain 11-07): every row 0149 seeds is compared byte for byte to its source, kept verbatim in
// test/fixtures/updates-consent-texts/<version>.txt (first line: repo, commit, file and lines; the rest: the source lines exactly as
// `git show <commit>:<file>` prints them). A copy change in a source turns this red and needs a NEW row, never an edited one.
// Commits behind each byte test (cloud monorepo, package.json bumps): 1.0.6 = 97c585eae (pre-1.0.7 card, the same block on every release
// commit from 0.1.59 4148d515d), 1.0.7 = 833c3a3c5 (through 1.0.11 f23d9fbff), 1.0.12 = b0ea88d32 (identical through 1.0.17 f28a6bad8);
// the site rows at muragesite c8e6ce21612c73a563690e016a78202f6ef84660; the desktop row from CONCIERGE-HELPER-1020.md 8.7 (not built yet).
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { APP_UNMATCHED_ALERT } from "../src/announcements";
import { isPageKind } from "../src/alert-tiers";
import { createWorker } from "../src/index";
import { sendUpdatesOutbox } from "../src/updates-consent/routes";

// @ts-expect-error import.meta.glob is Vite's (vitest transforms it); the worker tsconfig does not load vite/client types.
const files = import.meta.glob("./fixtures/updates-consent-texts/*.txt", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const fixture = (version: string) => {
  const raw = files[`./fixtures/updates-consent-texts/${version}.txt`];
  if (raw === undefined) throw new Error(`no fixture for ${version}`);
  return raw.slice(raw.indexOf("\n") + 1);
};

/** The string literals of `key: "a" + "b"` (or `const KEY = 'a'`) in a source excerpt, joined as the JS would join them. */
function literal(source: string, key: string): string {
  const at = source.search(new RegExp(`(?:^|\\s)${key}(?::|\\s*=)`, "m"));
  if (at < 0) throw new Error(`no ${key}`);
  const rest = source.slice(at).replace(/^\s*\S+?(?::|\s*=)/, "");
  const parts: string[] = [];
  const re = /^\s*(?:\+\s*)?(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/;
  let tail = rest;
  for (let m = re.exec(tail); m; m = re.exec(tail)) {
    parts.push((m[1] ?? m[2]!).replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c)));
    tail = tail.slice(m[0].length);
  }
  if (parts.length === 0) throw new Error(`no literal for ${key}`);
  return parts.join("");
}
/** newsConsentText (news-consent.ts at 833c3a3c5 and b0ea88d32): lines joined with "\n", capped at 500, no trim. */
const consentText = (lines: string[]) => lines.join("\n").slice(0, 500);
const quoted = (s: string) => s.trim().replace(/^"|"$/g, "");

const APP_UNMATCHED_BODY = "The app sent words that match no known Murage card. The exact words it sent are kept with this record as data, never shown as a page or sent in an email.";
const EXPECTED: Record<string, () => string> = {
  "2026-11-06": () => quoted(fixture("2026-11-06")),
  "app-1.0.7-hello": () => consentText([literal(fixture("app-1.0.7-hello"), "heading"), literal(fixture("app-1.0.7-hello"), "lead")]),
  "app-1.0.12-hello": () => consentText([literal(fixture("app-1.0.12-hello"), "heading"), literal(fixture("app-1.0.12-hello"), "emailHelper")]),
  "app-settings": () => consentText([literal(fixture("app-settings"), "title"), literal(fixture("app-settings"), "subtitle")]),
  "site-guide": () => literal(fixture("site-guide"), "GUIDE_NEWS_CONSENT"),
  "site-waitlist": () => literal(fixture("site-waitlist"), "WAITLIST_CONSENT"),
  "site-news": () => literal(fixture("site-news"), "NEWS_CONSENT_TEXT"),
  "legacy-pre-1.0.7": () => consentText([literal(fixture("legacy-pre-1.0.7"), "heading"), literal(fixture("legacy-pre-1.0.7"), "lead")]),
  "app-unmatched": () => APP_UNMATCHED_BODY,
};

const TOKEN = "site-forwarder-test-token-1234567890"; // secret-scan: fixture
let seq = 0;
const addr = (tag: string) => `txt-${tag}-${++seq}-${crypto.randomUUID().slice(0, 8)}@example.test`;
interface Mail { to: string; subject: string; text: string; html?: string; headers?: Record<string, string> }
const mails: Mail[] = [];
const e = { ...env, MURAGE_ENV: "live", SITE_FORWARDER_TOKEN: TOKEN, UPDATES_SIGNUPS_OPEN: "1", CP_ONECLICK_DKIM_VERIFIED: "1",
  EMAIL: { async send(m: Mail) { mails.push(m); } } } as unknown as Env;
async function forward(body: Record<string, unknown>) {
  const ctx = createExecutionContext();
  const res = await createWorker(fetch, async () => new Response("{}")).fetch(new Request("https://auth.murage.test/v1/announcements/subscribe", {
    method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", "X-Murage-Site-Token": TOKEN, "cf-connecting-ip": `198.51.100.${(++seq % 250) + 1}` },
  }), e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const versionOf = async (email: string) => (await env.DB.prepare("SELECT text_version AS v FROM updates_consent WHERE email=?").bind(email).first<{ v: string }>())?.v;

describe("0149 consent text seed (v5.6.2)", () => {
  it("seeds exactly these rows, each byte-exact to its source", async () => {
    const rows = (await env.DB.prepare("SELECT version, locale, body FROM updates_consent_texts WHERE body <> 'test words' ORDER BY version").all<{ version: string; locale: string; body: string }>()).results;
    expect(rows.map((r) => r.version).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const r of rows) {
      expect([r.version, r.locale, r.body]).toEqual([r.version, "en", EXPECTED[r.version]!()]);
      expect(r.body.length).toBeLessThanOrEqual(500);
    }
    // Spot checks that the parser read what the sources say (the full strings are the rows above).
    expect(EXPECTED["app-1.0.12-hello"]!()).toBe("Hello\nFor your setup guide and news. Nothing else.");
    expect(EXPECTED["app-1.0.7-hello"]!()).toHaveLength(328);
    expect(EXPECTED["app-settings"]!()).toHaveLength(133);
  });

  it("is append-only: an UPDATE or a DELETE of a text row is refused", async () => {
    await expect(env.DB.prepare("UPDATE updates_consent_texts SET body='x' WHERE version='site-news'").run()).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare("DELETE FROM updates_consent_texts WHERE version='site-news'").run()).rejects.toThrow(/append-only/);
  });
});

describe("selection of ?5 (v5.6.2)", () => {
  it("source app picks its row by an exact byte match; any other words, the site news words included, are app-unmatched", async () => {
    for (const v of ["app-1.0.7-hello", "app-1.0.12-hello", "app-settings"]) {
      const a = addr(v);
      expect((await forward({ email: a, source: "app", consentText: EXPECTED[v]!(), requestId: `rq-${crypto.randomUUID()}` })).status).toBe(200);
      expect(await versionOf(a)).toBe(v);
    }
    for (const words of [EXPECTED["site-news"]!(), `${EXPECTED["app-1.0.12-hello"]!()}.`, "Hello\r\nFor your setup guide and news. Nothing else."]) {
      const a = addr("unmatched");
      await forward({ email: a, source: "app", consentText: words, requestId: `rq-${crypto.randomUUID()}` });
      expect(await versionOf(a)).toBe("app-unmatched");
      expect((await env.DB.prepare(`SELECT ac.consent_text AS t FROM announcement_consents ac JOIN updates_consent c ON c.site_consent_id=ac.id
        WHERE c.email=?`).bind(a).first<{ t: string }>())?.t).toBe(words);
    }
  });

  it("byte-exact (B1 r1 Astra M): known app words with leading or trailing whitespace are app-unmatched, and every word is stored verbatim", async () => {
    const known = EXPECTED["app-1.0.12-hello"]!();
    for (const words of [` ${known}\n`, ` ${known}`, `${known}\n`, `${known} `, `\t${known}`]) {
      const a = addr("ws");
      expect((await forward({ email: a, source: "app", consentText: words, requestId: `rq-${crypto.randomUUID()}` })).status).toBe(200);
      expect(await versionOf(a)).toBe("app-unmatched");
      expect((await env.DB.prepare(`SELECT ac.consent_text AS t FROM announcement_consents ac JOIN updates_consent c ON c.site_consent_id=ac.id
        WHERE c.email=?`).bind(a).first<{ t: string }>())?.t).toBe(words);
    }
    const exact = addr("exact");
    await forward({ email: exact, source: "app", consentText: known, requestId: `rq-${crypto.randomUUID()}` });
    expect(await versionOf(exact)).toBe("app-1.0.12-hello");
    // Blank words are still a validation failure.
    expect((await forward({ email: addr("blank"), source: "app", consentText: " \n ", requestId: `rq-${crypto.randomUUID()}` })).status).toBe(400);
  });

  it("site forms pick by their validated source: guide, waitlist, else site-news", async () => {
    for (const [source, v] of [["guide", "site-guide"], ["waitlist", "site-waitlist"], ["footer", "site-news"], ["download", "site-news"], ["site", "site-news"]]) {
      const a = addr(source!);
      await forward({ email: a, source, consentText: "Whatever the form showed", requestId: `rq-${crypto.randomUUID()}` });
      expect(await versionOf(a)).toBe(v);
    }
  });

  it("app-unmatched words are data only: one digest alert an hour that never pages and never holds the words; no mail carries them", async () => {
    const words = `<img src=x onerror=alert(1)> unmatched words ${crypto.randomUUID()}`;
    const sent: string[] = [];
    for (let i = 0; i < 6; i++) {
      const a = addr("flood");
      sent.push(a);
      await forward({ email: a, source: "app", consentText: words, requestId: `rq-${crypto.randomUUID()}` });
    }
    const hour = `platform:updates-app-unmatched:${new Date().toISOString().slice(0, 13)}`;
    const alerts = (await env.DB.prepare("SELECT detail FROM cloud_alerts WHERE kind=? AND home_id=?").bind(APP_UNMATCHED_ALERT, hour).all<{ detail: string }>()).results;
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.detail).not.toContain(words);
    expect(alerts[0]!.detail).not.toContain("<img");
    expect(isPageKind(APP_UNMATCHED_ALERT)).toBe(false);
    await sendUpdatesOutbox(e);
    const ours = mails.filter((m) => sent.includes(m.to));
    expect(ours.length).toBeGreaterThan(0);
    for (const m of ours) for (const part of [m.subject, m.text, m.html ?? ""]) expect(part).not.toContain("onerror");
  });

  it("the anonymous pre-1.0.7 path binds legacy-pre-1.0.7", async () => {
    const a = addr("legacy");
    const ctx = createExecutionContext();
    await createWorker(fetch, async () => new Response("{}")).fetch(new Request("https://auth.murage.test/v1/announcements/subscribe", {
      method: "POST", body: JSON.stringify({ email: a, name: "Pat" }), headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" },
    }), e, ctx);
    await waitOnExecutionContext(ctx);
    expect(await versionOf(a)).toBe("legacy-pre-1.0.7");
  });
});
