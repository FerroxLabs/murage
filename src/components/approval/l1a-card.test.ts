// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX-TRUST-MOMENTS-1012 test 11 (client): the card. The verb table;
// [Don't {verb}] [{verb} ▾]; the caret only when foldScopes returns a row;
// the rows per class fixture in the card's words; the why-line per class;
// the outcome line says Approved, never Sent; Undo for 8 s then Take back;
// a partial removal says what remains.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const surface = vi.hoisted(() => ({ desktop: true as boolean | undefined, native: false }));
vi.mock("@/lib/use-surface", () => ({ useDesktopSurface: () => surface.desktop, useSurfaceState: () => ({ desktop: surface.desktop, confirmed: true }) }));
vi.mock("@/lib/native-shell", () => ({ inNativeShell: () => surface.native }));
vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  const store = { state: { bots: [], routines: [], instances: [] }, dispatch: () => undefined };
  return { ...actual, useStore: () => store, useStoreIfAny: () => store };
});

import type { Bot, Message } from "@/state/store";
import type { CardClass } from "../../../shared/fold-scopes";
import { cardFoldRows, cardVerb, foldRowWords, type FoldCard } from "@/lib/fold-words";
import { PendingApprovalActions, whyLine, type Pending } from "@/components/PendingApproval";
import { ApprovalCard } from "@/components/ApprovalCard";
import { GrantFold } from "./GrantFold";
import { grantAddedFor, noteGrantAdded, removeRequest, resetGrantAdded, takeBackAdded } from "@/lib/grant-added";

const cls = (extra: Partial<CardClass>): CardClass => ({ reason: "stop-line", unattended: false, automated: false, keys: [], ...extra });
const PUBLIC: FoldCard = {
  tool: "other",
  cardClass: cls({ stop: { kind: "message", public: true, placed: true, places: 1 }, keys: ["taskAllowKey", "allowKey"] }),
  taskAllowKey: "stop:public:github:ferrox/murage",
  allowKey: "stop:public:github:ferrox/murage",
};
const DELETE_FOLDER: FoldCard = {
  tool: "Bash",
  cardClass: cls({ stop: { kind: "delete", public: false, placed: true, places: 1 }, keys: ["taskAllowKey", "allowKey"] }),
  taskAllowKey: "stop:delete:/Users/ada/Projects/site/build",
  allowKey: "stop:delete:/Users/ada/Projects/site/build",
};
const PAY: FoldCard = {
  tool: "other",
  cardClass: cls({ stop: { kind: "pay", public: false, placed: true, places: 1 }, keys: ["taskAllowKey"] }),
  taskAllowKey: "stop:pay:stripe:Brightline",
};
const NEW_PERSON: FoldCard = {
  tool: "other",
  cardClass: cls({ stop: { kind: "message", public: false, placed: true, places: 1 }, keys: [] }),
  allowKey: "app-action:GMAIL_SEND_EMAIL",
};
const COMMAND: FoldCard = {
  tool: "Bash",
  cardClass: cls({ reason: "no-grant", keys: ["allowKey", "exactAllowKey"] }),
  allowKey: "Bash:git",
  exactAllowKey: undefined,
};
const SET: FoldCard = {
  tool: "other",
  cardClass: cls({ reason: "no-grant", keys: ["allowKeys"] }),
  allowKeys: ["app-action:GMAIL_FETCH_EMAILS", "app-action:GOOGLECALENDAR_EVENTS_LIST"],
};
const GUARD: FoldCard = { tool: "Bash", cardClass: cls({ reason: "destructive-guard", keys: [] }) };
const UNREAD: FoldCard = { tool: "Bash", cardClass: cls({ reason: "unread-call", keys: [] }) };
const UNATTENDED: FoldCard = { tool: "Bash", cardClass: cls({ reason: "no-grant", unattended: true, keys: ["allowKey"] }), allowKey: "Bash:git" };

