// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.2 P1 (tutorial filming): two Google Calendar events made through a
// connected app were real, yet the reply got the unmatched-action note. The
// relay kept a receipt, but GOOGLECALENDAR_CREATE_EVENT matched no class in the
// hand list, so the receipt was empty. Connected-app actions are now read by
// their slug's words: a completed action carries the classes a plain reply
// would claim for it, lookups carry none, and the bot's own tools keep the list.
import { describe, expect, it } from "vitest";
import { ConnectedAppReceipts, answeredActionClasses } from "./connected-app-receipts.ts";
import { checkReplyActions, connectedAppActionClasses, connectedAppSlug, toolAction } from "./reply-action-guard.ts";
import type { Message } from "./store.ts";
import { detectActionClaims, type ActionClass } from "../shared/reply-action-claims.ts";
import { CONNECTED_APP_ACTION_TABLE, CONNECTED_APP_ACTIONS } from "../shared/connected-app-action-table.ts";
import { VERIFIED_READ_TOOLS } from "../shared/connected-app-readonly.ts";

/** The relay's answer to one wrapper call that ran `slugs`, every one successful unless listed in `failed`. */
const answer = (slugs: string[], failed: string[] = []) => ({
  jsonrpc: "2.0", id: 1,
  result: { content: [{ type: "text", text: JSON.stringify({ successful: true, data: { results: slugs.map((tool_slug, index) => ({ tool_slug, index, response: failed.includes(tool_slug) ? { successful: false, error: "rejected" } : { successful: true, data: {} } })) } }) }] },
});
const wrapperArgs = (slugs: string[]) => ({ tools: slugs.map(tool_slug => ({ tool_slug, arguments: {} })) });

const sorted = (classes: Iterable<ActionClass>) => [...classes].sort();

// Real slugs from the connected-app catalogue, with every class a reply about them may claim.
const ACTIONS: Array<[string, ActionClass[]]> = [
  ["GOOGLECALENDAR_CREATE_EVENT", ["save", "schedule"]],
  ["GOOGLECALENDAR_QUICK_ADD", ["save", "schedule"]],
  ["GOOGLECALENDAR_UPDATE_EVENT", ["change", "save", "schedule"]],
  ["GOOGLECALENDAR_PATCH_EVENT", ["change", "save", "schedule"]],
  ["GOOGLECALENDAR_EVENTS_MOVE", ["change"]],
  ["GOOGLECALENDAR_DELETE_EVENT", ["delete"]],
  ["OUTLOOK_CALENDAR_CREATE_EVENT", ["save", "schedule"]],
  ["OUTLOOK_UPDATE_CALENDAR_EVENT", ["change", "save", "schedule"]],
  ["OUTLOOK_CANCEL_EVENT", ["delete"]],
  ["GMAIL_CREATE_EMAIL_DRAFT", ["save"]],
  ["GMAIL_SEND_EMAIL", ["send"]],
  ["GMAIL_REPLY_TO_THREAD", ["send"]],
  ["GMAIL_FORWARD_MESSAGE", ["send"]],
  ["GMAIL_SEND_DRAFT", ["send"]],
  ["GMAIL_DELETE_DRAFT", ["delete"]],
  ["GMAIL_MOVE_TO_TRASH", ["delete"]],
  ["OUTLOOK_SEND_EMAIL", ["send"]],
  ["OUTLOOK_REPLY_EMAIL", ["send"]],
  ["OUTLOOK_DELETE_MESSAGE", ["delete"]],
  ["SLACK_SEND_MESSAGE", ["send"]],
  ["SLACK_CHAT_POST_MESSAGE", ["send"]],
  ["SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL", ["send"]],
  ["SLACK_SCHEDULE_MESSAGE", ["save", "schedule"]],
  ["SLACK_DELETES_A_MESSAGE_FROM_A_CHAT", ["delete"]],
  ["DISCORDBOT_CREATE_MESSAGE", ["send"]],
  ["MICROSOFT_TEAMS_TEAMS_POST_CHAT_MESSAGE", ["send"]],
  ["GOOGLEDRIVE_UPLOAD_FILE", ["save"]],
  ["GOOGLEDRIVE_CREATE_FILE_FROM_TEXT", ["save"]],
  ["GOOGLEDRIVE_DELETE_FILE", ["delete"]],
  ["GOOGLEDOCS_CREATE_DOCUMENT", ["save"]],
  ["GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND", ["change", "save"]],
  ["NOTION_CREATE_NOTION_PAGE", ["save"]],
  ["NOTION_ADD_PAGE_CONTENT", ["change", "save"]],
  ["NOTION_UPDATE_PAGE", ["change", "save"]],
  ["DROPBOX_UPLOAD_FILE", ["save"]],
  ["ONE_DRIVE_DELETE_ITEM", ["delete"]],
  ["GITHUB_CREATE_AN_ISSUE", ["save"]],
  ["LINEAR_UPDATE_ISSUE", ["change", "save"]],
  ["TRELLO_DELETE_CARDS_BY_ID_CARD", ["delete"]],
  ["ASANA_CREATE_A_TASK", ["save"]],
  ["HUBSPOT_CREATE_CONTACT", ["save"]],
  // not in the table: only the three exact endings prove anything
  ["ZOHOMAIL_SEND_EMAIL", ["send"]],
  ["TELEGRAM_SEND_MESSAGE", ["send"]],
  ["CALENDLY_CREATE_EVENT", []],
  ["ZOHOMAIL_CREATE_DRAFT", ["save"]],
  ["TWITTER_CREATION_OF_A_POST", []],
  ["STRIPE_CREATE_REFUND", []],
  ["CALENDLY_CREATE_EVENT_ATTACHMENT", []],
];
const LOOKUPS = [
  "GOOGLECALENDAR_FIND_EVENT", "GOOGLECALENDAR_EVENTS_LIST", "GOOGLECALENDAR_FIND_FREE_SLOTS", "GOOGLECALENDAR_LIST_CALENDARS",
  "GMAIL_FETCH_EMAILS", "GMAIL_LIST_DRAFTS", "GMAIL_FETCH_MESSAGE_BY_THREAD_ID", "SLACK_SEARCH_MESSAGES",
  "GOOGLEDRIVE_FIND_FILE", "NOTION_QUERY_DATABASE", "GITHUB_GET_A_REPOSITORY",
];

