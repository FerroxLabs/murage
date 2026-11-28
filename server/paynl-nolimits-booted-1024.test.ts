// SPDX-License-Identifier: AGPL-3.0-or-later
// MONEY #1 (MAIN, 1.0.24), booted-server witness: the REAL server (scripts/control-murage.ts) mounts the built-in browser for an owner's typed turn and hands the
// proxy MURAGE_BROWSER_NO_LIMITS only when the bot is at No limits; the turn's own bearer then asks /api/internal/unified-browser (method murage/floor-lift) and the
// production route answers from the live policy (browser-floor-lift.ts). Owners: lane q1024-paynl (witness), MAIN (policy). Entry: index.ts browserIntegrationInner
// env + the unified-browser route handler.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";
import { raiseLevel } from "./testing/raise-level.ts";

// Runs inside the harness child before server/index.ts loads; everything it writes stays under the throwaway data dir.
const instrumentation = `
const fs = await import('node:fs');
const path = await import('node:path');
const { registerHooks } = await import('node:module');
process.env.MURAGE_USER_DATA = process.env.MURAGE_DATA_DIR;
const dataDir = fs.realpathSync(process.env.MURAGE_DATA_DIR);
const browserBinary = path.join(dataDir, 'fake-agent-browser');
fs.writeFileSync(browserBinary, '#!/bin/sh\\nexit 0\\n', { mode: 0o755 });
process.env.MURAGE_AGENT_BROWSER_PATH = browserBinary;
// The browser engine is replaced by one that answers a call with the size of the text it was given (nothing is launched).
registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('/browser-native-relay.ts')) return { format: 'module', shortCircuit: true, source: \`
    export function createNativeBrowser(spec) {
      return {
        request: async (method, call) => method === 'tools/list'
          ? { tools: [{ name: 'agent_browser_snapshot', inputSchema: { type: 'object', properties: {} } }] }
          : { content: [{ type: 'text', text: 'browser-got=' + String((call && call.arguments && call.arguments.selector) || '').length }] },
        protected: async () => false,
        resetStream() {}, input() {},
        command: async () => '',
        connect: async () => 'fixture-stream',
        close: async () => {},
      };
    }
  \` };
  if (url.endsWith('/browser-engine.ts')) {
    const source = fs.readFileSync(new URL(url), 'utf8');
    const start = source.indexOf('export async function verifyAgentBrowserBinary(');
    const end = source.indexOf('export async function ensureChrome(', start);
    if (start < 0 || end < 0) throw new Error('Browser version fixture anchor changed');
    // The engine refuses a container host (no browser is launched there). The fake engine launches nothing, so the fixture lets
    // the mount through: the thing under test is the route's body read, not the host check.
    const hostCheck = 'if (browserHostRequiresSandboxBypass({';
    if (!source.includes(hostCheck)) throw new Error('Browser host fixture anchor changed');
    return { format: 'module-typescript', shortCircuit: true, source: (source.slice(0, start)
      + 'export async function verifyAgentBrowserBinary() {}' + String.fromCharCode(10) + source.slice(end)).replace(hostCheck, 'if (false && browserHostRequiresSandboxBypass({') };
  }
  return nextLoad(url, context);
} });
// a second engine slot, so the control bot's turn is held next to the owner bot's
const file = path.join(process.env.MURAGE_DATA_DIR, 'config.json');
const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
cfg.instances.second = { ...cfg.instances.verification, displayName: 'Second isolated engine', environment: { FAKE_CLAUDE_DUMP: path.join(process.env.MURAGE_DATA_DIR, 'second-dump.json') } };
fs.writeFileSync(file, JSON.stringify(cfg));
process.env.FAKE_CLAUDE_DUMP_EACH_TURN = '1';
`;


let fixture: VerificationServer;
let headers: Record<string, string> = {};
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const dump = (second = false) => { try { return withTurnSecrets(JSON.parse(readFileSync(second ? join(fixture.info.dataDir, "second-dump.json") : fixture.fixtureDumpPath, "utf8"))); } catch { return null; } };
const lift = async (token: string) => {
  const response = await fetch(fixture.info.url + "/api/internal/unified-browser", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ method: "murage/floor-lift", params: {} }) });
  return { status: response.status, body: await response.json().catch(() => null) as { lift?: boolean } | null };
};
type Env = Record<string, string> | undefined;
let model = "";
/** A bot with the given permission patch; its owner-typed turn is held so the mounted proxy's capability stays live. */
async function heldBrowserTurn(name: string, noLimits: boolean, tag: string, instanceId: string, second: boolean): Promise<Env> {
  const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId, model } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const bot = created.body.bot;
  const patched = await api("PATCH", `/api/bots/${bot.id}`, { composio: false, computer: "off", browser: true });
  expect(patched.status, JSON.stringify(patched.body)).toBe(200);
  if (noLimits) await raiseLevel(api, bot.id, { autoApprove: true, fullAccess: true, noLimits: true, acknowledgeNoLimits: true, acknowledgeLocalAuto: true });
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `__fixture_hold_authority__ ${tag}` })).status).toBe(202);
  for (let waited = 0; waited < 30_000 && !JSON.stringify(dump(second)?.prompt ?? "").includes(tag); waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
  const servers = dump(second)?.mcpConfig?.mcpServers ?? {};
  return servers.browser?.env as Env;
}
let ownerEnv: Env, controlEnv: Env;
beforeAll(async () => {
  fixture = await launchVerificationServer({}, undefined, { instrumentationSource: instrumentation, portRange: { from: 45_400, span: 90 } });
  const proof = await api("GET", "/api/desktop-secret");
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  expect((await api("PATCH", "/api/config", { features: { browser: true } })).status).toBe(200);
  model = (await api("GET", "/api/instances")).body.instances.find((instance: any) => instance.instanceId === "verification").models.options[0].id;
  ownerEnv = await heldBrowserTurn("Paynl owner no limits", true, "paynl-owner-nolimits", "verification", false);
}, 120_000);
afterAll(async () => { await fixture?.close(); });

describe("M7 booted server: the built-in browser mount and its floor-lift route", () => {
  it("an owner-typed turn at No limits: the proxy is handed the flag at the mount; once the turn carries an outside mark the route keeps the floor (MAIN-RULING, tip audit High 1: no outside mark of any source lifts it)", async () => {
    expect(ownerEnv, "the built-in browser was mounted for this turn").toBeTruthy();
    expect(ownerEnv!.MURAGE_BROWSER_NO_LIMITS).toBe("1");
    const answer = await lift(ownerEnv!.MURAGE_CONTROL_TOKEN);
    expect(answer).toEqual({ status: 200, body: { lift: false } });
  }, 60_000);
});
describe("M7 booted server: below No limits the floor stays", () => {
  it("an owner-typed turn at the default level: no flag, and the route answers lift:false", async () => {
    controlEnv = await heldBrowserTurn("Paynl default level", false, "paynl-default-level", "second", true);
    expect(controlEnv, "the built-in browser was mounted for the control turn").toBeTruthy();
    expect(controlEnv!.MURAGE_BROWSER_NO_LIMITS).toBeUndefined();
    expect(await lift(controlEnv!.MURAGE_CONTROL_TOKEN)).toEqual({ status: 200, body: { lift: false } });
  }, 90_000);
});
