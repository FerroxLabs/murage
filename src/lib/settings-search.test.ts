// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// SETTINGS-UX-1011 S3: the ranker, against the 40-query table Fable wrote before it was built
// (handoffs/HANDOFF-1012-UX-L3A.md carries the table's ordering rule and why each row expects what it does).
import { describe, expect, it } from "vitest";

import { SETTINGS_RESULT_CAP, searchSettingsCards, searchSettingsIndex, type SettingsFindContext, type SettingsIndexHit } from "./settings-search";

const BOTS = [{ id: "b-nova", name: "Nova" }, { id: "b-rex", name: "Rex" }, { id: "b-ivy", name: "Ivy" }];
const CONTEXT: Record<string, SettingsFindContext> = {
  app: { desktop: true, cloud: false, bots: BOTS },
  "bot:Rex": { desktop: true, cloud: false, bots: BOTS, currentBotId: "b-rex" },
  phone: { desktop: false, cloud: false, bots: BOTS },
};
const idOf = (hit: SettingsIndexHit) => (hit.bot ? `${hit.entry.id}@${hit.bot.name}` : hit.entry.id);

const TABLE: Array<{ q: string; ctx: keyof typeof CONTEXT; first: string; top5?: string[] }> = [
  {"q": "email", "ctx": "app", "first": "connections.bot-email", "top5": ["connections.bot-email", "general.profile", "bot.email.email@Nova"]},
  {"q": "email", "ctx": "bot:Rex", "first": "bot.email.email@Rex", "top5": ["bot.email.email@Rex", "connections.bot-email", "bot.email.email@Nova"]},
  {"q": "working folder", "ctx": "app", "first": "bot.access.folder@Nova", "top5": ["bot.access.folder@Nova", "bot.access.folder@Rex", "bot.access.folder@Ivy"]},
  {"q": "approval", "ctx": "app", "first": "bot.permissions.level@Nova", "top5": ["bot.permissions.level@Nova", "bot.permissions.level@Rex", "bot.permissions.level@Ivy"]},
  {"q": "ollama", "ctx": "app", "first": "models.local-servers"},
  {"q": "mcp", "ctx": "app", "first": "connections.mcp", "top5": ["connections.mcp", "bot.access.apps@Nova"]},
  {"q": "images", "ctx": "app", "first": "webSearch.images", "top5": ["webSearch.images", "bot.permissions.images@Nova"]},
  {"q": "tool", "ctx": "app", "first": "botDefaults.tool-calls", "top5": ["botDefaults.tool-calls"]},
  {"q": "notif", "ctx": "app", "first": "general.notifications", "top5": ["general.notifications", "bot.voice.notifications@Nova"]},
  {"q": "notify", "ctx": "app", "first": "general.notifications"},
  {"q": "notifies", "ctx": "app", "first": "general.notifications"},
  {"q": "notification", "ctx": "app", "first": "general.notifications"},
  {"q": "notifcations", "ctx": "app", "first": "general.notifications", "top5": ["general.notifications", "bot.voice.notifications@Nova"]},
  {"q": "notif", "ctx": "bot:Rex", "first": "bot.voice.notifications@Rex", "top5": ["bot.voice.notifications@Rex", "general.notifications"]},
  {"q": "back", "ctx": "app", "first": "about.previous-version", "top5": ["about.previous-version", "backups.backups", "general.startup"]},
  {"q": "telegram", "ctx": "app", "first": "channels.telegram"},
  {"q": "telegarm", "ctx": "app", "first": "channels.telegram"},
  {"q": "working fodler", "ctx": "app", "first": "bot.access.folder@Nova", "top5": ["bot.access.folder@Nova", "bot.access.folder@Rex", "bot.access.folder@Ivy"]},
  {"q": "fodler", "ctx": "bot:Rex", "first": "bot.access.folder@Rex", "top5": ["bot.access.folder@Rex", "bot.access.folder@Nova", "memory.audience"]},
  {"q": "nova email", "ctx": "app", "first": "bot.email.email@Nova", "top5": ["bot.email.email@Nova"]},
  {"q": "nova email", "ctx": "bot:Rex", "first": "bot.email.email@Nova", "top5": ["bot.email.email@Nova"]},
  {"q": "bot email", "ctx": "app", "first": "connections.bot-email", "top5": ["connections.bot-email", "bot.email.email@Nova", "bot.email.email@Rex"]},
  {"q": "rex model", "ctx": "app", "first": "bot.model.model@Rex", "top5": ["bot.model.model@Rex", "bot.model.effort@Rex"]},
  {"q": "command line", "ctx": "app", "first": "models.command-lines"},
  {"q": "api key", "ctx": "app", "first": "models.paste-keys", "top5": ["models.providers", "connections.apps", "webSearch.provider-keys"]},
  {"q": "model", "ctx": "app", "first": "models.providers", "top5": ["models.providers", "bot.model.model@Nova", "models.catalogs"]},
  {"q": "permission", "ctx": "app", "first": "bot.permissions.level@Nova", "top5": ["bot.permissions.level@Nova", "bot.permissions.can-talk@Nova"]},
  {"q": "workspace", "ctx": "app", "first": "bot.access.folder@Nova"},
  {"q": "sandbox", "ctx": "app", "first": "companion.computer", "top5": ["companion.computer", "bot.access.computer@Nova"]},
  {"q": "mobile", "ctx": "app", "first": "companion.pairing", "top5": ["companion.pairing", "bot.access.phone@Nova"]},
  {"q": "mail", "ctx": "app", "first": "connections.bot-email", "top5": ["connections.bot-email", "bot.email.email@Nova"]},
  {"q": "sound", "ctx": "app", "first": "general.notifications", "top5": ["general.notifications", "bot.voice.notifications@Nova"]},
  {"q": "picture", "ctx": "app", "first": "webSearch.images", "top5": ["webSearch.images", "bot.identity.avatar@Nova", "bot.permissions.images@Nova"]},
  {"q": "transcribe", "ctx": "app", "first": "webSearch.voice"},
  {"q": "dark", "ctx": "app", "first": "general.appearance"},
  {"q": "login", "ctx": "app", "first": "general.startup"},
  {"q": "tokens", "ctx": "app", "first": "usage.by-bot", "top5": ["usage.by-bot", "usage.learning", "bot.usage.usage@Nova"]},
  {"q": "search", "ctx": "app", "first": "webSearch.search", "top5": ["webSearch.search", "memory.reindex", "webSearch.provider-keys"]},
  {"q": "phone", "ctx": "phone", "first": "bot.access.phone@Nova", "top5": ["bot.access.phone@Nova", "bot.access.phone@Rex", "bot.access.phone-for-bots@Nova"]},
  {"q": "tool", "ctx": "phone", "first": "bot.skills.skills@Nova", "top5": ["bot.skills.skills@Nova", "bot.access.phone@Nova"]},
];