describe("1.1 the verb table", () => {
  it("takes the verb from the class, then the key, then the tool", () => {
    expect(cardVerb(PUBLIC)).toBe("post");
    expect(cardVerb(DELETE_FOLDER)).toBe("delete");
    expect(cardVerb(PAY)).toBe("pay");
    expect(cardVerb(NEW_PERSON)).toBe("send");
    expect(cardVerb(COMMAND)).toBe("run");
    expect(cardVerb({ tool: "other", allowKey: "app-action:GMAIL_SEND_EMAIL" })).toBe("send");
    expect(cardVerb({ tool: "other", allowKey: "app-action:GMAIL_REPLY_TO_THREAD" })).toBe("reply");
    expect(cardVerb({ tool: "other", allowKey: "ask_bot:@Helper" })).toBe("ask");
    expect(cardVerb({ tool: "WebFetch" })).toBe("open");
    expect(cardVerb({ tool: "Read" })).toBe("allow");
    // an older card's stop key still names the kind
    expect(cardVerb({ tool: "other", taskAllowKey: "stop:pay:stripe:x" })).toBe("pay");
  });
});

describe("1.2 and 1.3: rows per class, in the card's words", () => {
  const words = (card: FoldCard) => cardFoldRows(card).map((row) => foldRowWords(row, { bot: "Nova" }));
  it("a public post offers the task row, then Always for posts on the place", () => {
    expect(words(PUBLIC)).toEqual(["For 12 hours in this conversation, on github:ferrox/murage", "Always, for posts on github:ferrox/murage"]);
  });
  it("a delete in a folder names the folder and its subfolders", () => {
    expect(words(DELETE_FOLDER)).toEqual([
      "For 12 hours in this conversation, in /Users/ada/Projects/site/build",
      "Always, for deleting in /Users/ada/Projects/site/build (covers its subfolders)",
    ]);
  });
  it("a payment offers the 12-hour row only, never Always", () => {
    expect(words(PAY)).toEqual(["For 12 hours in this conversation, to Brightline"]);
  });
  it("someone new, a guard, an unread call and an unattended turn offer nothing", () => {
    for (const card of [NEW_PERSON, GUARD, UNREAD, UNATTENDED]) expect(cardFoldRows(card)).toEqual([]);
  });
  it("a command at Ask offers its program; a set is remembered whole", () => {
    expect(words(COMMAND)).toEqual(["Always, any git command Nova runs"]);
    expect(words(SET)).toEqual(["Always, for these 2 actions: Gmail: fetch emails, Google Calendar: events list"]);
  });
  it("bot-level rows are desktop rows; task rows work on the phone too", () => {
    expect(cardFoldRows(PUBLIC).map((row) => row.surface)).toEqual(["any", "desktop"]);
  });
});

type CardFixture = FoldCard & { why?: { key: string; params: Record<string, string | number> } };
function pending(card: CardFixture): Pending {
  const message = {
    id: "m1", role: "bot", kind: "options", at: 1, from: { botId: "b1", name: "Nova" },
    card: { title: "Approval", subtitle: "do it", options: ["Allow", "Deny"], requestId: "req-1", ...card },
  } as unknown as Message;
  return { message, requestId: "req-1", tool: card.tool ?? "other", detail: "do it", allowKey: card.allowKey };
}
const BOT = { id: "b1", name: "Nova", autoApprove: true, threadId: "t1" } as unknown as Bot;
const actions = (card: CardFixture) =>
  renderToStaticMarkup(createElement(PendingApprovalActions, { pending: pending(card), threadId: "t1", bot: BOT, onCancelTurn: () => undefined }));

