import { once } from "node:events";
import { readFileSync, mkdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

import { turnSecret } from "./turn-credential.ts";
import { BROWSER_HELD_FOR_ANSWER_REASON } from "../shared/browser-unavailable.ts";

let fixture: VerificationServer, headers: Record<string, string>, model: string;
const sockets: Socket[] = [];
const evidence: unknown[] = [];
const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() as any };
};
const messages = async (thread: string) => (await api("GET", `/api/threads/${thread}/messages?limit=100`)).body.messages as any[];
beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const fs = await import('node:fs'); const path = await import('node:path');
    process.env.MURAGE_AGENT_BROWSER_PATH = process.execPath;
    process.env.FAKE_CLAUDE_DUMP_EACH_TURN = '1';
    const file = path.join(process.env.MURAGE_DATA_DIR, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8')); cfg.features = { browser: true };
    fs.writeFileSync(file, JSON.stringify(cfg));
    // This fixture supplies only its own question, never a HighLevel operation.
    // The base's provisional HighLevel ledger cannot classify a raw broker ask.
    const { installHighlevelEngineLedger } = await import(${JSON.stringify(new URL('./highlevel/engine-policy.ts', import.meta.url).href)});
    installHighlevelEngineLedger({ classOf: (_thread, _generation, id) => id === 'owner-question' ? 'other' : 'inert' });
    const { registerHooks } = await import('node:module');
    registerHooks({ load(url, context, next) {
      if (url.endsWith('/browser-extension-approvals.ts')) {
        const source = fs.readFileSync(new URL(url), 'utf8');
        return { format: 'module-typescript', shortCircuit: true, source: source.replace('const waitMs = input.waitMs ?? 45000;', "const waitMs = fs.existsSync(process.env.MURAGE_DATA_DIR + '/short-approval-wait') ? 3000 : input.waitMs ?? 45000;") };
      }
      if (url.endsWith('/browser-extension-broker.ts')) return { format: 'module', shortCircuit: true, source: 'export { startBrowserExtensionBroker } from '+JSON.stringify(${JSON.stringify(new URL('./testing/browser-wait-extension.ts', import.meta.url).href)})+';' };
      if (url.endsWith('/browser-extension-integration.ts')) {
        const source = fs.readFileSync(new URL(url), 'utf8');
        return { format: 'module-typescript', shortCircuit: true, source: 'import { extensionFixture } from '+JSON.stringify(${JSON.stringify(new URL('./testing/browser-wait-extension.ts', import.meta.url).href)})+';\\n'+source.replace('this.options = options;', 'this.options = { ...options, createEngine: extensionFixture.createEngine, collectFacts: extensionFixture.collectFacts };') };
      }
      if (url.endsWith('/browser-native-relay.ts')) return { format: 'module', shortCircuit: true, source: \`
        import {existsSync, writeFileSync} from 'node:fs'; import {join} from 'node:path';
        export function createNativeBrowser() { return {
          request: async (method, params) => {
            const gate = join(process.env.MURAGE_DATA_DIR, 'browser-call-hold');
            if (params?.name === 'agent_browser_snapshot' && existsSync(gate)) {
              writeFileSync(gate + '.entered', '');
              while (existsSync(gate)) await new Promise(resolve => setTimeout(resolve, 10));
            }
            return method === 'tools/list' ? {tools: [{name: 'agent_browser_snapshot', inputSchema: {type: 'object', properties: {}}}]} : {content: [{type: 'text', text: 'fixture page'}]};
          },
          protected: async () => false, resetStream() {}, input() {}, command: async () => '', connect: async () => 'fixture-stream', close: async () => {},
        }; }
      \` };
      if (url.endsWith('/browser-engine.ts')) {
        // No native executable runs in this fixture; only its spec is constructed.
        const source = fs.readFileSync(new URL(url), 'utf8').replace('if (browserHostRequiresSandboxBypass({', 'if (false && browserHostRequiresSandboxBypass({');
        const start = source.indexOf('export async function verifyAgentBrowserBinary(');
        const end = source.indexOf('export async function ensureChrome(', start);
        if (start < 0 || end < 0) throw new Error('fixture anchor changed');
        return { format: 'module-typescript', shortCircuit: true, source: source.slice(0, start) + 'export async function verifyAgentBrowserBinary() {}\\n' + source.slice(end) };
      }
      return next(url, context);
    } });
  ` });
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await api("GET", "/api/desktop-secret")).body.secret };
  model = (await api("GET", "/api/instances")).body.instances.find((i: any) => i.instanceId === "verification").models.options[0].id;
}, 120_000);
afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  if (fixture && process.env.BROWSER_WAIT_EVIDENCE) {
    const dir = process.env.BROWSER_WAIT_EVIDENCE; mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "workflow.json"), JSON.stringify({ info: fixture.info, evidence }, null, 2));
    writeFileSync(join(dir, "server.log"), readFileSync(fixture.info.logPath));
  }
  await fixture?.close();
});
async function hold(botId: string, threadId: string, label: string) {
  label = `${label}-${threadId}`;
  expect((await api("POST", `/api/bots/${botId}/messages`, { threadId, text: `__fixture_hold_authority__ ${label} Open https://fixture.test/` })).status).toBe(202);
  let dump: any;
  await expect.poll(() => { try { dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")); return JSON.stringify(dump.prompt).includes(label); } catch { return false; } }, { timeout: 20_000 }).toBe(true);
  const status = await api("GET", `/api/bots/${botId}/browser-extension`);
  const binding = status.body.bindings?.find((b: any) => b.threadId === threadId);
  if (binding) expect((await api("POST", `/api/bots/${botId}/browser-extension`, { action: "site", bindingId: binding.bindingId, origin: "https://fixture.test", access: "allow" })).status).toBe(200);
  return dump;
}
function mount(dump: any) { return Object.values(dump.mcpConfig.mcpServers).find((m: any) => m.env?.MURAGE_CONTROL_URL && m.args?.some((a: string) => a.includes("unified-browser"))) as any; }
async function rpc(mounted: any, name = "agent_browser_snapshot", args: Record<string, unknown> = {}, signal?: AbortSignal) {
  const res = await fetch(fixture.info.url + "/api/internal/unified-browser", { method: "POST", signal, headers: { authorization: `Bearer ${turnSecret("MURAGE_CONTROL_TOKEN", mounted.env)}`, "content-type": "application/json" }, body: JSON.stringify({ method: "tools/call", params: { name, arguments: args } }) });
  const result = { status: res.status, body: await res.json() as any };
  evidence.push({ rpc: name, result });
  return result;
}
async function choose(botId: string, profile?: string) {
  const preview = await api("GET", `/api/bots/${botId}/browser-choice/preview?mode=builtin${profile ? `&profile=${profile}` : ""}`);
  expect(preview.status).toBe(200);
  return api("PATCH", `/api/bots/${botId}`, { browserChoice: { mode: "builtin", profile, baseRevision: preview.body.baseRevision, disclosureKey: preview.body.disclosure.disclosureKey } });
}
async function create(profile?: string) {
  const bot = (await api("POST", "/api/bots", { name: "Browser wait fixture", modelSelection: { instanceId: "verification", model } })).body.bot;
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: true, composio: false })).status).toBe(200);
  if (profile === "extension") {
    const preview = await api("GET", `/api/bots/${bot.id}/browser-choice/preview?mode=chrome-extension&profile=profile`);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    const chosen = await api("PATCH", `/api/bots/${bot.id}`, { browserChoice: { mode: "chrome-extension", profile: "profile", baseRevision: preview.body.baseRevision, disclosureKey: preview.body.disclosure.disclosureKey } });
    expect(chosen.status, JSON.stringify(chosen.body)).toBe(200);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { browserApproval: "step" })).status).toBe(200);
    expect((await api("POST", `/api/bots/${bot.id}/browser-extension/sites`, { profileId: "profile", origin: "https://fixture.test", rule: "allow" })).status).toBe(200);
  } else if (profile) expect((await choose(bot.id, profile)).body.applied).toBe(true);
  const second = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Sibling" })).body.task.threadId;
  return { bot, second };
}
async function question(dump: any, threadId: string, kind = "question") {
  const socket = connect(dump.mcpConfig.mcpServers.muragebox.args.at(-1)); sockets.push(socket); await once(socket, "connect");
  socket.on("data", data => evidence.push({ broker: data.toString() }));
  socket.write(JSON.stringify({ t: "ask", kind, id: "owner-question", tool: kind === "question" ? "AskUserQuestion" : "Bash", input: kind === "permission" ? { command: "rm ./NEVER_EXECUTED_BROWSER_FIXTURE" } : { questions: [{ question: "Continue?", header: "Continue", options: [{ label: "Yes", description: "Continue" }, { label: "No", description: "Stop" }], multiSelect: false }] } }) + "\n");
  let card: any;
  await expect.poll(async () => { card = (await messages(threadId)).find(m => m.card?.requestId && !m.card.answered)?.card; return !!card; }, { timeout: 5000 }).toBe(true);
  return card;
}
it.each([[undefined, "question"], ["guest", "question"], [undefined, "permission"], ["guest", "permission"], ["extension", "question"], ["extension", "permission"]])("lends %s browser during owner %s, then resumes with a fresh snapshot", async (profile, kind) => {
  const { bot, second } = await create(profile);
  let third: string | undefined;
  try {
    const first = await hold(bot.id, bot.threadId, "waiting-owner");
    const a = mount(first); expect(a).toBeTruthy(); if (profile === "extension") expect((await rpc(a, "agent_browser_open", { url: "https://fixture.test/" })).status).toBe(200);
    expect((await rpc(a)).status).toBe(200);
    const card = await question(first, bot.threadId, kind);
    const next = await hold(bot.id, second, "sibling-with-browser");
    const b = mount(next); expect(b, "sibling must mount the browser while owner is unanswered").toBeTruthy();
    if (profile === "extension") expect((await rpc(b, "agent_browser_open", { url: "https://fixture.test/" })).status).toBe(200);
    expect((await rpc(b)).status).toBe(200);
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: second });
    third = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Next sibling" })).body.task.threadId;
    const c = mount(await hold(bot.id, third!, "another-sibling-with-browser"));
    expect(c).toBeTruthy(); if (profile === "extension") expect((await rpc(c, "agent_browser_open", { url: "https://fixture.test/" })).status).toBe(200); expect((await rpc(c)).status).toBe(200);
    // Selection stays pinned even though the waiting turn has lent execution.
    expect((await choose(bot.id, profile ? undefined : "guest")).body.queued).toBe(true);
    expect((await rpc(a)).body.code).toBe("browser_waiting_for_owner");
    const answer = await api("POST", `/api/bots/${bot.id}/respond`, { threadId: bot.threadId, requestId: card.requestId, ...(kind === "question" ? { behavior: "answer", answers: [{ id: card.questions[0].id, selected: ["Yes"] }] } : { behavior: "deny" }) });
    expect(answer.status).toBe(200);
    expect((await rpc(a)).body.code).toBe("browser_busy_sibling");
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: third });
    expect((await rpc(a, "agent_browser_get_url")).body.code).toBe("browser_snapshot_required");
    expect((await rpc(a)).status).toBe(200);
    expect((await rpc(a, "agent_browser_get_url")).status).toBe(200);
    evidence.push({ answer, messages: await messages(bot.threadId), sibling: await messages(second) });
  } finally { evidence.push({ messages: await messages(bot.threadId), state: (await api("GET", "/api/bots?messages=0")).body }); for (const threadId of [bot.threadId, second, ...(third ? [third] : [])]) await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId }); }
}, 60_000);

