// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A draft-only bot can never send, and that is the relay's doing, not the
// prompt's. The shipped Ticket Triage profile declares `outbound: "draft-only"`;
// install stamps `draftOnly` on the bot, and assertConnectedAppCall then admits
// only verified reads, tool discovery and the status of its own earlier call,
// whatever the bot's access level, grants or write switch say.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase } from "./database.ts";
import { Store } from "./store.ts";
import { DRAFT_ONLY_REFUSAL, assertConnectedAppCall, requestBotAccess, reviewBotAccess } from "./bot-access.ts";
import { botAccessPolicy } from "./bot-access-role.ts";
import { parseBotPackage } from "./bot-package.ts";
import { isVerifiedReadTool } from "../shared/connected-app-readonly.ts";
import { CONNECTED_APP_STATUS_TOOL } from "../shared/connected-app-calls.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const shipped = (slug: string) => parseBotPackage(JSON.parse(readFileSync(join(root, "bot-library/builtins", `${slug}.json`), "utf8"))).package;

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

function run(tool: string, args: object = {}, account = "ca_fixture_owned") {
  return { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ tool_slug: tool, account, arguments: args }], sync_response_to_workbench: false } } };
}
const meta = (name: string, args: object = {}) => ({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });

/** A bot as the installer leaves it, then opened all the way up by its owner. */
function draftOnlyBot() {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const bot = store.createBot({ name: "Sorrel" });
  store.patchBot(bot.id, { draftOnly: true, composio: true, autoApprove: true, fullAccess: true, noLimits: true, alwaysAllow: ["COMPOSIO_MULTI_EXECUTE_TOOL"] });
  return { store, bot: store.bot(bot.id)! };
}

const SENDS = [
  "ZENDESK_CREATE_ZENDESK_TICKET", "ZENDESK_UPDATE_ZENDESK_TICKET", "ZENDESK_REPLY_ZENDESK_TICKET",
  "INTERCOM_REPLY_TO_CONVERSATION", "INTERCOM_CLOSE_A_CONVERSATION", "HELP_SCOUT_CREATE_REPLY_THREAD",
  "GMAIL_SEND_EMAIL", "GMAIL_SEND_DRAFT", "SLACK_SEND_MESSAGE", "GMAIL_CREATE_EMAIL_DRAFT",
  // a tool nobody has reviewed is not a read just because its name looks like one
  "ZENDESK_GET_SOMETHING_NEW",
];

describe("the shipped Ticket Triage profile", () => {
  it("is draft-only in the package format, not only in its prompt", () => {
    const pkg = shipped("ticket-triage");
    expect(pkg.agents).toHaveLength(1);
    expect(pkg.agents[0]!.outbound).toBe("draft-only");
    expect(pkg.requirements.apps.map((app) => app.slug)).toEqual(["zendesk", "intercom", "help_scout"]);
  });

  it("reads all three helpdesks through verified read tools", () => {
    for (const slug of ["ZENDESK_LIST_ZENDESK_TICKETS", "ZENDESK_GET_TICKET_COMMENTS", "INTERCOM_SEARCH_CONVERSATIONS", "HELP_SCOUT_LIST_CONVERSATIONS"]) {
      expect(isVerifiedReadTool(slug), slug).toBe(true);
    }
  });

  it("the format refuses any other outbound value", () => {
    const raw = JSON.parse(readFileSync(join(root, "bot-library/builtins/ticket-triage.json"), "utf8"));
    raw.package.agents[0].outbound = "send";
    expect(() => parseBotPackage(raw)).toThrow();
  });
});