describe("1.1 the card's buttons and why-line", () => {
  beforeEach(() => { surface.desktop = true; surface.native = false; });
  it("shows [Don't {verb}] then [{verb}] with the caret when a row exists; no separate Allow once", () => {
    const html = actions({ ...PUBLIC, why: { key: "ux.l1.why.messagePublic", params: { bot: "Nova", where: "github:ferrox/murage" } } });
    expect(html).toContain("Don&#x27;t post");
    expect(html).toMatch(/>Post</);
    expect(html).toContain("data-fold-caret");
    expect(html.indexOf("Don&#x27;t post")).toBeLessThan(html.indexOf(">Post<"));
    expect(html).not.toContain("Allow once");
    expect(html).not.toContain("More ways to allow");
    expect(html).toContain("Nova asked because this posts in public on github:ferrox/murage.");
    expect(html).toContain("Stop asking for this");
  });
  it("has no caret and no Stop asking link when the class offers nothing", () => {
    const html = actions({ ...NEW_PERSON, why: { key: "ux.l1.why.messageNew", params: { bot: "Nova", name: "Dana" } } });
    expect(html).not.toContain("data-fold-caret");
    expect(html).not.toContain("Stop asking for this");
    expect(html).toContain("Nova asked because Dana is someone new. Once this goes, Dana counts as known.");
    expect(html).toMatch(/>Send</);
  });
  it("an unread call asks with the verb, never blocks, and offers no fold", () => {
    const html = actions({ ...UNREAD, why: { key: "ux.l1.why.unreadCall", params: {} } });
    expect(html).toMatch(/>Run</);
    expect(html).toContain("Don&#x27;t run");
    expect(html).not.toContain("data-fold-caret");
    expect(html).toContain("Murage could not read this whole, so it asks. Allow it once if it is right.");
  });
  it("on the phone app the fold opens from a link, not a caret", () => {
    surface.desktop = false; surface.native = true;
    const html = actions(PUBLIC);
    expect(html).not.toContain("data-fold-caret");
    expect(html).toContain("Post and stop asking…");
  });
  it("whyLine reads only ux.l1.why keys", () => {
    expect(whyLine({ why: { key: "settings.title", params: {} } } as unknown as Message["card"])).toBeUndefined();
    expect(whyLine({ why: { key: "ux.l1.why.fromANewerServer", params: {} } } as unknown as Message["card"])).toBeUndefined();
    expect(whyLine({ why: { key: "ux.l1.why.alwaysAsk", params: {} } } as unknown as Message["card"])).toBe("This could wipe this computer, so Murage asks every time, at every level.");
  });
});

describe("1.3 and 1.5: the fold", () => {
  const fold = (desktop: boolean) => renderToStaticMarkup(createElement(GrantFold, {
    id: "f", rows: cardFoldRows(PUBLIC), bot: "Nova", level: "Auto", verb: "Post", desktop, variant: desktop ? "menu" : "sheet", busy: null, onChoose: () => undefined, onClose: () => undefined,
  }));
  it("ends with the desktop footer", () => {
    const html = fold(true);
    expect(html).toContain("Nova stays on Auto. Take any of these back under Nova › Level.");
    expect(html).not.toContain("Give this on your computer");
  });
  it("on the phone greys the bot-level row and keeps the task row", () => {
    const html = fold(false);
    expect(html).toContain("Give this on your computer");
    expect(html).toContain("Nova stays on Auto. Take back this conversation&#x27;s and routine choices here; bot-level ones on your computer.");
    expect(html).toMatch(/data-fold-scope="task"><button[^>]*type="button"(?![^>]*aria-disabled)/);
    expect(html).toMatch(/data-fold-scope="bot"><button[^>]*aria-disabled="true"/);
    expect(html).toContain('role="dialog"');
  });
});

const settled = (answered: string, requestId = "req-9") => ({
  id: "m9", role: "bot", kind: "options", at: 1, from: { botId: "b1", name: "Nova" },
  card: { title: "Approval", subtitle: "post", options: [], tool: "other", requestId, answered },
} as unknown as Message);
const outcome = (message: Message) => renderToStaticMarkup(createElement(ApprovalCard, { bot: BOT, message }));

