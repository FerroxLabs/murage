// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MCP-LINK T15: a server added by pasting a link, end to end, through the real
// harness and main's real sign-in code, against the fake remote MCP server and
// its fake authorization server (testing/fake-remote-mcp.ts).
//
// The harness runs as the desktop app runs it (testing/desktop-shell.ts):
// node server/index.ts with Electron's private parent port, MURAGE_MCP_SERVER_SECRETS
// at every start, and main's own MCP service (electron/mcp-signin/service.mjs,
// the T11 code main.mjs builds) over an in-memory credentials.bin. Electron
// itself is not started: nothing in the sign-in needs it beyond shell.openExternal
// and safeStorage, which the fake browser and the in-memory store stand in for.
//
// Steps (spec 8/T15):
//   1. inspect a link: needs-sign-in
//   2. sign in through main (DCR, PKCE, loopback) with the fake browser
//   3. Test ok
//   4. Turn on
//   5. one turn per engine class (Claude, Codex, ACP, pi) calls the first tool
//      through the proxy (the fakes' "call first custom tool" mode)
//   6. the access token expires mid-turn: refresh, and the call succeeds
//   +  a tool that needs more access: card, step-up sign-in asks for it, resume
//   +  a restart while a card waits: the token main hands over again resumes nothing
//   7. the refresh token is revoked: the chat card, sign in, the turn resumes
//   8. remove: revoke hit, secrets gone
// plus an API key run and a legacy SSE run, and the grep: no token of the fake
// anywhere under the run's temp directory, in the engines' launch env or argv.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir } from "./testing/cleanup.ts";
import { startDesktopShell, type DesktopShell } from "./testing/desktop-shell.ts";
import { startFakeRemoteMcp, type FakeRemoteMcp } from "./testing/fake-remote-mcp.ts";
import { mcpSignInToolText } from "./mcp-signin-card.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKES = {
  claude: join(SERVER_DIR, "testing", "fake-claude-cli.ts"),
  codex: join(SERVER_DIR, "testing", "fake-codex-app-server.ts"),
  acp: join(SERVER_DIR, "testing", "fake-acp-cli.ts"),
  pi: join(SERVER_DIR, "testing", "fake-pi-cli.ts"),
};
const ENGINES = [
  { engine: "claude", instanceId: "claude", model: "claude-sonnet-5" },
  { engine: "codex", instanceId: "codex", model: "gpt-fake-default" },
  { engine: "acp", instanceId: "acp", model: "fake-model" },
  { engine: "pi", instanceId: "pi", model: "ollama-cloud/glm-5.2" },
] as const;
const posixOnly = describe.skipIf(process.platform === "win32");

interface ToolLine {
  engine: string; server: string; tools: string[]; tool?: string; text: string; isError: boolean; prompt: string;
  launch: { argv: string[]; env: Record<string, string>; turnSecrets?: Record<string, string> }; engineArgv: string[];
}

let home = "";
let toolLog = "";
let shell: DesktopShell;
let oauth: FakeRemoteMcp;
let keyed: FakeRemoteMcp;
let legacy: FakeRemoteMcp;
const API_KEY = "fake-key-e2e-5c1f0a9b7d3e";
const LEGACY_KEY = "fake-key-legacy-0e9d8c7b";
const bots = new Map<string, { id: string; threadId: string }>();