describe("the 40-query table", () => {
  it("has 40 rows", () => expect(TABLE).toHaveLength(40));
  it.each(TABLE)("$q ($ctx) -> $first", ({ q, ctx, first, top5 }) => {
    const ids = searchSettingsIndex(q, CONTEXT[ctx]).hits.map(idOf);
    expect(ids[0]).toBe(first);
    for (const id of top5 ?? []) expect(ids.slice(0, 5), id).toContain(id);
  });
});

describe("the ranker", () => {
  it("caps at 12 and keeps the rest for More results, in order", () => {
    const { hits, more } = searchSettingsIndex("bot", CONTEXT.app);
    expect(hits).toHaveLength(SETTINGS_RESULT_CAP);
    expect(more.length).toBeGreaterThan(0);
  });

  it("needs every word of a multi-word query on the same entry", () => {
    const ids = searchSettingsIndex("nova email", CONTEXT.app).hits.map(idOf);
    expect(ids[0]).toBe("bot.email.email@Nova");
    expect(ids.every((id) => id.endsWith("@Nova")), ids.join()).toBe(true);
    expect(searchSettingsIndex("telegram backup", CONTEXT.app).hits).toEqual([]);
  });

  it("finds nothing for an empty query and lists no bot rows without bots", () => {
    expect(searchSettingsIndex("   ", CONTEXT.app)).toEqual({ hits: [], more: [] });
    const appOnly = searchSettingsIndex("working folder", { desktop: true, cloud: false });
    expect(appOnly.hits.every((hit) => hit.entry.scope === "app")).toBe(true);
  });

  it("lists a computer-only card in a Cloud window, where it renders a stub", () => {
    const ids = searchSettingsIndex("start at login", { desktop: true, cloud: true, bots: BOTS }).hits.map(idOf);
    expect(ids[0]).toBe("general.startup");
  });

  it("keeps the app card search on the same ranker, uncapped", () => {
    expect(searchSettingsCards("notify", true)[0].card.id).toBe("general.notifications");
    expect(searchSettingsCards("telegarm", true)[0].card.id).toBe("channels.telegram");
    expect(searchSettingsCards("memory", true).length).toBeGreaterThan(SETTINGS_RESULT_CAP);
  });
});