it.each(["unanswered", "answered", "disconnect"])("ends extension reacquisition with a visible bounded state: %s", async end => {
  const { bot, second } = await create("extension");
  const marker = join(fixture.info.dataDir, "short-approval-wait");
  const controller = new AbortController();
  let pending: Promise<any> | undefined;
  try {
    const a = mount(await hold(bot.id, bot.threadId, "bounded-owner"));
    expect((await rpc(a, "agent_browser_open", { url: "https://fixture.test/" })).status).toBe(200);
    expect((await rpc(a)).status).toBe(200);
    if (end === "unanswered") writeFileSync(marker, "");
    let outcome: any;
    pending = rpc(a, "agent_browser_click", { selector: "button" }, controller.signal)
      .catch(error => ({ disconnected: String(error) })).then(result => { outcome = result; return result; });
    let card: any;
    await expect.poll(async () => { card = (await messages(bot.threadId)).find(m => m.card?.tool === "browser_extension_action" && !m.card.answered)?.card; return !!card; }, { timeout: 5000 }).toBe(true);
    const b = mount(await hold(bot.id, second, "bounded-sibling"));
    expect((await rpc(b, "agent_browser_open", { url: "https://fixture.test/" })).status).toBe(200);
    expect((await rpc(b)).status).toBe(200);
    if (end !== "unanswered") {
      expect((await api("POST", `/api/bots/${bot.id}/respond`, { threadId: bot.threadId, requestId: card.requestId, behavior: "allow" })).status).toBe(200);
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(outcome).toBeUndefined();
    }
    if (end === "disconnect") controller.abort();
    await expect.poll(() => outcome, { timeout: 10_000 }).toBeDefined();
    if (end !== "disconnect") {
      expect(outcome).toMatchObject({ status: 409, body: { code: "browser_resume_timeout" } });
      expect(outcome.body.error).toMatch(/step was not run.*Do not retry automatically/);
      const rows = await messages(bot.threadId);
      expect(rows.filter(m => m.tool?.name?.includes("timed out while waiting to resume"))).toHaveLength(1);
      expect(rows.filter(m => JSON.stringify(m).includes(BROWSER_HELD_FOR_ANSWER_REASON))).toHaveLength(0);
      if (end === "unanswered") {
        expect(rows.find(m => m.card?.requestId === card.requestId)?.card).toMatchObject({ options: ["Allow", "Deny"] });
        expect(rows.find(m => m.card?.requestId === card.requestId)?.card.answered).toBeFalsy();
      }
    }
    expect((await rpc(b)).status).toBe(200);
    // No ended RPC may spring back to life when the sibling finally releases.
    const commandFile = join(fixture.info.dataDir, "extension-commands.jsonl");
    const before = readFileSync(commandFile, "utf8");
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: second });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(readFileSync(commandFile, "utf8").slice(before.length)).not.toContain("Input.dispatchMouseEvent");
    // A new request succeeds: the old RPC's executor and reservation unwound.
    expect((await rpc(a)).status).toBe(200);
    if (end === "unanswered") {
      expect((await api("POST", `/api/bots/${bot.id}/respond`, { threadId: bot.threadId, requestId: card.requestId, behavior: "deny" })).status).toBe(200);
      expect((await messages(bot.threadId)).find(m => m.card?.requestId === card.requestId)?.card.answered).toBe("deny");
    }
    evidence.push({ bounded: end, outcome, messages: await messages(bot.threadId), sibling: await messages(second) });
  } finally {
    if (existsSync(marker)) unlinkSync(marker);
    controller.abort();
    for (const threadId of [bot.threadId, second]) await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId });
    await pending;
  }
}, 60_000);