describe("a connected-app action carries the classes a reply would claim for it", () => {
  it.each(ACTIONS)("%s", (slug, classes) => {
    expect(sorted(connectedAppActionClasses(slug))).toEqual(classes);
    // through the relay's receipt, the way every engine's call is counted
    expect(sorted(answeredActionClasses("COMPOSIO_MULTI_EXECUTE_TOOL", wrapperArgs([slug]), answer([slug])))).toEqual(classes);
    // and as an engine's own tool row
    expect(sorted(toolAction("COMPOSIO_MULTI_EXECUTE_TOOL", true, wrapperArgs([slug]), JSON.parse(answer([slug]).result.content[0]!.text)).classes)).toEqual(classes);
  });
  it.each(LOOKUPS)("a lookup carries none: %s", slug => {
    expect(connectedAppActionClasses(slug)).toEqual([]);
    expect(answeredActionClasses("COMPOSIO_MULTI_EXECUTE_TOOL", wrapperArgs([slug]), answer([slug]))).toEqual([]);
  });
  it("a failed action carries none", () => {
    expect(answeredActionClasses("COMPOSIO_MULTI_EXECUTE_TOOL", wrapperArgs(["GOOGLECALENDAR_CREATE_EVENT"]), answer(["GOOGLECALENDAR_CREATE_EVENT"], ["GOOGLECALENDAR_CREATE_EVENT"]))).toEqual([]);
  });
  it("the session tools are never app actions", () => {
    for (const name of ["COMPOSIO_SEARCH_TOOLS", "APPS_SEARCH_TOOLS", "COMPOSIO_CREATE_PLAN", "APPS_MANAGE_CONNECTIONS", "CHECK_CONNECTED_APP_ACTION"]) {
      expect(connectedAppSlug(name)).toBeUndefined();
      expect(toolAction(name, true).classes).toEqual([]);
    }
  });
});

