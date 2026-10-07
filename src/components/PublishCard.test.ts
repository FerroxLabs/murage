// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { failureCopy, PublishCardView, PublishedSitesView, type PublishCardViewProps } from "./PublishCard";
import { pendingApprovals } from "./PendingApproval";
import type { Message } from "@/state/store";

const data = { action: "publish" as const, host: "netlify" as const, url: "https://my-shop.netlify.app", siteName: "my-shop",
  files: [{ path: "index.html", size: 2048 }, { path: "css/style.css", size: 512 }], totalBytes: 2560, skipped: [".env"] };
const view = (extra: Partial<PublishCardViewProps> = {}) => renderToStaticMarkup(createElement(PublishCardView, { data, title: "Publish this site?", desktop: true, onAnswer: () => {}, ...extra }));

it("shows the name, the address, the count and size, the public notice, and Publish / Not now", () => {
  const html = view();
  expect(html).toContain("Publish this site?");
  expect(html).toContain("my-shop");
  expect(html).toContain("https://my-shop.netlify.app");
  expect(html).toContain("2 files, 3 KB");
  expect(html).toContain("Anyone with the link can see this.");
  expect(html).toContain(">Publish<");
  expect(html).toContain(">Not now<");
  expect(html).toContain(".env");
  expect(html).not.toMatch(/always/i);
});

it("keeps the file list folded until it is opened", () => {
  expect(view()).not.toContain("css/style.css");
  expect(view()).toContain('aria-expanded="false"');
  const open = view({ filesOpen: true });
  expect(open).toContain("css/style.css");
  expect(open).toContain("index.html");
});

it("on a phone or the browser door it is read-only and points to the computer", () => {
  const html = view({ desktop: false });
  expect(html).toContain("Approve on your computer");
  expect(html).not.toContain("data-choice");
  expect(html).toContain("https://my-shop.netlify.app");
  // not yet known which door: no buttons and no claim either
  const unknown = view({ desktop: undefined });
  expect(unknown).not.toContain("data-choice");
  expect(unknown).not.toContain("Approve on your computer");
});

it("an update says so, and a take-down card names the address and offers Take it down", () => {
  expect(view({ data: { ...data, action: "update", siteId: "s1" }, title: "Update your live site?" })).toContain(">Update site<");
  const html = view({ data: { action: "take-down", host: "netlify", url: "https://my-shop.netlify.app", siteId: "s1" }, title: "Take this site down?" });
  expect(html).toContain("Take this site down?");
  expect(html).toContain("This removes https://my-shop.netlify.app for everyone. Your files stay here.");
  expect(html).toContain(">Take it down<");
  expect(html).toContain(">Not now<");
  expect(html).not.toContain("Anyone with the link");
});

it("shows honest progress, then Live with an Open button", () => {
  const up = view({ settled: "allow", data: { ...data, progress: { step: "uploading", fileCount: 12 } } });
  expect(up).toContain("Uploading 12 files");
  expect(up).not.toContain("data-choice");
  const check = view({ settled: "allow", data: { ...data, progress: { step: "checking", fileCount: 12 } } });
  expect(check).toContain("Uploading 12 files");
  expect(check).toContain("Checking it loads");
  const live = view({ settled: "allow", onOpen: () => {}, data: { ...data, progress: { step: "live", fileCount: 12 } } });
  expect(live).toContain("Live at https://my-shop.netlify.app");
  expect(live).toContain("data-publish-open");
  expect(live).toContain(">Open<");
  expect(view({ settled: "allow", data: { ...data, progress: { step: "uploading", fileCount: 1 } } })).toContain("Uploading 1 file<");
});

