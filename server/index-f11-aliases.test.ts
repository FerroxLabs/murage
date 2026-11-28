// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// F11-V3 (1.0.23) through the REAL harness server and its internal connected-apps relay (node server/index.ts against a
// throwaway home, a fake broker). Witnesses W6, W8 (relay half) and W11 (the mount flag) of
// designs/F11-V3-APP-ALIASES-1023.md. Restricted lists, the per-request alias rows, the bare-name guard, and a grant
// changing between the card and the dispatch.
vi.hoisted(() => { process.env.MURAGE_TEST_UNBOUNDED_REVOKE_BUDGET = "1"; });
vi.hoisted(() => { process.env.MURAGE_TEST_FAKE_FLUX_BROKER = "1"; });
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { spawnBoundProxy } from "./testing/bound-proxy-fixture.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { BASE, indexDisplayApis, setConnectorAliasFixture, startInternalFixtureTurn } from "./testing/index-harness.ts";
import { CONNECTOR_ALIASES_HEADER } from "../shared/connected-app-aliases.ts";

const { api, desktopApi } = indexDisplayApis();
const account = (id: string, slug: string) => ({ id, alias: id, status: "ACTIVE", toolkit: { slug } });
const EXECUTE = "COMPOSIO_MULTI_EXECUTE_TOOL";

async function newBot(name: string) {
  const bot = (await desktopApi("POST", "/api/bots", { name })).body.bot;
  const view = await desktopApi("GET", `/api/bots/${bot.id}/access`);
  return { bot, revision: view.body.policy.revision as number };
}
async function configure(botId: string, mode: "restricted" | "unrestricted", allowWrites: boolean, grants: Array<{ toolkit: string; accountId: string; tools: string[] }>) {
  const view = await desktopApi("GET", `/api/bots/${botId}/access`);
  const saved = await desktopApi("PUT", `/api/bots/${botId}/access`, { action: "configure", revision: view.body.policy.revision, mode, allowWrites, grants });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
}
const relay = (token: string, message: unknown, headers: Record<string, string> = {}) =>
  fetch(`${BASE}/api/internal/connectors/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, body: JSON.stringify(message) });
const listed = async (token: string, headers: Record<string, string> = {}) => {
  const res = await relay(token, { jsonrpc: "2.0", id: 1, method: "tools/list" }, headers);
  expect(res.status).toBe(200);
  return ((await res.json()) as { result: { tools: Array<{ name: string; inputSchema?: any }> } }).result.tools;
};
async function turnOf(botId: string) {
  const { dump } = await startInternalFixtureTurn(botId);
  const env = dump.mcpConfig.mcpServers.murage_connectors.env as Record<string, string>;
  return { token: env.MURAGE_CONNECTORS_TOKEN!, env };
}
/** A new access policy ends the old turn's token (401); the next turn mounts under the new policy. */
const restart = async (botId: string) => { await api("POST", `/api/bots/${botId}/interrupt`); return turnOf(botId); };
/** One plain-name call through the REAL flagged bridge process into the REAL relay (the engine's path), answered as the engine reads it. */
async function viaBridge(token: string, name: string, input: unknown, id = 9): Promise<{ isError: boolean; text: string }> {
  const cache = mkdtempSync(join(tmpdir(), "murage-alias-relay-"));
  const child = await spawnBoundProxy("connectors", process.execPath, ["--experimental-strip-types", join(import.meta.dirname, "connector-proxy.ts")], {
    windowsHide: true,
    env: {
      ...process.env, MURAGE_CONNECTOR_TOOLS_CACHE_DIR: cache, ...(process.platform === "win32" ? { MURAGE_CONNECTOR_TOOLS_CACHE_PRIVATE: "1" } : {}),
      MURAGE_CONNECTOR_UPSTREAM_URL: `${BASE}/api/internal/connectors/mcp`, MURAGE_CONNECTOR_UPSTREAM_HEADERS: JSON.stringify({ authorization: `Bearer ${token}` }), MURAGE_CONNECTOR_ALIASES: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = readline.createInterface({ input: child.stdout });
  try {
    const next = lines[Symbol.asyncIterator]().next();
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: input } })}\n`);
    const reply = JSON.parse((await next).value as string) as { result?: { isError?: boolean; content?: Array<{ text?: string }> }; error?: { message?: string } };
    return { isError: reply.result?.isError === true || reply.error !== undefined, text: reply.result?.content?.[0]?.text ?? reply.error?.message ?? "" };
  } finally { lines.close(); child.kill("SIGKILL"); removeTempDirSync(cache); }
}
const finish = async (botId: string) => { await api("POST", `/api/bots/${botId}/interrupt`); await desktopApi("DELETE", `/api/bots/${botId}`); };
const ALIAS_HEADER = { [CONNECTOR_ALIASES_HEADER]: "1" };