describe("every name an engine uses for the wrapper and the action", () => {
  const slugs = ["GOOGLECALENDAR_CREATE_EVENT"];
  it.each([
    "COMPOSIO_MULTI_EXECUTE_TOOL", "APPS_MULTI_EXECUTE_TOOL", "mcp__connected_apps__APPS_MULTI_EXECUTE_TOOL",
    "connected_apps__APPS_MULTI_EXECUTE_TOOL", "connected_apps:APPS_MULTI_EXECUTE_TOOL", "connected_apps_apps_multi_execute_tool",
    "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL", "murage_connectors__APPS_MULTI_EXECUTE_TOOL",
  ])("wrapper %s", name => {
    expect(sorted(answeredActionClasses(name, wrapperArgs(slugs), answer(slugs)))).toEqual(["save", "schedule"]);
  });
  it.each([
    "GOOGLECALENDAR_CREATE_EVENT", "mcp__connected_apps__GOOGLECALENDAR_CREATE_EVENT", "connected_apps:GOOGLECALENDAR_CREATE_EVENT",
    "Connected app: Googlecalendar create event",
  ])("action %s", name => {
    expect(sorted(toolAction(name, true, undefined, { successful: true }).classes)).toEqual(["save", "schedule"]);
    expect(toolAction(name, true).outcome).toBe("completed");
  });
  it("a wrapper naming the action by tool_name", () => {
    expect(sorted(toolAction("execute_tool", true, { tool_name: "GMAIL_CREATE_EMAIL_DRAFT", arguments: {} }).classes)).toEqual(["save"]);
  });
});

describe("the bot's own tools keep the exact list", () => {
  it.each([
    ["create_note", []], ["update_memory", []], ["TodoWrite", []], ["googlecalendar_create_event", []], ["Gmail: send email", []],
    ["send_message", ["send"]], ["write_file", ["save"]], ["create_routine", ["schedule"]], ["edit", ["save", "change"]],
  ] as Array<[string, ActionClass[]]>)("%s", (name, classes) => {
    expect(toolAction(name, true).classes).toEqual(classes);
  });
});

let n = 0;
const row = (over: Partial<Message>): Message => ({ id: `r${++n}`, at: n, role: "bot", kind: "text", from: { botId: "ember", name: "Ember", color: "" }, ...over }) as Message;
function check(text: string, relayed: Iterable<ActionClass>) {
  const owner = row({ role: "user", text: "Put the two meetings on my calendar.", from: undefined });
  const reply = row({ text, turnId: "turn-1", turnTerminal: true });
  return checkReplyActions({ reply, path: [owner, reply], relayed });
}
/** Receipts the relay keeps for the calls one turn made, each a separate wrapper call. */
function receiptsFor(...calls: string[][]) {
  const receipts = new ConnectedAppReceipts();
  for (const slugs of calls) receipts.record({ threadId: "th", botId: "ember", generation: "gen-1", classes: answeredActionClasses("APPS_MULTI_EXECUTE_TOOL", wrapperArgs(slugs), answer(slugs)) });
  return receipts.forTurn({ threadId: "th", generation: "gen-1" });
}