it.each(["cancel", "crash", "restart"])("releases a waiting browser across %s and rejects its old capability", async end => {
  const { bot, second } = await create();
  try {
    const first = await hold(bot.id, bot.threadId, `wait-before-${end}`);
    const a = mount(first);
    const old = { env: { MURAGE_CONTROL_TOKEN: turnSecret("MURAGE_CONTROL_TOKEN", a.env) } };
    await question(first, bot.threadId);
    const b = mount(await hold(bot.id, second, `sibling-before-${end}`));
    expect(b).toBeTruthy(); expect((await rpc(b)).status).toBe(200);
    if (end === "restart") {
      evidence.push({ beforeRestart: fixture.info, serverLog: readFileSync(fixture.info.logPath, "utf8") });
      await fixture.restart();
      headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await api("GET", "/api/desktop-secret")).body.secret };
    } else {
      if (end === "crash") process.kill(first.pid, "SIGKILL"); // Only this fixture's fake provider.
      else expect((await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId })).status).toBe(200);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id);
        return state.tasks.find((t: any) => t.threadId === bot.threadId).busy;
      }, { timeout: 10_000 }).toBe(false);
      expect((await rpc(b)).status).toBe(200);
      await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: second });
    }
    expect((await rpc(old)).status).toBe(401);
    const next = mount(await hold(bot.id, second, `browser-after-${end}`));
    expect(next).toBeTruthy(); expect((await rpc(next)).status).toBe(200);
    evidence.push({ end, messages: await messages(bot.threadId), sibling: await messages(second) });
  } finally { for (const threadId of [bot.threadId, second]) await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId }); }
}, 60_000);

