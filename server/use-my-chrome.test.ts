// "Use my Chrome": a per-bot opt-in that attaches ONE bot's browser to the
// owner's already-running Google Chrome instead of its own isolated profile.
//
// Boots the real harness (scripts/control-murage.ts) against a throwaway home
// with a fake agent-browser binary and a stubbed native relay that records the
// launch environment each session was created with. The owner's Chrome is
// played by a fake DevToolsActivePort file under the fixture's own HOME, so
// nothing here reaches a real browser.
//
// HEADLESS ONLY. Nothing opens a window, captures a screen, or touches the
// owner's ~/.murage; the fixture's port is pinned clear of the live app's 8799.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { browserSessionId } from "./browser-engine.ts";

const instrumentation = `
const fs = await import('node:fs');
const path = await import('node:path');
const { registerHooks } = await import('node:module');
process.env.MURAGE_USER_DATA = process.env.MURAGE_DATA_DIR;
const dataDir = fs.realpathSync(process.env.MURAGE_DATA_DIR);
const browserBinary = path.join(dataDir, 'fake-agent-browser');
fs.writeFileSync(browserBinary, '#!/bin/sh\\nexit 0\\n', { mode: 0o755 });
process.env.MURAGE_AGENT_BROWSER_PATH = browserBinary;
const sessionLog = path.join(dataDir, 'browser-sessions.json');
const record = \`function record(kind, session, extra) {
  const fs = require('node:fs');
  let log = [];
  try { log = JSON.parse(fs.readFileSync(\${JSON.stringify(sessionLog)}, 'utf8')); } catch {}
  log.push({ kind, session, ...(extra ?? {}) });
  fs.writeFileSync(\${JSON.stringify(sessionLog)}, JSON.stringify(log));
}\`;
registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('/browser-native-relay.ts')) return { format: 'module', shortCircuit: true, source: \`
    import { createRequire } from 'node:module';
    const require = createRequire(import.meta.url);
    \${record}
    export function createNativeBrowser(spec) {
      const session = spec.env.AGENT_BROWSER_SESSION;
      const pick = ['AGENT_BROWSER_CDP', 'AGENT_BROWSER_PIN_TAB', 'AGENT_BROWSER_RESTORE', 'AGENT_BROWSER_RESTORE_SAVE'];
      record('create', session, { env: Object.fromEntries(pick.filter(k => spec.env[k] !== undefined).map(k => [k, spec.env[k]])) });
      return {
        request: async (method, call) => {
          record('request', session, { method });
          return method === 'tools/list'
            ? { tools: [{ name: 'agent_browser_snapshot', inputSchema: { type: 'object', properties: {} } }] }
            : { content: [{ type: 'text', text: 'fixture page' }] };
        },
        protected: async () => false,
        resetStream() {}, input() {},
        command: async () => '',
        connect: async () => 'fixture-stream-' + session,
        close: async () => { record('close', session); },
      };
    }
  \` };
  if (url.endsWith('/browser-engine.ts')) {
    const source = fs.readFileSync(new URL(url), 'utf8');
    const start = source.indexOf('export async function verifyAgentBrowserBinary(');
    const end = source.indexOf('export async function ensureChrome(', start);
    if (start < 0 || end < 0) throw new Error('Browser version fixture anchor changed');
    return { format: 'module-typescript', shortCircuit: true, source: source.slice(0, start)
      + 'export async function verifyAgentBrowserBinary() {}' + String.fromCharCode(10)
      + source.slice(end) };
  }
  return nextLoad(url, context);
} });
const file = path.join(process.env.MURAGE_DATA_DIR, 'config.json');
const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
cfg.instances.second = { ...cfg.instances.verification, displayName: 'Second isolated engine', environment: { FAKE_CLAUDE_DUMP: path.join(process.env.MURAGE_DATA_DIR, 'second-dump.json') } };
fs.writeFileSync(file, JSON.stringify(cfg));
process.env.FAKE_CLAUDE_DUMP_EACH_TURN = '1';
`;

let fixture: VerificationServer;
let model: string;
let headers: Record<string, string> = {};
type LogEntry = { kind: string; session: string; method?: string; env?: Record<string, string> };