describe("the reply check, from the relay's receipts", () => {
  it("two calendar events made: \"I've added both events to your calendar.\" gets no note", () => {
    const result = check("I've added both events to your calendar.", receiptsFor(["GOOGLECALENDAR_CREATE_EVENT"], ["GOOGLECALENDAR_CREATE_EVENT"]));
    expect(result.state).toBe("recorded");
    expect(result.claims.filter(claim => claim.state === "flagged")).toEqual([]);
  });
  it("the same reply with no receipts still gets the note", () => {
    const result = check("I've added both events to your calendar.", receiptsFor());
    expect(result.state).toBe("flagged");
    expect(result.claims[0]).toMatchObject({ class: "schedule", state: "flagged" });
  });
  it("the same reply after only a lookup still gets the note", () => {
    expect(check("I've added both events to your calendar.", receiptsFor(["GOOGLECALENDAR_FIND_EVENT"])).state).toBe("flagged");
  });
  it.each([
    ["I've created two events on your calendar.", ["GOOGLECALENDAR_CREATE_EVENT", "GOOGLECALENDAR_CREATE_EVENT"]],
    ["Scheduled for Monday at 10.", ["GOOGLECALENDAR_QUICK_ADD"]],
    ["I've updated the meeting to 3pm.", ["GOOGLECALENDAR_UPDATE_EVENT"]],
    ["Deleted the event.", ["GOOGLECALENDAR_DELETE_EVENT"]],
    ["I've saved three drafts for you to review.", ["GMAIL_CREATE_EMAIL_DRAFT", "GMAIL_CREATE_EMAIL_DRAFT", "GMAIL_CREATE_EMAIL_DRAFT"]],
    ["Sent.", ["GMAIL_SEND_EMAIL"]],
    ["I replied to Ana.", ["GMAIL_REPLY_TO_THREAD"]],
    ["I posted it in #general.", ["SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL"]],
    ["I uploaded the file to your Drive.", ["GOOGLEDRIVE_UPLOAD_FILE"]],
    ["I created the page in Notion.", ["NOTION_CREATE_NOTION_PAGE"]],
  ])("%s", (text, slugs) => {
    expect(check(text, receiptsFor(slugs)).state).toBe("recorded");
    expect(check(text, receiptsFor()).state).toBe("flagged");
  });
  it("an action never covers a claim of another kind", () => {
    expect(check("I sent the invite to Ana.", receiptsFor(["GOOGLECALENDAR_CREATE_EVENT"])).state).toBe("flagged");
    expect(check("Sent.", receiptsFor(["GMAIL_CREATE_EMAIL_DRAFT"])).state).toBe("flagged");
    expect(check("Deleted the event.", receiptsFor(["GOOGLECALENDAR_UPDATE_EVENT"])).state).toBe("flagged");
  });
});

describe("putting something on a calendar is a schedule claim", () => {
  it.each([
    "I've added both events to your calendar.",
    "I added the dentist appointment to your calendar.",
    "I put the call on your calendar.",
    "I added a reminder to your schedule.",
    "I added the meeting to your calendar for Tuesday at 10.",
    "Found the dentist appointment. I put it on your calendar.",
    "I created the meeting with Ana and I put it on my calendar.",
  ])("%s", text => {
    expect(detectActionClaims(text).claims.map(claim => claim.class)).toContain("schedule");
  });
  it.each([
    "I haven't added it to your calendar yet.",
    "I'll add it to your calendar.",
    "Should I add both events to your calendar?",
    "I added a note to the doc.",
    "I added a section to the agenda below.",
    "I added a link to your calendar in this reply.",
    "I added a link to the call to your calendar notes.",
    "I added example events to your calendar guide below.",
    "I put it on your calendar.",
    "Here is the guide. I put it on your calendar.",
  ])("not a schedule claim: %s", text => {
    expect(detectActionClaims(text).claims.map(claim => claim.class)).not.toContain("schedule");
  });
});

// Astra (rc13 actionclass, rounds 1 and 2): each repro, through every name an engine
// uses. An object word, an attachment, an extension, a rule or access never proves
// the claim; the real action does.
const WRAPPERS = ["APPS_MULTI_EXECUTE_TOOL", "COMPOSIO_MULTI_EXECUTE_TOOL", "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL", "connected_apps_apps_multi_execute_tool"];
const label = (slug: string) => `Connected app: ${slug.toLowerCase().replace(/_/g, " ")}`;
/** The classes one successful run of `slug` leaves, by every route: relay receipts and engine rows
 * through each wrapper, the direct name, a namespaced name, the plain label, and a generic tool_name wrapper. */
function everyRoute(slug: string): Array<[string, ActionClass[]]> {
  const output = JSON.parse(answer([slug]).result.content[0]!.text);
  return [
    ...WRAPPERS.flatMap(wrapper => [
      [`receipt ${wrapper}`, answeredActionClasses(wrapper, wrapperArgs([slug]), answer([slug]))],
      [`row ${wrapper}`, toolAction(wrapper, true, wrapperArgs([slug]), output).classes],
    ] as Array<[string, ActionClass[]]>),
    ...[slug, `mcp__connected_apps__${slug}`, label(slug)].map(name => [name, toolAction(name, true, undefined, { successful: true }).classes] as [string, ActionClass[]]),
    ["execute_tool", toolAction("execute_tool", true, { tool_name: slug, arguments: {} }).classes],
  ];
}