describe("a draft-only bot at the connected-app relay", () => {
  it.each(SENDS)("refuses %s even at No limits with the tool always allowed", (tool) => {
    const { bot } = draftOnlyBot();
    expect(() => assertConnectedAppCall(bot, run(tool))).toThrow(DRAFT_ONLY_REFUSAL);
  });

  it("refuses a send hidden in a batch of reads, and a JSON-RPC batch", () => {
    const { bot } = draftOnlyBot();
    const mixed = run("ZENDESK_LIST_ZENDESK_TICKETS");
    mixed.params.arguments.tools.push({ tool_slug: "ZENDESK_UPDATE_ZENDESK_TICKET", account: "ca_fixture_owned", arguments: {} });
    expect(() => assertConnectedAppCall(bot, mixed)).toThrow(DRAFT_ONLY_REFUSAL);
    expect(() => assertConnectedAppCall(bot, [run("ZENDESK_LIST_ZENDESK_TICKETS"), run("GMAIL_SEND_EMAIL")])).toThrow(DRAFT_ONLY_REFUSAL);
  });

  it("refuses the workbench, remote code, proxy calls and connection changes", () => {
    const { bot } = draftOnlyBot();
    for (const name of ["COMPOSIO_REMOTE_WORKBENCH", "COMPOSIO_REMOTE_BASH_TOOL", "COMPOSIO_PROXY_EXECUTE", "COMPOSIO_MANAGE_CONNECTIONS", "mcp__murage_connectors__COMPOSIO_REMOTE_WORKBENCH"]) {
      expect(() => assertConnectedAppCall(bot, meta(name, { code: "fixture" })), name).toThrow(DRAFT_ONLY_REFUSAL);
    }
    const offload = run("ZENDESK_LIST_ZENDESK_TICKETS");
    offload.params.arguments.sync_response_to_workbench = true;
    expect(() => assertConnectedAppCall(bot, offload)).toThrow(DRAFT_ONLY_REFUSAL);
  });

  it("still reads, discovers tools and collects its own earlier call", () => {
    const { bot } = draftOnlyBot();
    for (const tool of ["ZENDESK_LIST_ZENDESK_TICKETS", "INTERCOM_GET_CONVERSATION", "HELP_SCOUT_LIST_THREADS", "GMAIL_FETCH_EMAILS"]) {
      expect(() => assertConnectedAppCall(bot, run(tool)), tool).not.toThrow();
    }
    expect(() => assertConnectedAppCall(bot, meta("COMPOSIO_SEARCH_TOOLS", { queries: [] }))).not.toThrow();
    expect(() => assertConnectedAppCall(bot, meta("mcp__murage_connectors__COMPOSIO_GET_TOOL_SCHEMAS"))).not.toThrow();
    expect(() => assertConnectedAppCall(bot, meta(CONNECTED_APP_STATUS_TOOL, { handle: "fixture" }))).not.toThrow();
    for (const method of ["initialize", "tools/list", "ping"]) expect(() => assertConnectedAppCall(bot, { jsonrpc: "2.0", id: 3, method })).not.toThrow();
  });

  it("an owner grant with writes switched on does not reopen sends", () => {
    const { store, bot } = draftOnlyBot();
    const chief = store.createBot({ name: "Chief", section: "Support" });
    store.setChiefOfStaff(chief.id, undefined, "workspace");
    const grant = { toolkit: "gmail", accountId: "ca_fixture_owned", tools: ["GMAIL_SEND_EMAIL", "GMAIL_FETCH_EMAILS"] };
    const request = requestBotAccess(store, chief, { botId: bot.id, revision: botAccessPolicy(bot).revision, grants: [grant], allowWrites: true });
    reviewBotAccess(store, bot.id, { action: "approve", requestId: request.requestId, revision: request.revision }, [{ toolkit: "gmail", accountId: "ca_fixture_owned" }]);
    const granted = store.bot(bot.id)!;
    expect(botAccessPolicy(granted)).toMatchObject({ mode: "restricted", allowWrites: true });
    expect(() => assertConnectedAppCall(granted, run("GMAIL_SEND_EMAIL", { to: "fake@example.invalid" }))).toThrow(DRAFT_ONLY_REFUSAL);
    expect(() => assertConnectedAppCall(granted, run("GMAIL_FETCH_EMAILS", { user_id: "me" }))).not.toThrow();
  });

  it("survives a restart: the mark is stored with the bot", () => {
    const { bot } = draftOnlyBot();
    const restored = new Store(() => ({ instanceId: "fixture", model: "fixture" })).bot(bot.id)!;
    expect(restored.draftOnly).toBe(true);
    expect(() => assertConnectedAppCall(restored, run("GMAIL_SEND_EMAIL"))).toThrow(DRAFT_ONLY_REFUSAL);
  });

  it("leaves every other bot exactly as it was", () => {
    const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
    const bot = store.createBot({ name: "Ordinary" });
    expect(() => assertConnectedAppCall(store.bot(bot.id)!, run("GMAIL_SEND_EMAIL"))).not.toThrow();
  });
});