it("drains an in-flight browser call before admitting the sibling and discards its old result", async () => {
  const { bot, second } = await create();
  const gate = join(fixture.info.dataDir, "browser-call-hold");
  let running: Promise<Awaited<ReturnType<typeof rpc>>> | undefined;
  try {
    const first = await hold(bot.id, bot.threadId, "inflight-holder");
    writeFileSync(gate, "");
    running = rpc(mount(first));
    await expect.poll(() => existsSync(gate + ".entered")).toBe(true);
    await question(first, bot.threadId);
    const sibling = hold(bot.id, second, "inflight-sibling");
    await expect.poll(async () => {
      const state = (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id);
      return state.tasks.find((t: any) => t.threadId === second).waitingFor?.resource;
    }).toBe("browser");
    unlinkSync(gate);
    const stale = await running;
    expect(stale).toMatchObject({ status: 409, body: { code: "browser_not_authorized" } }); expect(JSON.stringify(stale.body)).not.toContain("fixture page");
    const b = mount(await sibling); expect(b).toBeTruthy(); expect((await rpc(b)).status).toBe(200);
    evidence.push({ inflight: stale, sibling: await messages(second) });
  } finally {
    if (existsSync(gate)) unlinkSync(gate);
    await running;
    for (const threadId of [bot.threadId, second]) await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId });
  }
}, 60_000);