const NO_PROOF: Array<[string, ActionClass[]]> = [
  // round 1
  ["OUTLOOK_CREATE_DRAFT_REPLY", ["save"]],
  ["GMAIL_PATCH_SEND_AS", []],
  ["GOOGLECALENDAR_ACL_UPDATE", []],
  // round 2
  ["OUTLOOK_CREATE_EVENT_ATTACHMENT", []],
  ["OUTLOOK_UPDATE_EVENT_EXTENSION", []],
  ["OUTLOOK_DELETE_EMAIL_RULE", []],
  ["SLACK_DELETE_SLACK_LIST_ACCESS", []],
  // their neighbours in the catalogue
  ["OUTLOOK_CREATE_DRAFT", ["save"]],
  ["OUTLOOK_CREATE_FORWARD_DRAFT", ["save"]],
  ["GMAIL_UPDATE_DRAFT", ["change", "save"]],
  ["GMAIL_UPDATE_SEND_AS", []],
  ["GMAIL_CREATE_FILTER", []],
  ["GMAIL_ADD_LABEL_TO_EMAIL", []],
  ["GMAIL_UPDATE_VACATION_SETTINGS", []],
  ["GOOGLECALENDAR_ACL_INSERT", []],
  ["GOOGLECALENDAR_CALENDARS_UPDATE", []],
  ["GOOGLECALENDAR_PATCH_CALENDAR", []],
  ["GOOGLECALENDAR_CREATE_CALENDAR", []],
  ["GOOGLECALENDAR_CLEAR_CALENDAR", []],
  ["OUTLOOK_CREATE_CALENDAR_EVENT_ATTACHMENT", []],
  ["OUTLOOK_DELETE_CALENDAR_EVENT_ATTACHMENT", []],
  ["OUTLOOK_DELETE_EVENT_EXTENSION", []],
  ["OUTLOOK_UPDATE_EMAIL_RULE", []],
  ["OUTLOOK_UPDATE_MAILBOX_SETTINGS", []],
  ["OUTLOOK_CREATE_CALENDAR_PERMISSION", []],
  ["SLACK_SET_SLACK_LIST_ACCESS", []],
  ["SLACK_ARCHIVE_CONVERSATION", []],
  ["GOOGLEDRIVE_CREATE_PERMISSION", []],
  ["GOOGLEDRIVE_DELETE_PERMISSION", []],
  ["NOTION_SEND_FILE_UPLOAD", []],
  ["DISCORDBOT_CREATE_DM", []],
  ["MICROSOFT_TEAMS_SEND_ACTIVITY_NOTIFICATION", []],
];
describe("an action proves only what its exact slug carries", () => {
  it.each(NO_PROOF)("%s", (slug, classes) => {
    expect(sorted(connectedAppActionClasses(slug))).toEqual(classes);
    for (const [route, proven] of everyRoute(slug)) expect([route, sorted(proven)]).toEqual([route, classes]);
  });
  it.each([
    ["Sent.", "OUTLOOK_CREATE_DRAFT_REPLY"],
    ["I replied to Ana.", "OUTLOOK_CREATE_DRAFT_REPLY"],
    ["Sent.", "GMAIL_PATCH_SEND_AS"],
    ["Sent.", "GMAIL_CREATE_EMAIL_DRAFT"],
    ["I scheduled the meeting.", "GOOGLECALENDAR_ACL_UPDATE"],
    ["I've added both events to your calendar.", "GOOGLECALENDAR_ACL_UPDATE"],
    ["I scheduled the meeting.", "OUTLOOK_CREATE_EVENT_ATTACHMENT"],
    ["I scheduled the meeting.", "OUTLOOK_UPDATE_EVENT_EXTENSION"],
    ["I deleted the email.", "OUTLOOK_DELETE_EMAIL_RULE"],
    ["I deleted the file.", "SLACK_DELETE_SLACK_LIST_ACCESS"],
    ["I deleted the conversation.", "SLACK_ARCHIVE_CONVERSATION"],
    ["I sent the file.", "NOTION_SEND_FILE_UPLOAD"],
  ])("%s after only %s stays flagged, whatever the engine called it", (text, slug) => {
    expect(check(text, receiptsFor([slug])).state).toBe("flagged");
    for (const [route, proven] of everyRoute(slug)) expect([route, check(text, proven).state]).toEqual([route, "flagged"]);
  });
  it.each([
    ["I sent the message.", "DISCORDBOT_CREATE_MESSAGE"],
    ["I posted it in #general.", "DISCORDBOT_CREATE_MESSAGE"],
    ["Sent.", "OUTLOOK_SEND_EMAIL"],
    ["Sent.", "OUTLOOK_SEND_DRAFT"],
    ["Sent.", "GMAIL_SEND_DRAFT"],
    ["I replied to Ana.", "OUTLOOK_REPLY_EMAIL"],
    ["I posted it in the channel.", "MICROSOFT_TEAMS_TEAMS_POST_CHANNEL_MESSAGE"],
    ["I scheduled the meeting.", "GOOGLECALENDAR_CREATE_EVENT"],
    ["I scheduled the meeting.", "OUTLOOK_CALENDAR_CREATE_EVENT"],
    ["I scheduled the meeting.", "OUTLOOK_CREATE_ME_EVENT"],
    ["I've added both events to your calendar.", "GOOGLECALENDAR_QUICK_ADD"],
    ["I saved the draft.", "OUTLOOK_CREATE_DRAFT_REPLY"],
    ["I deleted the email.", "OUTLOOK_DELETE_MESSAGE"],
    ["I deleted the email.", "GMAIL_MOVE_TO_TRASH"],
    ["I deleted the file.", "SLACK_DELETE_FILE"],
    ["I deleted the event.", "OUTLOOK_DELETE_CALENDAR_EVENT"],
  ])("%s after %s is recorded, whatever the engine called it", (text, slug) => {
    expect(check(text, receiptsFor([slug])).state).toBe("recorded");
    for (const [route, proven] of everyRoute(slug)) expect([route, check(text, proven).state]).toEqual([route, "recorded"]);
  });
  it("a draft then its send proves the send", () => {
    expect(check("Sent.", receiptsFor(["OUTLOOK_CREATE_DRAFT_REPLY"], ["OUTLOOK_SEND_DRAFT"])).state).toBe("recorded");
  });
});

