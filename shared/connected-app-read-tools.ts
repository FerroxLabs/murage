// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Which connected-app tools are VERIFIED to only read: the reviewed list and the lookup by slug. Its own module, with
// no call parser, so the approval card's words (src/lib/routine-grant-words.ts) stay out of the first paint;
// shared/connected-app-readonly.ts re-exports it with the call classifier.
//
// A verified read runs fresh every time it is asked for: asking for the inbox
// twice reads the inbox twice. Everything else (writes, tools nobody has
// reviewed, workbench and remote code tools, and any batch holding one of
// those) keeps the durable one-send-only protection in
// server/connected-app-operations.ts.
//
// Authority is this reviewed list and nothing else. A tool's name never
// authorizes anything at run time: `suggestsRead` below only feeds the
// dev-time lint in shared/connected-app-readonly.test.ts, which asks a person
// to review a new slug. Unknown means protected.
//
// This is NOT the restricted-mode grant catalog (CONNECTED_APP_TOOLS in
// shared/bot-access.ts decides what a restricted bot may be granted); it only
// decides whether a repeat of an allowed call may run again.
import { CONNECTED_APP_TOOLS } from "./bot-access.ts";

export interface ReadTool { toolkit: string; tool: string; doc: string }

const readTools = (toolkit: string, slugs: string[]): ReadTool[] =>
  slugs.map((tool) => ({ toolkit, tool, doc: `https://docs.composio.dev/toolkits/${toolkit}` }));

function dedupe(list: ReadTool[]): ReadTool[] {
  const seen = new Set<string>();
  return list.filter((entry) => !seen.has(entry.tool) && !!seen.add(entry.tool));
}