const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, {
    method, headers: { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any };
};
const dump = (second: boolean) => {
  try { return JSON.parse(readFileSync(second ? join(fixture.info.dataDir, "second-dump.json") : fixture.fixtureDumpPath, "utf8")); } catch { return null; }
};
const sessionLog = (): LogEntry[] => {
  try { return JSON.parse(readFileSync(join(fixture.info.dataDir, "browser-sessions.json"), "utf8")); } catch { return []; }
};
const state = async (id: string) => (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === id);
const makeBot = async (name: string, instanceId: "verification" | "second", patch: Record<string, unknown> = {}) => {
  const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId, model } });
  expect(created.status, `create ${name}: ${JSON.stringify(created.body)}`).toBe(201);
  const bot = created.body.bot;
  const configured = await api("PATCH", `/api/bots/${bot.id}`, { composio: false, computer: "off", ...patch });
  expect(configured.status, `configure ${name}: ${JSON.stringify(configured.body)}`).toBe(200);
  return bot;
};
const startTurn = async (bot: any, label: string, second: boolean) => {
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `__fixture_hold_authority__ ${label}` })).status).toBe(202);
  await expect.poll(() => JSON.stringify(dump(second)?.prompt ?? ""), { timeout: 15_000 }).toContain(label);
  return dump(second);
};
const stop = async (bot: any) => {
  await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }).catch(() => undefined);
  await expect.poll(async () => (await state(bot.id))?.busy === true, { timeout: 15_000 }).toBe(false);
  // A stopped turn's late turn.completed releases its thread's browser grant
  // with no owner scope, so it can revoke the NEXT turn's grant on the same
  // thread (a known, separate race; see per-bot-browser-computer.test.ts).
  // Let it land before a follow-up turn is started.
  await new Promise(resolve => setTimeout(resolve, 1_500));
};
const mountedBrowser = (captured: any) => captured?.mcpConfig?.mcpServers?.browser;
const browserRpc = (token: string) => fetch(`${fixture.info.url}/api/internal/unified-browser`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ method: "tools/list" }),
});
/** Drive one turn's browser and return the session it landed on. */
const driven = async (bot: any, label: string, second: boolean) => {
  const mounted = mountedBrowser(await startTurn(bot, label, second));
  expect(mounted, "expected a browser to be mounted").toBeTruthy();
  const mark = sessionLog().length;
  expect((await browserRpc(mounted.env.MURAGE_CONTROL_TOKEN)).status).toBe(200);
  await expect.poll(() => sessionLog().slice(mark).some(entry => entry.kind === "request"), { timeout: 10_000 }).toBe(true);
  return sessionLog().slice(mark).find(entry => entry.kind === "request")!.session;
};
const created = (session: string) => sessionLog().filter(entry => entry.kind === "create" && entry.session === session).at(-1);

/** Where Google Chrome keeps DevToolsActivePort for its default profile,
 * spelled out independently of the product resolver. */
const chromeDir = () => {
  const home = fixture.info.dataDir;
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "Google", "Chrome");
  if (process.platform === "win32") return join(home, "AppData", "Local", "Google", "Chrome", "User Data");
  return join(home, ".config", "google-chrome");
};
const BROWSER_ID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const enableRemoteDebugging = (port = 39222, id = BROWSER_ID) => {
  mkdirSync(chromeDir(), { recursive: true });
  writeFileSync(join(chromeDir(), "DevToolsActivePort"), `${port}\n/devtools/browser/${id}\n`);
};
const disableRemoteDebugging = () => rmSync(join(chromeDir(), "DevToolsActivePort"), { force: true });

beforeAll(async () => {
  fixture = await launchVerificationServer({}, undefined, { instrumentationSource: instrumentation, portRange: { from: 18_799, span: 1 } });
  const proof = await api("GET", "/api/desktop-secret");
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  model = (await api("GET", "/api/instances")).body.instances.find((instance: any) => instance.instanceId === "verification").models.options[0].id;
  expect((await api("PATCH", "/api/config", { features: { browser: true } })).status).toBe(200);
}, 60_000);

afterAll(async () => { await fixture?.close(); });

it("pins the fixture to its own port and a throwaway home, and answers from it", async () => {
  expect(fixture.info.url).toBe("http://127.0.0.1:18799");
  expect(fixture.info.dataDir).not.toContain(".murage");
  // Another suite may share this port range: prove the server answering is
  // this fixture by finding a bot it just created in this fixture's own file.
  const probe = await makeBot("Fixture ownership probe", "verification");
  expect(readFileSync(join(fixture.info.dataDir, "bots.json"), "utf8")).toContain(probe.id);
  expect((await api("DELETE", `/api/bots/${probe.id}`)).status).toBe(200);
});

it("is off by default: a new bot keeps its isolated profile even when the owner's Chrome is reachable", async () => {
  enableRemoteDebugging();
  const bot = await makeBot("Default isolated", "verification");
  try {
    expect((await state(bot.id)).useMyChrome).toBeUndefined();
    const session = await driven(bot, "default-isolated", false);
    expect(session).toBe(browserSessionId(bot.id, "", "original-installation"));
    expect(created(session)?.env).not.toHaveProperty("AGENT_BROWSER_CDP");
  } finally { await stop(bot); disableRemoteDebugging(); }
}, 60_000);