// Astra (rc13 actionclass, round 3): a name ending in CREATE_EVENT proves no calendar
// event, a new Teams meeting is scheduled, and removing an attendee is a removal.
describe("round 3: each repro, whatever the engine called it", () => {
  it.each([
    ["KLAVIYO_CREATE_EVENT", []],
    ["CALENDLY_CREATE_EVENT", []],
    ["MICROSOFT_TEAMS_CREATE_MEETING", ["save", "schedule"]],
    ["MICROSOFT_TEAMS_CREATE_USER_ONLINE_MEETING", ["save", "schedule"]],
    ["GOOGLECALENDAR_REMOVE_ATTENDEE", ["change", "delete"]],
  ] as Array<[string, ActionClass[]]>)("%s", (slug, classes) => {
    expect(sorted(connectedAppActionClasses(slug))).toEqual(classes);
    for (const [route, proven] of everyRoute(slug)) expect([route, sorted(proven)]).toEqual([route, classes]);
  });
  it.each([
    ["I scheduled the meeting.", "KLAVIYO_CREATE_EVENT"],
    ["I've added both events to your calendar.", "KLAVIYO_CREATE_EVENT"],
  ])("%s after only %s stays flagged", (text, slug) => {
    expect(check(text, receiptsFor([slug])).state).toBe("flagged");
    for (const [route, proven] of everyRoute(slug)) expect([route, check(text, proven).state]).toEqual([route, "flagged"]);
  });
  it.each([
    ["I scheduled the Teams meeting for Monday.", "MICROSOFT_TEAMS_CREATE_MEETING"],
    ["I scheduled the Teams meeting for Monday.", "MICROSOFT_TEAMS_CREATE_USER_ONLINE_MEETING"],
    ["I removed the attendee from the meeting.", "GOOGLECALENDAR_REMOVE_ATTENDEE"],
  ])("%s after %s is recorded", (text, slug) => {
    expect(check(text, receiptsFor([slug])).state).toBe("recorded");
    for (const [route, proven] of everyRoute(slug)) expect([route, check(text, proven).state]).toEqual([route, "recorded"]);
    expect(check(text, receiptsFor()).state).toBe("flagged");
  });
  // Every catalogue slug outside the table that ends in one of the three kept endings
  // (docs.composio.dev/toolkits, 2026-10-15) really sends or drafts.
  it.each([
    ["FACEBOOK_SEND_MESSAGE", ["send"]], ["SLACKBOT_SEND_MESSAGE", ["send"]], ["WHATSAPP_SEND_MESSAGE", ["send"]],
    ["TELEGRAM_SEND_MESSAGE", ["send"]], ["RESEND_SEND_EMAIL", ["send"]], ["SALESFORCE_SEND_EMAIL", ["send"]],
    ["ZOHOMAIL_SEND_EMAIL", ["send"]], ["ZOHOMAIL_CREATE_DRAFT", ["save"]],
  ] as Array<[string, ActionClass[]]>)("kept ending: %s", (slug, classes) => {
    expect(sorted(connectedAppActionClasses(slug))).toEqual(classes);
  });
});