/** Reviewed read-only tools. `doc` is the page the slug was checked against. */
export const VERIFIED_READ_TOOLS: readonly ReadTool[] = dedupe([
  // The reviewed restricted-mode catalog entries that do not write.
  ...CONNECTED_APP_TOOLS.filter((entry) => !entry.writes).map((entry) => ({
    toolkit: entry.toolkit, tool: entry.tool, doc: `https://docs.composio.dev/toolkits/${entry.toolkit}`,
  })),
  // https://docs.composio.dev/toolkits/gmail : every slug below carries the readOnlyHint tag there (checked 2026-10-10).
  ...readTools("gmail", [
    "GMAIL_FETCH_EMAILS", "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
    "GMAIL_GET_PROFILE", "GMAIL_LIST_HISTORY", "GMAIL_LIST_LABELS", "GMAIL_LIST_SEND_AS", "GMAIL_LIST_THREADS",
    "GMAIL_GET_LABEL", "GMAIL_GET_DRAFT", "GMAIL_LIST_DRAFTS", "GMAIL_LIST_FILTERS", "GMAIL_GET_ATTACHMENT",
    "GMAIL_SEARCH_PEOPLE", "GMAIL_GET_CONTACTS", "GMAIL_GET_PEOPLE",
  ]),
  // https://docs.composio.dev/toolkits/googlecalendar : every slug below carries the readOnlyHint tag there (checked 2026-10-10).
  ...readTools("googlecalendar", [
    "GOOGLECALENDAR_EVENTS_LIST", "GOOGLECALENDAR_EVENTS_GET", "GOOGLECALENDAR_EVENTS_INSTANCES",
    "GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS", "GOOGLECALENDAR_FIND_EVENT", "GOOGLECALENDAR_FIND_FREE_SLOTS",
    "GOOGLECALENDAR_FREE_BUSY_QUERY", "GOOGLECALENDAR_GET_CALENDAR", "GOOGLECALENDAR_LIST_CALENDARS",
    "GOOGLECALENDAR_CALENDAR_LIST_GET", "GOOGLECALENDAR_GET_CURRENT_DATE_TIME", "GOOGLECALENDAR_GET_CURRENT_USER",
    "GOOGLECALENDAR_SETTINGS_GET", "GOOGLECALENDAR_SETTINGS_LIST", "GOOGLECALENDAR_ACL_LIST",
    "GOOGLECALENDAR_ACL_GET", "GOOGLECALENDAR_COLORS_GET",
  ]),
  // https://docs.composio.dev/toolkits/slack : every slug below carries the readOnlyHint tag there (checked 2026-10-10).
  ...readTools("slack", [
    "SLACK_FETCH_CONVERSATION_HISTORY", "SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION", "SLACK_FIND_CHANNELS",
    "SLACK_FIND_USERS", "SLACK_FIND_USER_BY_EMAIL_ADDRESS", "SLACK_LIST_ALL_CHANNELS", "SLACK_LIST_ALL_USERS",
    "SLACK_LIST_CONVERSATIONS", "SLACK_RETRIEVE_CONVERSATION_INFORMATION",
    "SLACK_RETRIEVE_CONVERSATION_MEMBERS_LIST", "SLACK_RETRIEVE_DETAILED_USER_INFORMATION",
    "SLACK_RETRIEVE_USER_PROFILE_INFORMATION", "SLACK_RETRIEVE_MESSAGE_PERMALINK_URL", "SLACK_SEARCH_MESSAGES",
    "SLACK_SEARCH_ALL", "SLACK_SEARCH_FILES", "SLACK_LIST_FILES_WITH_FILTERS_IN_SLACK", "SLACK_FETCH_TEAM_INFO",
    "SLACK_LIST_PINNED_ITEMS", "SLACK_LIST_REMINDERS", "SLACK_LIST_SCHEDULED_MESSAGES", "SLACK_LIST_USER_GROUPS",
    "SLACK_GET_USER_PRESENCE", "SLACK_TEST_AUTH", "SLACK_WHO_AM_I",
  ]),
  // https://docs.composio.dev/toolkits/notion : every slug below carries the readOnlyHint tag there (checked 2026-10-10).
  ...readTools("notion", [
    "NOTION_FETCH_BLOCK_CONTENTS", "NOTION_FETCH_ALL_BLOCK_CONTENTS", "NOTION_FETCH_BLOCK_METADATA",
    "NOTION_FETCH_COMMENTS", "NOTION_FETCH_DATA", "NOTION_FETCH_DATABASE", "NOTION_FETCH_ROW",
    "NOTION_GET_ABOUT_USER", "NOTION_GET_PAGE_MARKDOWN", "NOTION_GET_PAGE_PROPERTY_ACTION", "NOTION_LIST_USERS",
    "NOTION_QUERY_DATABASE", "NOTION_QUERY_DATABASE_WITH_FILTER", "NOTION_QUERY_DATA_SOURCE",
    "NOTION_RETRIEVE_COMMENT", "NOTION_RETRIEVE_DATABASE_PROPERTY", "NOTION_RETRIEVE_PAGE",
    "NOTION_SEARCH_NOTION_PAGE", "NOTION_WHO_AM_I",
  ]),
  // https://docs.composio.dev/toolkits/googledrive : every slug below carries the readOnlyHint tag there (checked 2026-10-10).
  ...readTools("googledrive", [
    "GOOGLEDRIVE_FIND_FILE", "GOOGLEDRIVE_FIND_FOLDER", "GOOGLEDRIVE_GET_ABOUT", "GOOGLEDRIVE_GET_FILE_METADATA",
    "GOOGLEDRIVE_GET_PERMISSION", "GOOGLEDRIVE_LIST_PERMISSIONS", "GOOGLEDRIVE_LIST_COMMENTS",
    "GOOGLEDRIVE_GET_COMMENT", "GOOGLEDRIVE_LIST_REVISIONS", "GOOGLEDRIVE_GET_REVISION",
    "GOOGLEDRIVE_LIST_SHARED_DRIVES", "GOOGLEDRIVE_GET_DRIVE", "GOOGLEDRIVE_GET_DOCUMENT",
    "GOOGLEDRIVE_GET_SPREADSHEET", "GOOGLEDRIVE_GET_SPREADSHEET_VALUES", "GOOGLEDRIVE_READ_SPREADSHEET_VALUES",
    "GOOGLEDRIVE_BATCH_GET_SPREADSHEET_VALUES", "GOOGLEDRIVE_GET_PRESENTATION", "GOOGLEDRIVE_LIST_CHANGES",
    "GOOGLEDRIVE_LIST_CHILDREN_V2", "GOOGLEDRIVE_GET_PARENT", "GOOGLEDRIVE_DOWNLOAD_FILE",
    "GOOGLEDRIVE_EXPORT_GOOGLE_WORKSPACE_FILE", "GOOGLEDRIVE_GET_FORM", "GOOGLEDRIVE_LIST_FORM_RESPONSES",
  ]),
  // https://docs.composio.dev/toolkits/github : every slug below carries the readOnlyHint tag there (checked 2026-10-10).
  ...readTools("github", [
    "GITHUB_GET_A_REPOSITORY", "GITHUB_GET_AN_ISSUE", "GITHUB_GET_A_PULL_REQUEST", "GITHUB_GET_A_COMMIT",
    "GITHUB_GET_A_BRANCH", "GITHUB_GET_A_REPOSITORY_README", "GITHUB_FIND_PULL_REQUESTS", "GITHUB_FIND_REPOSITORIES",
    "GITHUB_COMPARE_TWO_COMMITS", "GITHUB_LIST_REPOSITORY_ISSUES", "GITHUB_LIST_PULL_REQUESTS",
    "GITHUB_LIST_COMMITS", "GITHUB_LIST_BRANCHES", "GITHUB_LIST_ISSUE_COMMENTS", "GITHUB_GET_THE_AUTHENTICATED_USER",
    "GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS", "GITHUB_SEARCH_REPOSITORIES", "GITHUB_SEARCH_CODE",
    "GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER", "GITHUB_GET_REPOSITORY_CONTENT",
    "GITHUB_LIST_REPOSITORY_CONTRIBUTORS", "GITHUB_LIST_RELEASES", "GITHUB_LIST_REVIEW_COMMENTS_ON_A_PULL_REQUEST",
    "GITHUB_LIST_NOTIFICATIONS",
  ]),
  // https://docs.composio.dev/toolkits/linear : every slug below carries the readOnlyHint tag there (checked 2026-10-10).
  ...readTools("linear", [
    "LINEAR_GET_ATTACHMENT", "LINEAR_GET_COMMENT", "LINEAR_GET_CURRENT_USER", "LINEAR_GET_LINEAR_ISSUE",
    "LINEAR_GET_LINEAR_PROJECT", "LINEAR_LIST_COMMENTS", "LINEAR_LIST_LINEAR_ISSUES",
    "LINEAR_LIST_ISSUES_BY_TEAM_ID", "LINEAR_LIST_LINEAR_PROJECTS", "LINEAR_LIST_LINEAR_TEAMS",
    "LINEAR_LIST_LINEAR_USERS", "LINEAR_LIST_LINEAR_STATES", "LINEAR_LIST_LINEAR_LABELS",
    "LINEAR_LIST_LINEAR_CYCLES", "LINEAR_SEARCH_ISSUES", "LINEAR_WHO_AM_I",
  ]),
  // The helpdesk reads a ticket-triage bot needs to sort and draft without sending.
  // https://docs.composio.dev/toolkits/zendesk : every slug below carries the readOnlyHint tag there (checked 2026-10-24).
  ...readTools("zendesk", [
    "ZENDESK_GET_ABOUT_ME", "ZENDESK_LIST_ZENDESK_TICKETS", "ZENDESK_GET_ZENDESK_TICKET_BY_ID",
    "ZENDESK_GET_TICKET_COMMENTS", "ZENDESK_GET_RECENT_TICKETS", "ZENDESK_SEARCH_ZENDESK",
    "ZENDESK_SEARCH_ZENDESK_USERS", "ZENDESK_GET_USER", "ZENDESK_GET_VIEWS", "ZENDESK_GET_VIEWS_TICKETS",
    "ZENDESK_GET_TICKET_FIELDS", "ZENDESK_GET_ZENDESK_TICKETS_TAGS", "ZENDESK_GET_TAGS", "ZENDESK_GET_MACROS",
    "ZENDESK_GET_TICKET_METRICS", "ZENDESK_GET_SATISFACTION_RATINGS", "ZENDESK_GET_TICKET_SLA_POLICY_METRICS",
  ]),
  // https://docs.composio.dev/toolkits/intercom : every slug below carries the readOnlyHint tag there (checked 2026-10-24).
  ...readTools("intercom", [
    "INTERCOM_GET_CONVERSATION", "INTERCOM_LIST_CONVERSATIONS", "INTERCOM_SEARCH_CONVERSATIONS",
    "INTERCOM_GET_TICKET", "INTERCOM_SEARCH_TICKETS", "INTERCOM_LIST_TICKET_TYPES", "INTERCOM_LIST_TICKET_STATES",
    "INTERCOM_GET_A_CONTACT", "INTERCOM_SEARCH_CONTACTS", "INTERCOM_LIST_ALL_ADMINS", "INTERCOM_LIST_TEAMS",
    "INTERCOM_LIST_TAGS", "INTERCOM_LIST_ALL_MACROS", "INTERCOM_SEARCH_FOR_ARTICLES", "INTERCOM_LIST_ALL_ARTICLES",
  ]),
  // https://docs.composio.dev/toolkits/help_scout : every slug below carries the readOnlyHint tag there (checked 2026-10-24).
  ...readTools("help_scout", [
    "HELP_SCOUT_LIST_CONVERSATIONS", "HELP_SCOUT_GET_CONVERSATION", "HELP_SCOUT_LIST_THREADS",
    "HELP_SCOUT_LIST_INBOXES", "HELP_SCOUT_GET_INBOX", "HELP_SCOUT_GET_CUSTOMER", "HELP_SCOUT_LIST_CUSTOMERS",
    "HELP_SCOUT_LIST_SAVED_REPLIES", "HELP_SCOUT_LIST_TAGS", "HELP_SCOUT_LIST_USERS", "HELP_SCOUT_LIST_TEAMS",
    "HELP_SCOUT_GET_RESOURCE_OWNER",
  ]),
]);

const VERIFIED = new Set(VERIFIED_READ_TOOLS.map((entry) => entry.tool));

export function isVerifiedReadTool(slug: string): boolean {
  return VERIFIED.has(slug.trim().toUpperCase());
}

/** Dev-time lint only: a slug whose name reads like a lookup. Never a runtime decision. */
export function suggestsRead(slug: string): boolean {
  return /_(GET|LIST|FETCH|FIND|SEARCH|QUERY|RETRIEVE|READ|WHO_AM_I|DOWNLOAD|EXPORT|COMPARE|TEST_AUTH|INSTANCES)(_|$)/.test(slug.toUpperCase());
}
