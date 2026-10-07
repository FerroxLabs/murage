// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A fake connected-apps broker for tests: the catalog contract Murage expects
// (0161 lanes/apps BROKER-CONTRACT.md, "contract 2") and today's broker,
// which passes the vendor's raw 500-item pages through and ignores every
// query word but `cursor`. Both hold the same apps, so a test can run the
// same assertions against either and see Murage degrade cleanly.

/** The owner's 13 connected services (CONNECTED-APPS-CATALOG.md section 2):
 * six of them are not in the curated 24. */
export const OWNER_INVENTORY_SLUGS = [
  "gmail", "googlesuper", "googlecalendar", "stripe", "stripe_mcp", "supabase", "calendly",
  "dropbox", "slack", "slackbot", "discord", "github", "freshdesk",
] as const;

const NAMED: Array<{ slug: string; name: string; managed: boolean }> = [
  { slug: "gmail", name: "Gmail", managed: true },
  { slug: "slack", name: "Slack", managed: true },
  { slug: "github", name: "GitHub", managed: true },
  { slug: "googlecalendar", name: "Google Calendar", managed: true },
  { slug: "googlesuper", name: "Google Super", managed: true },
  { slug: "notion", name: "Notion", managed: true },
  { slug: "calendly", name: "Calendly", managed: true },
  { slug: "supabase", name: "Supabase", managed: false },
  { slug: "stripe", name: "Stripe", managed: true },
  { slug: "stripe_mcp", name: "Stripe MCP", managed: false },
  { slug: "slackbot", name: "Slackbot", managed: true },
  { slug: "discord", name: "Discord", managed: true },
  { slug: "dropbox", name: "Dropbox", managed: true },
  { slug: "freshdesk", name: "Freshdesk", managed: false },
  { slug: "airtable", name: "Airtable", managed: true },
];

export interface FakeApp {
  slug: string;
  name: string;
  blurb: string;
  logo: string;
  noAuth: boolean;
  managed: boolean;
  /** usage rank, 0 = most used */
  rank: number;
}

/** `count` apps in usage order: the well-known ones first, then a long tail
 * `Tail app 0016` … whose last entry is the least used. */
export function fakeCatalogApps(count = 1_600): FakeApp[] {
  const apps: FakeApp[] = NAMED.map((app, rank) => ({
    slug: app.slug, name: app.name, blurb: `${app.name} for your bots`, logo: `https://logos.example.test/${app.slug}.png`,
    noAuth: false, managed: app.managed, rank,
  }));
  for (let rank = apps.length; rank < count; rank += 1) {
    const id = String(rank).padStart(4, "0");
    apps.push({
      slug: `tail_app_${id}`, name: `Tail app ${id}`, blurb: `Long tail app number ${id}`, logo: `https://logos.example.test/tail-${id}.png`,
      // every seventh needs no sign-in; every third brings its own
      noAuth: rank % 7 === 0, managed: rank % 3 !== 0, rank,
    });
  }
  // The service's own toolkit rides along in the raw catalog; it is never an app.
  // `count` real apps, plus that one.
  apps.splice(40, 0, { slug: "composio_search", name: "Composio Search", blurb: "", logo: "", noAuth: true, managed: true, rank: 40 });
  return apps;
}

const slim = (app: FakeApp) => ({ slug: app.slug, name: app.name, logo: app.logo, blurb: app.blurb, no_auth: app.noAuth, managed_sign_in: app.managed });
const raw = (app: FakeApp) => ({
  slug: app.slug, name: app.name, meta: { description: app.blurb, logo: app.logo }, no_auth: app.noAuth,
  composio_managed_auth_schemes: app.managed ? ["OAUTH2"] : [],
});

export interface FakeBrokerOptions {
  /** 2 (default) speaks the contract; 1 is today's pass-through broker */
  contract?: 1 | 2;
  /** answer this status for every catalog request */
  status?: number;
  /** hang every catalog request until the signal aborts */
  hang?: boolean;
  /** throw a network error on this page number (1-based) of a walk */
  failOnPage?: number;
}

export interface FakeBroker {
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** every catalog request's URL, in order */
  calls: URL[];
  options: FakeBrokerOptions;
}

const encodeCursor = (offset: number) => Buffer.from(`o${offset}`).toString("base64url");
const decodeCursor = (cursor: string | null) => {
  if (!cursor) return 0;
  const text = Buffer.from(cursor, "base64url").toString();
  return /^o\d+$/.test(text) ? Number(text.slice(1)) : 0;
};

export function fakeCatalogBroker(apps: FakeApp[] = fakeCatalogApps(), options: FakeBrokerOptions = {}): FakeBroker {
  const calls: URL[] = [];
  const broker: FakeBroker = {
    calls,
    options,
    fetch: async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
      if (!url.pathname.endsWith("/v1/catalog") && !url.pathname.endsWith("/toolkits")) {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      calls.push(url);
      if (broker.options.hang) {
        await new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) reject(signal.reason);
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      if (broker.options.status) return Response.json({ error: "fixture failure" }, { status: broker.options.status });
      const offset = decodeCursor(url.searchParams.get("cursor"));
      const pageNumber = Math.floor(offset / 500) + 1;
      if (broker.options.failOnPage === pageNumber) throw new TypeError("fetch failed");
      if ((broker.options.contract ?? 2) === 1) {
        // Today's broker: the vendor's raw page of 500, whatever was asked.
        const page = apps.slice(offset, offset + 500);
        const next = offset + 500 < apps.length ? encodeCursor(offset + 500) : null;
        return Response.json({
          items: page.map(raw), next_cursor: next, total_items: apps.length,
          current_page: pageNumber, total_pages: Math.ceil(apps.length / 500),
        });
      }
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit")) || 500));
      const search = (url.searchParams.get("search") ?? "").trim().toLowerCase();
      const catalog = apps.filter((app) => !/composio/i.test(app.slug));
      let pool = catalog;
      if (search) pool = catalog.filter((app) => `${app.slug} ${app.name} ${app.blurb}`.toLowerCase().includes(search));
      if (url.searchParams.get("sort") === "name") pool = [...pool].sort((a, b) => a.name.localeCompare(b.name));
      const page = pool.slice(offset, offset + limit);
      return Response.json({
        contract: 2,
        items: page.map(slim),
        next_cursor: offset + limit < pool.length ? encodeCursor(offset + limit) : null,
        total_items: pool.length,
        catalog_total: catalog.length,
        generated_at: "2026-09-27T00:00:00Z",
      });
    },
  };
  return broker;
}