describe("the action table", () => {
  const LOOKUP_WORDS = new Set(["GET", "FETCH", "SEARCH", "FIND", "QUERY", "RETRIEVE", "READ", "DOWNLOAD", "EXPORT", "VIEW", "WATCH", "LOOKUP", "DESCRIBE", "COUNT", "PREVIEW", "PARSE"]);
  const entries = Object.entries(CONNECTED_APP_ACTION_TABLE).flatMap(([toolkit, actions]) =>
    Object.entries(actions).map(([action, classes]) => ({ toolkit, action, slug: `${toolkit}_${action}`, classes })));
  it("no listed slug looks like a lookup", () => {
    const reads = new Set(VERIFIED_READ_TOOLS.map(entry => entry.tool));
    const lookups = entries.filter(({ action }) => {
      const words = action.split("_");
      return words[0] === "LIST" || words.some(word => LOOKUP_WORDS.has(word));
    }).map(entry => entry.slug);
    expect(lookups).toEqual([]);
    expect(entries.filter(entry => reads.has(entry.slug)).map(entry => entry.slug)).toEqual([]);
  });
  it("every verified read carries no class", () => {
    expect(VERIFIED_READ_TOOLS.filter(entry => connectedAppActionClasses(entry.tool).length).map(entry => entry.tool)).toEqual([]);
  });
  it("every draft entry lacks send; only a send of the draft sends", () => {
    const drafts = entries.filter(({ action }) => action.split("_").includes("DRAFT") && !action.startsWith("SEND_"));
    expect(drafts.length).toBeGreaterThan(10);
    expect(drafts.filter(entry => entry.classes.includes("send")).map(entry => entry.slug)).toEqual([]);
    expect(entries.filter(({ action }) => action.startsWith("SEND_DRAFT")).every(entry => entry.classes.includes("send"))).toBe(true);
  });
  it("no entry names settings, rules, permissions, attachments, extensions or access", () => {
    const ADMIN = /(?:^|_)(?:SETTINGS?|RULES?|FILTERS?|LABELS?|ACL|PERMISSIONS?|ATTACHMENTS?|EXTENSIONS?|ACCESS|SEND_AS|SHARING|SIGNATURE|VACATION|WEBHOOK)(?:_|$)/;
    // a Discord webhook execution posts a message, which is the one webhook action listed
    expect(entries.filter(entry => ADMIN.test(entry.action) && entry.slug !== "DISCORDBOT_EXECUTE_WEBHOOK").map(entry => entry.slug)).toEqual([]);
  });
  it("every entry carries at least one class, each once, and the flat map holds them all", () => {
    for (const entry of entries) {
      expect(entry.classes.length, entry.slug).toBeGreaterThan(0);
      expect(new Set(entry.classes).size, entry.slug).toBe(entry.classes.length);
    }
    expect(CONNECTED_APP_ACTIONS.size).toBe(entries.length);
  });
  it("a slug reads the same in any case or spelling", () => {
    for (const name of ["googlecalendar_create_event", "Googlecalendar create event", " GOOGLECALENDAR_CREATE_EVENT "]) {
      expect(sorted(connectedAppActionClasses(name))).toEqual(["save", "schedule"]);
    }
  });
});