describe("F11-V3 at the real relay", () => {
  beforeAll(() => { setConnectorAliasFixture({ accounts: [account("ca_a", "gmail"), account("ca_b", "gmail"), account("ca_c", "gmail"), account("ca_s", "slack")], links: [], calls: 0 }); });
  it("W8 / W11 restricted: the mount is flagged for the Claude engine; the list is per request, per slug, per grant; nothing leaks into initialTools", async () => {
    const { bot } = await newBot("Alias list fixture");
    try {
      await configure(bot.id, "restricted", true, [
        { toolkit: "gmail", accountId: "ca_a", tools: ["GMAIL_FETCH_EMAILS", "GMAIL_SEND_EMAIL"] },
        { toolkit: "gmail", accountId: "ca_b", tools: ["GMAIL_FETCH_EMAILS"] },
      ]);
      const { token, env } = await turnOf(bot.id);
      expect(env.MURAGE_CONNECTOR_ALIASES).toBe("1");
      // initialTools (the list the mount env carries before the engine fetches the real one) never holds an alias
      expect(env.MURAGE_CONNECTOR_INITIAL_TOOLS ?? "").not.toMatch(/gmail_(fetch_emails|send_email)/);
      // no header: no alias rows (a bridge that did not ask)
      expect((await listed(token)).map((tool) => tool.name)).toEqual([EXECUTE]);
      const rows = await listed(token, ALIAS_HEADER);
      const byName = Object.fromEntries(rows.map((tool) => [tool.name, tool]));
      expect(Object.keys(byName).sort(), "the header-asked list carries the alias rows").toContain("gmail_fetch_emails");
      expect(byName.gmail_fetch_emails!.inputSchema.properties.account.enum).toEqual(["ca_a", "ca_b"]);
      // SEND was granted on A only: the send enum is A alone, never B (a read-only account)
      expect(byName.gmail_send_email!.inputSchema.properties.account.enum).toEqual(["ca_a"]);
      expect(byName.gmail_send_email!.inputSchema).toMatchObject({ required: ["account", "arguments"], additionalProperties: false });
      expect(rows.map((tool) => tool.name)).toEqual([EXECUTE, "gmail_fetch_emails", "gmail_send_email"]);
      // writes blocked: no send alias at all
      await configure(bot.id, "restricted", false, [{ toolkit: "gmail", accountId: "ca_a", tools: ["GMAIL_FETCH_EMAILS", "GMAIL_SEND_EMAIL"] }]);
      const { token: next } = await restart(bot.id);
      expect((await listed(next, ALIAS_HEADER)).map((tool) => tool.name)).toEqual([EXECUTE, "gmail_fetch_emails"]);
    } finally { await finish(bot.id); }
  });

  it("W8 the relay refuses a bare alias name in restricted AND unrestricted mode, in a batch too, and runs nothing", async () => {
    const { bot } = await newBot("Alias guard fixture");
    try {
      await configure(bot.id, "restricted", true, [{ toolkit: "gmail", accountId: "ca_a", tools: ["GMAIL_FETCH_EMAILS", "GMAIL_SEND_EMAIL"] }]);
      const { token } = await turnOf(bot.id);
      const call = (name: string) => ({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: { account: "ca_a", arguments: {} } } });
      expect((await relay(token, call("gmail_send_email"))).status).toBe(403);
      await configure(bot.id, "unrestricted", true, []);
      const unrestricted = await restart(bot.id);
      expect((await relay(unrestricted.token, call("gmail_send_email"))).status).toBe(403);
      expect((await relay(unrestricted.token, [call(EXECUTE), call("slack_send_message")])).status).toBe(403);
    } finally { await finish(bot.id); }
  });

  it("W8 unrestricted: alias rows follow the request header, are built per request from the bot's accounts, and never stay in the shared list", async () => {
    const { bot } = await newBot("Alias unrestricted fixture");
    const second = await newBot("Alias restricted neighbour");
    try {
      await configure(bot.id, "unrestricted", true, []);
      const { token } = await turnOf(bot.id);
      const withHeader = await listed(token, ALIAS_HEADER);
      const send = withHeader.find((tool) => tool.name === "gmail_send_email");
      expect(send?.inputSchema.properties.account.enum).toEqual(expect.arrayContaining(["ca_a", "ca_b"]));
      // the same bot with no header (an unflagged bridge) gets none: the rows were appended after the shared list, not stored in it
      expect((await listed(token)).map((tool) => tool.name)).not.toContain("gmail_send_email");
      // another bot of the same owner, restricted to one account for reads only, never sees the first bot's rows
      await configure(second.bot.id, "restricted", false, [{ toolkit: "gmail", accountId: "ca_a", tools: ["GMAIL_FETCH_EMAILS"] }]);
      const neighbour = await turnOf(second.bot.id);
      expect((await listed(neighbour.token, ALIAS_HEADER)).map((tool) => tool.name)).toEqual([EXECUTE, "gmail_fetch_emails"]);
    } finally { await finish(bot.id); await finish(second.bot.id); }
  });

  it("W6 card to dispatch: the account the call named is the account the relay judges; a revoked account is refused, a still-granted one runs (real bridge, real relay)", async () => {
    const { bot } = await newBot("Alias account fixture");
    try {
      const grant = (...ids: string[]) => ids.map((accountId) => ({ toolkit: "gmail", accountId, tools: ["GMAIL_SEND_EMAIL"] }));
      const input = (accountId: string) => ({ account: accountId, arguments: { recipient_email: "a@x.com", subject: "s", body: "b" } });
      await configure(bot.id, "restricted", true, grant("ca_a", "ca_b"));
      const first = await turnOf(bot.id);
      expect((await viaBridge(first.token, "gmail_send_email", input("ca_a"))).isError).toBe(false);
      // (b) C is added and A kept: A still runs, and nothing moves the call to C
      await configure(bot.id, "restricted", true, grant("ca_a", "ca_c"));
      const added = await restart(bot.id);
      expect((await viaBridge(added.token, "gmail_send_email", input("ca_a"))).isError).toBe(false);
      // (a) A is revoked between the card and the dispatch: refused with the grant refusal text, nothing runs
      await configure(bot.id, "restricted", true, grant("ca_c"));
      const revoked = await restart(bot.id);
      const refused = await viaBridge(revoked.token, "gmail_send_email", input("ca_a"));
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("This tool or connected account has not been approved for this bot.");
    } finally { await finish(bot.id); }
  });

  it("a No limits Gmail alias with a lost reply is sent once across a bridge restart", async () => {
    const { bot } = await newBot("Alias retry fixture");
    const accounts = [account("ca_a", "gmail")];
    let sends = 0;
    setConnectorAliasFixture({
      accounts, links: [], calls: 0,
      replyToMcpCall: (id) => ({
        jsonrpc: "2.0", id: ++sends === 1 ? "different-request" : id,
        result: { content: [{ type: "text", text: "Sent" }] },
      }),
    });
    try {
      await configure(bot.id, "restricted", false, [{ toolkit: "gmail", accountId: "ca_a", tools: ["GMAIL_FETCH_EMAILS"] }]);
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { noLimits: true, acknowledgeNoLimits: true, acknowledgeLocalAuto: true })).status).toBe(200);
      const { token } = await turnOf(bot.id);
      const input = { account: "ca_a", arguments: { recipient_email: "a@example.com", subject: "Retry fixture", body: "Hello" } };
      const first = await viaBridge(token, "gmail_send_email", input);
      expect({ sends, reply: first.text }).toEqual({ sends: 1, reply: expect.stringContaining("no answer came back") });
      // Each call starts a fresh bridge. The relay still owns the first attempt.
      const retry = await viaBridge(token, "gmail_send_email", input, 10);
      expect({ sends, reply: retry.text }).toEqual({ sends: 1, reply: expect.stringContaining("It was not run again") });
    } finally {
      await finish(bot.id);
      setConnectorAliasFixture(undefined);
    }
  });
});