it("resumes an extension bootstrap tab by navigating, then requires a fresh snapshot", async () => {
  const { bot, second } = await create("extension");
  try {
    const first = await hold(bot.id, bot.threadId, "bootstrap-owner"); const a = mount(first);
    const card = await question(first, bot.threadId);
    expect(mount(await hold(bot.id, second, "bootstrap-sibling"))).toBeTruthy();
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: second });
    await api("POST", `/api/bots/${bot.id}/respond`, { threadId: bot.threadId, requestId: card.requestId, behavior: "answer", answers: [{ id: card.questions[0].id, selected: ["Yes"] }] });
    const opened = await rpc(a, "agent_browser_open", { url: "https://fixture.test/" });
    expect(opened, "bootstrap navigation must recover without a snapshot of about:blank").toMatchObject({ status: 200 });
    expect((await rpc(a, "agent_browser_click", { selector: "button" })).body.code).toBe("browser_snapshot_required");
    expect((await rpc(a, "agent_browser_open", { url: "https://fixture.test/other" })).status).toBe(409);
    expect((await rpc(a)).status).toBe(200);
    expect((await rpc(a, "agent_browser_get_url")).status).toBe(200);
    evidence.push({ bootstrap: opened, messages: await messages(bot.threadId) });
  } finally { for (const threadId of [bot.threadId, second]) await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId }); }
}, 60_000);