it("attaches an opted-in bot to the owner's Chrome in its own tab, never saving the owner's cookies", async () => {
  enableRemoteDebugging(39222);
  const bot = await makeBot("Uses my Chrome", "verification", { useMyChrome: true });
  try {
    expect((await state(bot.id)).useMyChrome).toBe(true);
    const session = await driven(bot, "attach-mine", false);
    // A separately tagged session: never the bot's isolated key, whose
    // restore file holds that profile's own cookies.
    expect(session).not.toBe(browserSessionId(bot.id, "", "original-installation"));
    const env = created(session)!.env!;
    expect(env.AGENT_BROWSER_CDP).toBe(`ws://127.0.0.1:39222/devtools/browser/${BROWSER_ID}`);
    // Own tab: unpinned, agent-browser drives whatever tab is active.
    expect(env.AGENT_BROWSER_PIN_TAB).toBe("1");
    // The owner's cookie jar is never exported into Murage's restore store.
    expect(env.AGENT_BROWSER_RESTORE_SAVE).toBe("never");
    expect(env).not.toHaveProperty("AGENT_BROWSER_RESTORE");
  } finally { await stop(bot); await api("PATCH", `/api/bots/${bot.id}`, { useMyChrome: false }); disableRemoteDebugging(); }
}, 60_000);

it("follows the owner's Chrome to its new connection after Chrome restarts", async () => {
  const restarted = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";
  enableRemoteDebugging(39222);
  const bot = await makeBot("Chrome restarts", "second", { useMyChrome: true });
  try {
    const before = await driven(bot, "restart-before", true);
    await stop(bot);
    enableRemoteDebugging(39333, restarted);
    const after = await driven(bot, "restart-after", true);
    expect(after).toBe(before);
    expect(created(after)?.env?.AGENT_BROWSER_CDP).toBe(`ws://127.0.0.1:39333/devtools/browser/${restarted}`);
    // The stale connection's session was closed before rebinding.
    expect(sessionLog().filter(entry => entry.kind === "close" && entry.session === before).length).toBeGreaterThan(0);
  } finally { await stop(bot); await api("PATCH", `/api/bots/${bot.id}`, { useMyChrome: false }); disableRemoteDebugging(); }
}, 60_000);

it("lets only one bot use the owner's Chrome at a time", async () => {
  const first = await makeBot("Chrome first", "verification", { useMyChrome: true });
  const second = await makeBot("Chrome second", "second");
  try {
    const refused = await api("PATCH", `/api/bots/${second.id}`, { useMyChrome: true });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("Chrome first");
    expect((await state(second.id)).useMyChrome).toBeUndefined();
    // Once the first bot lets go, the second may take it.
    expect((await api("PATCH", `/api/bots/${first.id}`, { useMyChrome: false })).status).toBe(200);
    expect((await api("PATCH", `/api/bots/${second.id}`, { useMyChrome: true })).status).toBe(200);
  } finally {
    for (const bot of [first, second]) await api("PATCH", `/api/bots/${bot.id}`, { useMyChrome: false });
  }
}, 60_000);

it("returns a bot to its own isolated profile, and closes its Chrome session, when switched back", async () => {
  enableRemoteDebugging();
  const bot = await makeBot("Switch back", "second", { useMyChrome: true });
  try {
    const attached = await driven(bot, "switch-attached", true);
    await stop(bot);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { useMyChrome: false })).status).toBe(200);
    expect(sessionLog().some(entry => entry.kind === "close" && entry.session === attached)).toBe(true);
    const isolated = await driven(bot, "switch-isolated", true);
    expect(isolated).toBe(browserSessionId(bot.id, "", "original-installation"));
    expect(created(isolated)?.env).not.toHaveProperty("AGENT_BROWSER_CDP");
  } finally { await stop(bot); disableRemoteDebugging(); }
}, 60_000);

it("closes a deleted bot's Chrome session and frees the opt-in for another bot", async () => {
  enableRemoteDebugging();
  const bot = await makeBot("Deleted holder", "verification", { useMyChrome: true });
  const next = await makeBot("Next holder", "second");
  try {
    const attached = await driven(bot, "delete-holder", false);
    await stop(bot);
    expect((await api("DELETE", `/api/bots/${bot.id}`)).status).toBe(200);
    expect(sessionLog().some(entry => entry.kind === "close" && entry.session === attached)).toBe(true);
    expect((await api("PATCH", `/api/bots/${next.id}`, { useMyChrome: true })).status).toBe(200);
  } finally { await api("PATCH", `/api/bots/${next.id}`, { useMyChrome: false }); disableRemoteDebugging(); }
}, 60_000);

it("says plainly how to turn Chrome's remote debugging on when it is off", async () => {
  disableRemoteDebugging();
  const bot = await makeBot("Chrome not ready", "verification", { useMyChrome: true });
  try {
    const panel = await api("GET", `/api/bots/${bot.id}/browser`);
    expect(panel.status).toBe(409);
    expect(panel.body.error).toContain("chrome://inspect/#remote-debugging");
  } finally { await api("PATCH", `/api/bots/${bot.id}`, { useMyChrome: false }); }
}, 60_000);

it("refuses a non-boolean opt-in", async () => {
  const bot = await makeBot("Bad opt-in", "verification");
  expect((await api("PATCH", `/api/bots/${bot.id}`, { useMyChrome: "yes" })).status).toBe(400);
  expect((await state(bot.id)).useMyChrome).toBeUndefined();
});