const toolLines = (): ToolLine[] => existsSync(toolLog) ? readFileSync(toolLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as ToolLine) : [];
const messages = async (threadId: string) => (await shell.desktop("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as Array<Record<string, any>>;
const cards = async (threadId: string) => (await messages(threadId)).filter((message) => message.kind === "mcpSignIn");
const busy = async (botId: string) => Boolean(((await shell.desktop("GET", "/api/bots?messages=0")).body.bots as Array<{ id: string; busy?: boolean }>).find((bot) => bot.id === botId)?.busy);
const listing = async () => (await shell.desktop("GET", "/api/mcp/servers")).body.servers as Array<Record<string, any>>;

async function botFor(engine: string, instanceId: string, model: string) {
  const known = bots.get(engine);
  if (known) return known;
  const created = await shell.desktop("POST", "/api/bots", { name: `Link ${engine}`, modelSelection: { instanceId, model } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await shell.desktop("PATCH", `/api/bots/${bot.id}`, { computer: "off" })).status).toBe(200);
  bots.set(engine, bot);
  return bot;
}

/** One owner turn; resolves the custom-tool line(s) it wrote once the bot is idle again. */
async function turn(bot: { id: string; threadId: string }, text: string, { lines = 1, timeout = 60_000 } = {}): Promise<ToolLine[]> {
  const before = toolLines().length;
  const sent = await shell.desktop("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await expect.poll(() => toolLines().length - before, { timeout }).toBeGreaterThanOrEqual(lines);
  await expect.poll(() => busy(bot.id), { timeout }).toBe(false);
  return toolLines().slice(before);
}

const lastBearer = (fake: FakeRemoteMcp, tool = "echo") => {
  const call = [...fake.requests].reverse().find((request) => request.method === "POST" && request.path === "/mcp" && request.body.includes(`"name":"${tool}"`));
  return /^Bearer (.+)$/.exec(String(call?.headers.authorization ?? ""))?.[1];
};

/** Every file under `dir`, as raw bytes in latin1 so a binary file is searched too. */
function everyFile(dir: string): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    let stat;
    try { stat = statSync(path); } catch { continue; }
    if (stat.isDirectory()) out.push(...everyFile(path));
    else if (stat.isFile()) out.push({ path, text: readFileSync(path).toString("latin1") });
  }
  return out;
}

posixOnly("MCP-LINK T15: a link server end to end", () => {
  beforeAll(async () => {
    for (const cli of Object.values(FAKES)) chmodSync(cli, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-mcp-link-e2e-"));
    toolLog = join(home, "custom-tool.jsonl");
    mkdirSync(join(home, ".murage"), { recursive: true });
    // grok's ACP support needs a sign-in marker
    mkdirSync(join(home, ".grok"), { recursive: true });
    writeFileSync(join(home, ".grok", "auth.json"), "{}");
    const environment = { FAKE_CUSTOM_TOOL_SERVER: "comfy", FAKE_CUSTOM_TOOL_LOG: toolLog };
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({
      engineDiscovery: "explicit",
      instances: {
        claude: { driver: "claudeAgent", environment, config: { cli: FAKES.claude } },
        codex: { driver: "codex", environment, config: { cli: FAKES.codex, fullAuto: true } },
        acp: { driver: "grokAgent", environment, config: { cli: FAKES.acp, fullAuto: false } },
        pi: { driver: "piAgent", environment, config: { cli: FAKES.pi, fullAuto: false } },
      },
    }));
    // ComfyUI's shape (spec 2.4): a 401 naming the PRM and a scope; sign-in by DCR + PKCE.
    oauth = await startFakeRemoteMcp({ auth: "bearer", unauthorized: "comfy" });
    keyed = await startFakeRemoteMcp({ auth: "api-key", apiKey: API_KEY, apiKeyHeader: "x-api-key", unauthorized: "api-key-only", prm: false });
    legacy = await startFakeRemoteMcp({ auth: "api-key", apiKey: LEGACY_KEY, apiKeyHeader: "x-api-key", unauthorized: "api-key-only", prm: false, transport: "sse" });
    shell = await startDesktopShell({ home });
  }, 60_000);

  afterAll(async () => {
    await shell?.stop();
    await Promise.all([oauth?.close(), keyed?.close(), legacy?.close()]);
    if (home) await removeTempDir(home);
  });

  it("1. a pasted link that asks for sign-in is needs-sign-in, and inspecting saves nothing", async () => {
    const inspected = await shell.desktop("POST", "/api/mcp/inspect", { input: oauth.mcpUrl, confirmLocal: "this-computer" });
    expect(inspected.status, JSON.stringify(inspected.body)).toBe(200);
    expect(inspected.body.drafts[0]).toMatchObject({ kind: "remote", probe: { ok: false, reason: "needs-sign-in" } });
    expect(await listing()).toEqual([]);
  });

  it("2. sign-in runs in main: DCR, PKCE, the fake browser, and main pushes only the access token", async () => {
    const created = await shell.desktop("POST", "/api/mcp/servers", { name: "comfy", url: oauth.mcpUrl, confirmLocal: "this-computer", auth: "oauth" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(await shell.service.signIn("comfy")).toEqual({ ok: true });
    expect(oauth.registrations).toHaveLength(1);
    expect(oauth.authorizeRequests[0]).toMatchObject({ code_challenge_method: "S256", resource: oauth.mcpUrl, scope: "comfy-mcp:tools:call" });
    const doc = (shell.credentials().mcpServerSecrets as Record<string, any>).comfy;
    expect(doc.oauth.accessToken).toBe(oauth.issuedAccessTokens().at(-1));
    expect(doc.oauth.refreshToken).toBe(oauth.issuedRefreshTokens().at(-1));
    expect((await listing()).find((entry) => entry.name === "comfy")).toMatchObject({ kind: "remote", auth: "oauth", status: "ready", enabled: false });
  });

  it("3 and 4. Test is ok with the pushed token, then the server is turned on", async () => {
    const tested = await shell.desktop("POST", "/api/mcp/servers/comfy/test", {});
    expect(tested.body).toMatchObject({ ok: true, tools: [{ name: "echo" }, { name: "sum" }] });
    const held = (shell.credentials().mcpServerSecrets as Record<string, any>).comfy.oauth.accessToken;
    expect(oauth.requests.filter((request) => request.method === "POST" && request.path === "/mcp").at(-1)?.headers.authorization).toBe(`Bearer ${held}`);
    expect((await shell.desktop("PATCH", "/api/mcp/servers/comfy", { enabled: true })).status).toBe(200);
  });

  for (const { engine, instanceId, model } of ENGINES) {
    it(`5. a ${engine} turn calls the first tool through the proxy`, async () => {
      const bot = await botFor(engine, instanceId, model);
      const [line] = await turn(bot, "use my comfy tools");
      expect(line).toMatchObject({ engine, server: "comfy", tools: ["echo", "sum"], tool: "echo", text: `hello from ${engine}`, isError: false });
      // the engine was handed the proxy, by name in argv, and a turn token: no link, no credential
      expect(line!.launch.argv[1]).toMatch(/remote-mcp-proxy\.(ts|js)$/);
      expect(line!.launch.argv.slice(2)).toEqual(["--server", "comfy"]);
      // claude and codex carry it in the per-process credential file, the others in env
      expect(line!.launch.env.MURAGE_MCP_TOKEN ?? line!.launch.turnSecrets?.MURAGE_MCP_TOKEN).toMatch(/^[a-f0-9]{48}$/);
      expect(JSON.stringify(line!.launch)).not.toContain(oauth.mcpUrl);
      expect(oauth.toolCalls.at(-1)).toEqual({ name: "echo", arguments: { text: `hello from ${engine}` } });
      expect(lastBearer(oauth)).toBe((shell.credentials().mcpServerSecrets as Record<string, any>).comfy.oauth.accessToken);
    }, 90_000);
  }

  it("6. an access token that expired mid-turn is refreshed by main and the call succeeds", async () => {
    const before = (shell.credentials().mcpServerSecrets as Record<string, any>).comfy.oauth;
    // initialize and tools/list pass, then the token expires before the tool call
    oauth.options.expireOnToolsList = true;
    const [line] = await turn(bots.get("claude")!, "use comfy again");
    expect(line).toMatchObject({ text: "hello from claude", isError: false });
    expect(shell.privateMessages).toContainEqual({ type: "murage:mcp-token-rejected", name: "comfy" });
    expect(oauth.tokenRequests.at(-1)).toMatchObject({ grant_type: "refresh_token", refresh_token: before.refreshToken, resource: oauth.mcpUrl });
    const after = (shell.credentials().mcpServerSecrets as Record<string, any>).comfy.oauth;
    expect(after.accessToken).not.toBe(before.accessToken);
    expect(after.refreshToken).not.toBe(before.refreshToken);
    expect(lastBearer(oauth)).toBe(after.accessToken);
  }, 90_000);

  it("step-up: a tool refused for scope puts a card up, and the next sign-in asks for that scope and resumes", async () => {
    oauth.options.requireScopeForTool = { tool: "echo", scope: "tools:write" };
    const bot = bots.get("codex")!;
    const [refused] = await turn(bot, "use comfy with more access");
    expect(refused!.isError).toBe(true);
    const [card] = await cards(bot.threadId);
    expect(card!.mcpSignIn).toMatchObject({ name: "comfy", reason: "needs-more-access", scope: "tools:write", status: "required", botId: bot.id });
    // the engine read the end-the-turn sentence, never the scope or a token
    expect(refused!.text).toContain(mcpSignInToolText("comfy", "127.0.0.1"));
    // T13 -> T11: the sign-in target carries the scope, main asks for the union
    const target = await shell.commit("GET", "/api/mcp/servers/comfy/oauth-target");
    expect(target.body.scopeHint.split(" ")).toEqual(expect.arrayContaining(["comfy-mcp:tools:call", "tools:write"]));
    const linesBefore = toolLines().length;
    expect(await shell.service.signIn("comfy")).toEqual({ ok: true });
    expect(oauth.authorizeRequests.at(-1)!.scope.split(" ")).toEqual(expect.arrayContaining(["comfy-mcp:tools:call", "tools:write"]));
    await expect.poll(async () => (await cards(bot.threadId))[0]?.mcpSignIn.status, { timeout: 20_000 }).toBe("signed-in");
    await expect.poll(() => toolLines().length - linesBefore, { timeout: 60_000 }).toBeGreaterThanOrEqual(1);
    const after = toolLines().slice(linesBefore);
    expect(after[0]).toMatchObject({ engine: "codex", text: "hello from codex", isError: false });
    expect(after[0]!.prompt).toContain("signed in");
    await expect.poll(() => busy(bot.id), { timeout: 60_000 }).toBe(false);
    oauth.options.requireScopeForTool = undefined;
  }, 120_000);

  it("restart while a card waits: the token main hands over again at start-up resumes nothing; a new sign-in does", async () => {
    const bot = bots.get("pi")!;
    // the authorization server is down, so main keeps the token it has; the relay gives up after its wait
    oauth.options.refreshMode = "unavailable";
    oauth.options.expireOnToolsList = true;
    const [ended] = await turn(bot, "use comfy while the sign-in server is down", { timeout: 90_000 });
    expect(ended!.isError).toBe(true);
    const [card] = await cards(bot.threadId);
    expect(card!.mcpSignIn).toMatchObject({ reason: "sign-in-ended", status: "required" });
    const stale = (shell.credentials().mcpServerSecrets as Record<string, any>).comfy.oauth;
    expect(stale.accessToken).toBeTruthy();
    expect(stale.signedInAt).toBeLessThan(card!.at);

    await shell.restart();
    // the boot env and the resume push both carried the stale token: still waiting
    expect((await cards(bot.threadId))[0]!.mcpSignIn.status).toBe("required");
    const early = await shell.desktop("POST", `/api/bots/${bot.id}/mcp-sign-in-cards/${card!.id}/resume`, { threadId: bot.threadId });
    expect(early.status).toBe(409);
    expect(await busy(bot.id)).toBe(false);

    oauth.options.refreshMode = "rotate";
    const linesBefore = toolLines().length;
    expect(await shell.service.signIn("comfy")).toEqual({ ok: true });
    await expect.poll(async () => (await cards(bot.threadId))[0]?.mcpSignIn.status, { timeout: 20_000 }).toBe("signed-in");
    await expect.poll(() => toolLines().length - linesBefore, { timeout: 60_000 }).toBeGreaterThanOrEqual(1);
    expect(toolLines()[linesBefore]).toMatchObject({ engine: "pi", text: "hello from pi", isError: false });
    await expect.poll(() => busy(bot.id), { timeout: 60_000 }).toBe(false);
  }, 180_000);

  it("7. a revoked refresh token puts the sign-in card in the chat and the Inbox; signing in resumes the turn", async () => {
    // main's reactive refresh cool-down (30 s) from step 6 has passed: the restart run waited out the relay
    const bot = bots.get("acp")!;
    oauth.revokeRefreshTokens();
    oauth.expireAccessTokens();
    const [ended] = await turn(bot, "use comfy once more");
    expect(ended!.isError).toBe(true);
    expect(ended!.text).toContain(mcpSignInToolText("comfy", "127.0.0.1"));
    const [card] = await cards(bot.threadId);
    expect(card!.mcpSignIn).toMatchObject({ name: "comfy", reason: "sign-in-ended", status: "required" });
    // main cleared the dead tokens and kept the client
    const doc = (shell.credentials().mcpServerSecrets as Record<string, any>).comfy;
    expect(doc.oauth.accessToken).toBeUndefined();
    expect(doc.oauth.clientId).toBeTruthy();
    // the owner's Inbox owes it too
    const inbox = await shell.desktop("GET", "/api/inbox?view=connections");
    expect(inbox.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ title: "Sign in to 127.0.0.1", status: "pending", dismissVia: "mcp-sign-in", link: expect.objectContaining({ messageId: card!.id }) })]));
    const linesBefore = toolLines().length;
    expect(await shell.service.signIn("comfy")).toEqual({ ok: true });
    await expect.poll(async () => (await cards(bot.threadId))[0]?.mcpSignIn.status, { timeout: 20_000 }).toBe("signed-in");
    await expect.poll(() => toolLines().length - linesBefore, { timeout: 60_000 }).toBeGreaterThanOrEqual(1);
    expect(toolLines()[linesBefore]).toMatchObject({ engine: "acp", text: "hello from acp", isError: false });
    expect(toolLines()[linesBefore]!.prompt).toContain("signed in");
    await expect.poll(() => busy(bot.id), { timeout: 60_000 }).toBe(false);
    expect((await shell.desktop("GET", "/api/inbox?view=connections")).body.items.some((item: { link: { messageId: string } }) => item.link.messageId === card!.id)).toBe(false);
  }, 120_000);

  it("T11-1: a turn whose very first call (initialize) meets a rejected token while the sign-in server is down still gets the card", async () => {
    const bot = bots.get("claude")!;
    const cardsBefore = (await cards(bot.threadId)).length;
    // every token is dead and main cannot refresh: the relay's token wait has to end
    // before the proxy's 30 s initialize limit, or the card is dropped with the turn
    oauth.options.refreshMode = "unavailable";
    oauth.expireAccessTokens();
    const [ended] = await turn(bot, "use comfy while the sign-in server is down, first call", { timeout: 90_000 });
    expect(ended!.isError).toBe(true);
    expect(ended!.text).toContain(mcpSignInToolText("comfy", "127.0.0.1"));
    const all = await cards(bot.threadId);
    expect(all).toHaveLength(cardsBefore + 1);
    expect(all.at(-1)!.mcpSignIn).toMatchObject({ name: "comfy", reason: "sign-in-ended", status: "required", botId: bot.id });
    // leave the run as it was: the server is back, sign in, the turn resumes
    oauth.options.refreshMode = "rotate";
    const linesBefore = toolLines().length;
    expect(await shell.service.signIn("comfy")).toEqual({ ok: true });
    await expect.poll(async () => (await cards(bot.threadId)).at(-1)?.mcpSignIn.status, { timeout: 20_000 }).toBe("signed-in");
    await expect.poll(() => toolLines().length - linesBefore, { timeout: 60_000 }).toBeGreaterThanOrEqual(1);
    await expect.poll(() => busy(bot.id), { timeout: 60_000 }).toBe(false);
  }, 180_000);

  it("8. remove revokes first, then the entry and every secret are gone", async () => {
    const held = (shell.credentials().mcpServerSecrets as Record<string, any>).comfy.oauth;
    const removed = await shell.service.remove("comfy");
    expect(removed).toEqual({ ok: true, revoked: true, message: "Removed. Murage also signed you out of 127.0.0.1." });
    expect(oauth.revocationRequests.slice(-2).map((row) => row.token)).toEqual([held.refreshToken, held.accessToken]);
    expect((await listing()).some((entry) => entry.name === "comfy")).toBe(false);
    expect((shell.credentials().mcpServerSecrets as Record<string, unknown> | undefined)?.comfy).toBeUndefined();
    // the harness copy is gone too: a push for it now has no entry to land on
    expect((await shell.commit("PUT", "/api/mcp/servers/comfy/secrets", { origin: oauth.origin, oauth: { accessToken: "x" } })).status).toBe(404);
  });

  it("an API key run: the key goes renderer -> main -> harness, Test, Turn on, and a turn's call", async () => {
    expect((await shell.desktop("POST", "/api/mcp/inspect", { input: keyed.mcpUrl, confirmLocal: "this-computer" })).body.drafts[0].probe).toMatchObject({ ok: false, reason: "needs-key" });
    // a value in the body is refused: the desktop shell holds values
    expect((await shell.desktop("POST", "/api/mcp/servers", { name: "keyed", url: keyed.mcpUrl, confirmLocal: "this-computer", auth: "header", headers: { "x-api-key": API_KEY } })).status).toBe(400);
    expect((await shell.desktop("POST", "/api/mcp/servers", { name: "keyed", url: keyed.mcpUrl, confirmLocal: "this-computer", auth: "header", headers: { "x-api-key": true } })).status).toBe(201);
    expect(await shell.service.saveSecrets("keyed", { headers: { "x-api-key": API_KEY } })).toEqual({ ok: true });
    expect((await shell.desktop("POST", "/api/mcp/servers/keyed/test", {})).body).toMatchObject({ ok: true });
    expect((await shell.desktop("PATCH", "/api/mcp/servers/keyed", { enabled: true })).status).toBe(200);
    const [line] = await turn(bots.get("claude")!, "__custom_tool__:keyed");
    expect(line).toMatchObject({ engine: "claude", server: "keyed", text: "hello from claude", isError: false });
    expect(keyed.requests.filter((request) => request.method === "POST").at(-1)!.headers["x-api-key"]).toBe(API_KEY);
    expect(JSON.stringify(await listing())).not.toContain(API_KEY);
  }, 90_000);

  it("a legacy SSE run: Test falls back to HTTP+SSE, saves the transport, and a turn's call rides the stream", async () => {
    expect((await shell.desktop("POST", "/api/mcp/servers", { name: "legacy", url: legacy.mcpUrl, confirmLocal: "this-computer", auth: "header", headers: { "x-api-key": true } })).status).toBe(201);
    expect(await shell.service.saveSecrets("legacy", { headers: { "x-api-key": LEGACY_KEY } })).toEqual({ ok: true });
    expect((await shell.desktop("POST", "/api/mcp/servers/legacy/test", {})).body).toMatchObject({ ok: true, transport: "sse" });
    expect((await listing()).find((entry) => entry.name === "legacy")).toMatchObject({ transport: "sse" });
    expect((await shell.desktop("PATCH", "/api/mcp/servers/legacy", { enabled: true })).status).toBe(200);
    const [line] = await turn(bots.get("codex")!, "__custom_tool__:legacy");
    expect(line).toMatchObject({ engine: "codex", server: "legacy", text: "hello from codex", isError: false });
    expect(legacy.toolCalls.at(-1)).toEqual({ name: "echo", arguments: { text: "hello from codex" } });
    expect(legacy.requests.some((request) => request.method === "GET" && request.path === "/mcp")).toBe(true);
  }, 90_000);

  it("no token of the fakes is anywhere under the run's temp directory, nor in any engine's launch env or argv", async () => {
    const secrets = [...oauth.issuedAccessTokens(), ...oauth.issuedRefreshTokens(), API_KEY, LEGACY_KEY];
    expect(secrets.length).toBeGreaterThan(6);
    const files = everyFile(home);
    expect(files.some((file) => file.path === toolLog)).toBe(true);
    expect(files.some((file) => file.path.endsWith("config.json"))).toBe(true);
    const leaks = files.flatMap((file) => secrets.filter((secret) => file.text.includes(secret)).map((secret) => `${file.path}: ${secret.slice(0, 6)}…`));
    expect(leaks).toEqual([]);
    const lines = toolLines();
    expect(new Set(lines.map((line) => line.engine))).toEqual(new Set(["claude", "codex", "acp", "pi"]));
    for (const line of lines) {
      const launch = JSON.stringify([line.launch, line.engineArgv]);
      for (const secret of secrets) expect(launch.includes(secret), `${line.engine} launch`).toBe(false);
    }
    for (const secret of secrets) expect(shell.stderr().includes(secret)).toBe(false);
    for (const line of shell.log) for (const secret of secrets) expect(line.includes(secret)).toBe(false);
  });
});