it.each(["site", "action"].flatMap(kind => ["answer", "cancel", "restart", "stop-after-answer"].map(end => [kind, end])))
("lends extension browser during %s approval and handles %s", async (kind, end) => {
  const { bot, second } = await create("extension");
  let pending: Promise<any> | undefined;
  try {
    const first = await hold(bot.id, bot.threadId, "extension-approval"); const a = mount(first);
    if (kind === "site") {
      const binding = (await api("GET", `/api/bots/${bot.id}/browser-extension`)).body.bindings.find((b: any) => b.threadId === bot.threadId);
      expect((await api("POST", `/api/bots/${bot.id}/browser-extension`, { action: "site", bindingId: binding.bindingId, origin: "https://fixture.test", access: "ask" })).status).toBe(200);
    }
    else { expect((await rpc(a, "agent_browser_open", { url: "https://fixture.test/" })).status).toBe(200); expect((await rpc(a)).status).toBe(200); }
    pending = rpc(a, kind === "site" ? "agent_browser_open" : "agent_browser_click", kind === "site" ? { url: "https://fixture.test/" } : { selector: "button" }).catch(error => ({ disconnected: String(error) }));
    let card: any;
    await expect.poll(async () => { card = (await messages(bot.threadId)).find(m => m.card?.tool === "browser_extension_action" && !m.card.answered)?.card; return !!card; }, { timeout: 5000 }).toBe(true);
    const ownerBinding = (await api("GET", `/api/bots/${bot.id}/browser-extension`)).body.bindings.find((b: any) => b.threadId === bot.threadId).bindingId;
    const commands = () => existsSync(join(fixture.info.dataDir, "extension-commands.jsonl")) ? readFileSync(join(fixture.info.dataDir, "extension-commands.jsonl"), "utf8").split("\n").filter(line => line && JSON.parse(line).bindingId === ownerBinding).join("\n") : "";
    const beforeAnswer = commands();
    const b = mount(await hold(bot.id, second, "extension-approval-sibling"));
    expect(b, "sibling must mount the browser while extension approval is unanswered").toBeTruthy();
    expect((await rpc(b, "agent_browser_open", { url: "https://fixture.test/" })).status).toBe(200);
    expect((await rpc(b)).status).toBe(200);
    expect((await rpc(a)).body.code).toBe("browser_waiting_for_owner");
    expect(commands(), "the parked RPC must send no browser commands while its card waits").toBe(beforeAnswer);
    if (end === "restart") {
      evidence.push({ beforeRestart: fixture.info, serverLog: readFileSync(fixture.info.logPath, "utf8") });
      await fixture.restart();
      headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await api("GET", "/api/desktop-secret")).body.secret };
      expect((await rpc(a)).status).toBe(401);
      const nextThread = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "After restart" })).body.task.threadId;
      expect(mount(await hold(bot.id, nextThread, "extension-after-restart"))).toBeTruthy();
      await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: nextThread });
    } else if (end === "cancel") {
      await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
      expect((await rpc(a)).status).toBe(401);
      expect((await rpc(b)).status).toBe(200);
    } else {
      // Answer while the sibling owns the route: the approval continuation must wait for ownership.
      let settled = false; void pending.then(() => { settled = true; });
      expect((await api("POST", `/api/bots/${bot.id}/respond`, { threadId: bot.threadId, requestId: card.requestId, behavior: "allow" })).status).toBe(200);
      await new Promise(resolve => setTimeout(resolve, 100)); expect(settled).toBe(false);
      expect(commands(), "the answer cannot dispatch until the sibling releases ownership").toBe(beforeAnswer);
      if (end === "stop-after-answer") {
        await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
        expect((await pending).status).toBe(409);
        expect(commands()).toBe(beforeAnswer);
        expect((await rpc(a)).status).toBe(401);
        expect((await rpc(b)).status).toBe(200);
        return;
      }
      await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: second });
      const result = await pending; expect(result, JSON.stringify(result)).toMatchObject({ status: 200 });
      expect(commands().slice(beforeAnswer.length)).toContain(kind === "site" ? "Page.navigate" : "Input.dispatchMouseEvent");
      expect((await rpc(a, "agent_browser_get_url")).body.code).toBe("browser_snapshot_required");
      expect((await rpc(a)).status).toBe(200);
    }
    evidence.push({ kind, end, result: await pending, messages: await messages(bot.threadId), sibling: await messages(second) });
  } finally {
    evidence.push({ kind, end, messages: await messages(bot.threadId), sibling: await messages(second) });
    for (const threadId of [bot.threadId, second]) await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId });
    await pending;
  }
}, 60_000);