describe("1.1 and 1.3: the outcome line", () => {
  afterEach(() => { resetGrantAdded(); vi.useRealTimers(); });
  it("says Approved, never Sent; Denied; and who stopped waiting", () => {
    const approved = outcome(settled("allow"));
    expect(approved).toContain("Approved");
    expect(approved).not.toMatch(/Sent|Allowed/);
    expect(outcome(settled("deny"))).toContain("Denied");
    expect(outcome(settled("unavailable"))).toContain("Nova stopped waiting for this. Ask it again.");
  });
  it("names what was added with Undo for 8 s, then Take back", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    noteGrantAdded({ threadId: "t1", requestId: "req-9", botId: "b1", scope: "bot", keys: ["stop:public:github:ferrox/murage"], words: "Always, for posts on github:ferrox/murage" });
    const now = outcome(settled("allow"));
    expect(now).toContain("Approved. Nova stops asking: Always, for posts on github:ferrox/murage.");
    expect(now).toMatch(/>Undo</);
    vi.setSystemTime(108_001);
    expect(outcome(settled("allow"))).toMatch(/>Take back</);
  });
  it("claims nothing when the bot already had it", () => {
    noteGrantAdded({ threadId: "t1", requestId: "req-9", botId: "b1", scope: "bot", keys: [], words: "Always, for Read" });
    const html = outcome(settled("allow"));
    expect(html).toContain("Approved. Nova already had this, so nothing new was added.");
    expect(html).not.toMatch(/>Undo</);
  });
  it("removes exactly what was added, one call per key, and says which remain", async () => {
    const keys = ["app-action:GMAIL_FETCH_EMAILS", "app-action:GOOGLECALENDAR_EVENTS_LIST"];
    noteGrantAdded({ threadId: "t1", requestId: "req-9", botId: "b1", scope: "routine", routineId: "r1", keys, words: "Always, when Morning brief runs" });
    const calls: string[] = [];
    const partial = await takeBackAdded("req-9", async (path, body) => {
      calls.push(`${path} ${body.key}`);
      if (body.key === keys[1]) throw new Error("no");
      return {};
    });
    expect(calls).toEqual(keys.map((key) => `/api/routines/r1/always-allow/remove ${key}`));
    expect(partial?.state).toBe("partial");
    expect(partial?.remaining).toEqual([keys[1]]);
    const html = outcome(settled("allow"));
    expect(html).toContain("Some of this was not taken back. Still kept: Google Calendar: events list.");
    expect(html).toMatch(/>Try again</);
    const retried: string[] = [];
    const done = await takeBackAdded("req-9", async (_path, body) => { retried.push(body.key as string); return {}; });
    expect(retried).toEqual([keys[1]]);
    expect(done?.state).toBe("taken");
    expect(outcome(settled("allow"))).toContain("Taken back. Anything already done stays done.");
    expect(grantAddedFor("req-9")?.state).toBe("taken");
  });
  it("routes each scope to its own remove route", () => {
    expect(removeRequest({ scope: "task", botId: "b1", threadId: "t1" }, "stop:pay:x:y")).toEqual({ path: "/api/bots/b1/task-allow/remove", body: { threadId: "t1", key: "stop:pay:x:y" } });
    expect(removeRequest({ scope: "routine", botId: "b1", threadId: "t1", routineId: "r1" }, "k")).toEqual({ path: "/api/routines/r1/always-allow/remove", body: { key: "k" } });
    // a bot key goes back through the bot's Undo route by holder, never the remove-everywhere route
    expect(removeRequest({ scope: "bot", botId: "b1", threadId: "t1" }, "k")).toEqual({ path: "/api/bots/b1/always-allow/undo", body: { bot: ["k"], task: [] } });
  });
  it("Astra r1 item 4, Fable H2: a bot save's Undo takes back each key from the holder that gained it, in one call", async () => {
    // the bot's defaults already held Read; only this task gained it, and the defaults gained Grep
    noteGrantAdded({ threadId: "t1", requestId: "req-9", botId: "b1", scope: "bot", keys: [], holders: { bot: ["Grep"], task: ["Read", "Grep"], taskThreadId: "t1" }, words: "Always, for Read" });
    expect(grantAddedFor("req-9")?.keys).toEqual(["Grep", "Read"]);
    const calls: { path: string; body: unknown }[] = [];
    const done = await takeBackAdded("req-9", async (path, body) => { calls.push({ path, body }); return {}; });
    expect(calls).toEqual([{ path: "/api/bots/b1/always-allow/undo", body: { threadId: "t1", bot: ["Grep"], task: ["Read", "Grep"] } }]);
    expect(calls.some((call) => call.path.endsWith("/always-allow/remove"))).toBe(false);
    expect(done?.state).toBe("taken");
    // a failed Undo keeps every key and retries the same holders
    noteGrantAdded({ threadId: "t1", requestId: "req-10", botId: "b1", scope: "bot", keys: [], holders: { bot: [], task: ["Read"], taskThreadId: "t1" }, words: "Always, for Read" });
    const failed = await takeBackAdded("req-10", async () => { throw new Error("no"); });
    expect(failed?.remaining).toEqual(["Read"]);
    const again: unknown[] = [];
    await takeBackAdded("req-10", async (_path, body) => { again.push(body); return {}; });
    expect(again).toEqual([{ threadId: "t1", bot: [], task: ["Read"] }]);
  });
  it("on the phone a bot-level grant is taken back on the computer", () => {
    surface.desktop = false; surface.native = true;
    noteGrantAdded({ threadId: "t1", requestId: "req-9", botId: "b1", scope: "bot", keys: ["Read"], words: "Always, for Read" });
    const html = outcome(settled("allow"));
    expect(html).toContain("Take this back on your computer, under Nova › Level.");
    expect(html).not.toMatch(/>Undo</);
    surface.desktop = true; surface.native = false;
  });
});