it("a failure is one plain sentence and the next step", () => {
  const cases: Array<[Parameters<typeof failureCopy>[0], RegExp, RegExp]> = [
    ["reconnect", /sign in again/i, /Reconnect/],
    ["wait", /busy/i, /Wait a minute/],
    ["too-big", /too big/i, /smaller|Remove/],
  ];
  for (const [failure, sentence, next] of cases) {
    const html = view({ settled: "allow", data: { ...data, progress: { step: "failed", failure } } });
    const copy = failureCopy(failure);
    expect(copy.sentence).toMatch(sentence); expect(copy.next).toMatch(next);
    expect(html).toContain(`data-publish-failure="${failure}"`);
    expect(html).toContain(copy.sentence.replace(/'/g, "&#x27;"));
    expect(html).not.toContain("data-choice");
  }
});

it("a declined card says nothing was changed", () => {
  const html = view({ settled: "deny" });
  expect(html).toContain("Nothing was changed");
  expect(html).not.toContain("data-choice");
});

it("a publish card never appears among the approvals the composer or a call can answer", () => {
  const message = (kind?: "publish"): Message => ({ id: "m1", role: "bot", kind: "options", at: 1, card: { title: "t", subtitle: "s", options: ["Allow", "Deny"], requestId: "publish-1", tool: "publish_site", ...(kind ? { kind } : {}) } } as Message);
  expect(pendingApprovals([message()])).toHaveLength(1);
  expect(pendingApprovals([message("publish")])).toHaveLength(0);
});

const site = { siteId: "s1", name: "my-shop", url: "https://my-shop.netlify.app", lastPublishedAt: Date.UTC(2026, 9, 3), lastFileCount: 12, origin: "created" as const };
it("lists the sites a bot published, with Open and Take down, and asks before taking one down", () => {
  const html = renderToStaticMarkup(createElement(PublishedSitesView, { botName: "Mira", sites: [site], desktop: true }));
  expect(html).toContain("Sites this bot published");
  expect(html).toContain("https://my-shop.netlify.app");
  expect(html).toContain("12 files");
  expect(html).toContain("data-open-site");
  expect(html).toContain("data-take-down");
  const asking = renderToStaticMarkup(createElement(PublishedSitesView, { botName: "Mira", sites: [site], desktop: true, confirming: "s1" }));
  expect(asking).toContain("Take https://my-shop.netlify.app down for everyone? Your files stay here.");
  expect(asking).toContain("data-confirm-take-down");
  expect(asking).toContain("Keep it");
  expect(asking).not.toContain("data-take-down");
});

it("on a phone the list is read-only, and an empty list says how it fills", () => {
  const phone = renderToStaticMarkup(createElement(PublishedSitesView, { botName: "Mira", sites: [site], desktop: false }));
  expect(phone).toContain("data-open-site");
  expect(phone).not.toContain("data-take-down");
  expect(renderToStaticMarkup(createElement(PublishedSitesView, { botName: "Mira", sites: [], desktop: true }))).toContain("Ask Mira to put a site online");
});

// ---- P3: Connect Netlify ----
import { ConnectNetlifyView, type ConnectNetlifyViewProps } from "./PublishCard";
import en from "@/locales/en.json";

const connect = (extra: Partial<ConnectNetlifyViewProps> = {}) => renderToStaticMarkup(createElement(ConnectNetlifyView, { state: "needed", desktop: true, step: "start", shell: true, ...extra }));

it("the Connect Netlify card is one calm step: a sign-in button, a plain statement of what it allows, and a quiet way to paste a token", () => {
  const html = connect();
  expect(html).toContain("Connect Netlify");
  expect(html).toContain("data-connect-signin");
  expect(html).toContain("Sign in with Netlify");
  expect(html).toContain("data-connect-allows");
  expect(html).toContain("create, update and take down");
  expect(html).toContain("asks you on this computer before each one");
  expect(html).toContain("data-connect-use-token");
  expect(html).not.toContain("<input");
  expect(html).not.toContain('role="dialog"');
});

it("the paste step has a hidden field that never carries a value, a one-line how-to and Netlify's token page", () => {
  const html = connect({ step: "token" });
  expect(html).toMatch(/<input[^>]*type="password"/);
  expect(html).toMatch(/<input[^>]*autoComplete="off"|<input[^>]*autocomplete="off"/);
  expect(html).not.toMatch(/<input[^>]*\svalue=/);
  expect(html).toContain("User settings, then Applications");
  expect(html).toContain('href="https://app.netlify.com/user/applications#personal-access-tokens"');
  expect(html).toContain("data-connect-save");
});

it("tells the owner what is happening while it signs in and while it checks", () => {
  expect(connect({ step: "signing-in" })).toContain("Opening Netlify in your browser");
  expect(connect({ step: "checking" })).toContain("Checking the connection with Netlify");
  expect(connect({ step: "signing-in" })).not.toContain("data-connect-signin");
});

it("when the Netlify sign-in is not enough, the card says so and goes straight to the token", () => {
  const html = connect({ step: "token", why: "sign-in-not-enough" });
  expect(html).toContain("Netlify wants an access token for publishing");
  expect(connect({ step: "token", why: "token-rejected" })).toContain("did not accept that token");
  expect(connect({ step: "token", why: "no-shell", shell: false })).toContain("Signing in is available in the Murage desktop app");
});

it("connected is a quiet confirmation with nothing left to press", () => {
  const html = connect({ state: "connected" });
  expect(html).toContain("Netlify is connected");
  expect(html).not.toContain("<button");
});

it("on a phone or the browser door it points to the computer and offers no field", () => {
  const html = connect({ desktop: false });
  expect(html).toContain("Connecting Netlify is done on the computer running Murage.");
  expect(html).not.toContain("<input");
  expect(html).not.toContain("data-connect-signin");
});

it("the new copy follows the house rules in English", () => {
  const mine = Object.entries(en as Record<string, string>).filter(([key]) => key.startsWith("publish.connect.") || key.startsWith("publish.sites.add") || key.startsWith("publish.sites.attention"));
  expect(mine.length).toBeGreaterThan(20);
  for (const [key, value] of mine) {
    expect(value, key).not.toMatch(/[—–]/);
    expect(value, key).not.toMatch(/\b(safe|safely|safety|unsafe|composio|free|price|cheap|always-on)\b/i);
  }
});

// ---- P3: add an existing site, and a site that needs attention ----
it("offers Add an existing site on the computer, and not on a phone", () => {
  const html = renderToStaticMarkup(createElement(PublishedSitesView, { botName: "Mira", sites: [site], desktop: true, onAdd: () => {} }));
  expect(html).toContain("Add an existing site");
  expect(html).toMatch(/<input[^>]*data-add-site-input/);
  expect(html).toContain("data-add-site");
  const phone = renderToStaticMarkup(createElement(PublishedSitesView, { botName: "Mira", sites: [site], desktop: false, onAdd: () => {} }));
  expect(phone).not.toContain("Add an existing site");
  const empty = renderToStaticMarkup(createElement(PublishedSitesView, { botName: "Mira", sites: [], desktop: true, onAdd: () => {} }));
  expect(empty).toContain("Add an existing site");
});

it("shows why an add did not go through, in plain words", () => {
  const html = renderToStaticMarkup(createElement(PublishedSitesView, { botName: "Mira", sites: [], desktop: true, onAdd: () => {}, addError: "Netlify has no site with that address in your account." }));
  expect(html).toContain('role="alert"');
  expect(html).toContain("no site with that address");
});

it("a site that needs attention says so and keeps its Take down button", () => {
  const stuck = { ...site, lastPublishedAt: 0, lastFileCount: 0, needsAttention: true as const };
  const html = renderToStaticMarkup(createElement(PublishedSitesView, { botName: "Mira", sites: [stuck], desktop: true }));
  expect(html).toContain("Needs attention");
  expect(html).toContain("did not finish going up");
  expect(html).toContain("data-take-down");
});
