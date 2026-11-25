// SPDX-License-Identifier: AGPL-3.0-or-later
// TABGONE-1021: "Use my Chrome" pins the bot to its own tab (AGENT_BROWSER_PIN_TAB). When the owner closes that tab,
// the engine refuses every page command with code "tab_gone" until someone binds a new tab, and it remembers the lost
// tab across its own restarts and Murage's. Nothing in Murage bound a new one: the live view's attach, the owner's
// "Reopen blank page" and the bot's steps all failed the same way until the session files were removed.
// These witnesses drive the real relay (and the real controller) against a child process that answers as the engine
// does: its command line and its stdio tool server share one state file, as the real ones share one daemon.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { UnifiedBrowserController } from "./browser-control.ts";
import { BROWSER_TAB_CLOSED, BROWSER_TAB_REPLACED, BrowserEngineError, createNativeBrowser } from "./browser-native-relay.ts";
import { ownedCloseCli } from "./browser-owned-close.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const scratch: string[] = [];
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const path of scratch.splice(0)) removeTempDirSync(path);
  vi.restoreAllMocks();
});
const ID = "4c1b0f0e-9a2d-4e8f-b1c3-5d6e7f8a9b0c";
const noop = () => {};
// Windows runs only Murage's bundled, identity-verified engine (browser-sandbox.ts), which this stand-in cannot be.
const witness = it.skipIf(process.platform === "win32");

type State = { bound: string | null; gone: string | null; tabs: number; newTabFails?: boolean; stayGone?: boolean; holdNewTab?: boolean; noTarget?: boolean; closeOnEval?: boolean; url?: string; holdReply?: string };

/** The engine as Murage meets it. `bound` is the pinned tab; `gone` is the closed tab it still remembers. */
async function fixture(initial: Partial<State> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "murage-tabgone-")); scratch.push(dir);
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  closers.push(() => new Promise<void>((resolve) => { for (const client of wss.clients) client.terminate(); wss.close(() => resolve()); }));
  const port = (wss.address() as { port: number }).port;
  const stateFile = join(dir, "state.json"), calls = join(dir, "calls.log"), script = join(dir, "engine.mjs");
  const write = (state: State) => writeFileSync(stateFile, JSON.stringify(state));
  const read = (): State => { for (let i = 0; ; i++) { try { return JSON.parse(readFileSync(stateFile, "utf8")); } catch (error) { if (i > 500) throw error; } } };
  write({ bound: "TAB1", gone: null, tabs: 1, ...initial });
  writeFileSync(calls, "");
  writeFileSync(script, `
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const stateFile = ${JSON.stringify(stateFile)}, calls = ${JSON.stringify(calls)};
// The state file is written whole by the test and by each command; a read that lands inside such a write is made again.
const read = () => { for (let i = 0; ; i++) { try { return JSON.parse(readFileSync(stateFile, "utf8")); } catch (error) { if (i > 500) throw error; } } };
const save = (state) => writeFileSync(stateFile, JSON.stringify(state));
const RECOVERY = new Set(["tab new", "tab list", "stream status", "get cdp-url"]);
/** One engine command against the shared state: the response the engine prints for --json. */
function act(args) {
  const verb = args.slice(0, 2).join(" ");
  // Logged after the state is read: once a test sees the line, a change it makes to the state is not seen by this command.
  const state = read();
  appendFileSync(calls, args.join(" ") + "\\n");
  if (verb === "tab new") {
    if (state.newTabFails) return { success: false, data: null, error: "CDP error: Target.createTarget failed" };
    state.tabs += 1; state.bound = "TAB" + state.tabs; if (!state.stayGone) state.gone = null; save(state);
    return { success: true, data: { index: state.tabs - 1, url: "about:blank" }, error: null };
  }
  // noTarget: an engine that refuses without naming the closed tab.
  if (state.gone && !RECOVERY.has(verb) && state.noTarget) return { success: false, data: null, error: "tab_gone: bound tab is gone", code: "tab_gone" };
  if (state.gone && !RECOVERY.has(verb)) return { success: false, data: { targetId: state.gone }, error: "tab_gone: bound tab is gone (target " + state.gone + ", last url about:blank). Run \`agent-browser tab new <url>\` to bind a new tab, or \`agent-browser tab list\` to pick an existing one", code: "tab_gone" };
  if (verb === "get url") return { success: true, data: { url: state.url ?? "about:blank", tab: state.bound }, error: null };
  // closeOnEval: the owner closes the bot's tab while a page read is under way, after this answer.
  if (args[0] === "agent_browser_eval") { if (state.closeOnEval) save({ ...state, gone: state.bound, bound: null, closeOnEval: false }); return { success: true, data: { result: "<html><body>page</body></html>" }, error: null }; }
  if (verb === "get cdp-url") return { success: true, data: { cdpUrl: "ws://127.0.0.1:${port}/devtools/browser/${ID}" }, error: null };
  if (verb === "stream status") return { success: true, data: { port: ${port} }, error: null };
  if (verb === "open boom") return { success: false, data: null, error: "net::ERR_NAME_NOT_RESOLVED" };
  return { success: true, data: { ran: args.join(" "), tab: state.bound }, error: null };
}
const argv = process.argv.slice(2);
if (argv[0] === "mcp") {
  const TOOLS = { agent_browser_snapshot: ["snapshot"], agent_browser_open: ["open"], agent_browser_tab_new: ["tab", "new"], agent_browser_tab_list: ["tab", "list"], agent_browser_click: ["click"], agent_browser_get_url: ["get", "url"] };
  let buf = "";
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (msg.id === undefined) continue;
      let result = {};
      if (msg.method === "tools/list") result = { tools: Object.keys(TOOLS).map((name) => ({ name, inputSchema: { type: "object" } })) };
      else if (msg.method === "tools/call") {
        const response = act(["mcp:", ...(TOOLS[msg.params.name] ?? [msg.params.name]), ...Object.values(msg.params.arguments ?? {}).map(String)].slice(1));
        const ok = response.success === true;
        result = { content: [{ type: "text", text: ok ? JSON.stringify(response.data) : response.error }], structuredContent: { exitCode: ok ? 0 : 1, stdout: JSON.stringify(response), stderr: "", response }, isError: !ok };
      }
      const answer = () => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
      // holdReply names a tool: the engine has run it, and its answer is on the way until the test clears the flag.
      if (msg.method === "tools/call" && read().holdReply === msg.params.name) { const held = Date.now(); const wait = () => read().holdReply !== msg.params.name || Date.now() - held > 15000 ? answer() : setTimeout(wait, 25); wait(); }
      else answer();
    }
  });
} else {
  const args = argv.filter((arg) => arg !== "--json");
  const response = act(args);
  process.exitCode = response.success ? 0 : 1;
  // "open slow": a command already under way when the tab closed. Its refusal is held until the new tab is bound.
  const print = () => process.stdout.write(JSON.stringify(response));
  // "tab new" with holdNewTab set: the replacement is in flight until the test clears the flag.
  if (args.join(" ") === "tab new" && read().holdNewTab) { const held = Date.now(); const wait = () => !read().holdNewTab || Date.now() - held > 15000 ? print() : setTimeout(wait, 25); wait(); }
  // holdReply names a command: the engine has run it, and its answer is on the way until the test clears the flag.
  else if (read().holdReply === args.join(" ")) { const held = Date.now(); const wait = () => read().holdReply !== args.join(" ") || Date.now() - held > 15000 ? print() : setTimeout(wait, 25); wait(); }
  else if (args.join(" ") === "open slow" && response.code === "tab_gone") { const held = Date.now(); const wait = () => read().tabs >= 2 || Date.now() - held > 15000 ? print() : setTimeout(wait, 25); wait(); }
  else print();
}
`);
  const spec = { command: process.execPath, args: [script, "mcp"], env: { PATH: process.env.PATH ?? "", AGENT_BROWSER_SOCKET_DIR: dir, AGENT_BROWSER_SESSION: "tabgone", AGENT_BROWSER_CDP: `ws://127.0.0.1:${port}/devtools/browser/${ID}`, AGENT_BROWSER_PIN_TAB: "1" } };
  // The fixture has no daemon to stop; its maintenance CLI reports that fact.
  vi.spyOn(ownedCloseCli, "run").mockResolvedValue({ code: 0, stdout: JSON.stringify({ launchId: null, closed: true, path: "not_running", groupExhausted: true, treeExhausted: false, outsideSeen: 0, unconfirmed: null }) });
  const relay = (options: { tabRetryMs?: number } = {}) => { const native = createNativeBrowser(spec, { cliPrefix: [script], ...options }); closers.push(() => native.close()); return native; };
  const ran = () => readFileSync(calls, "utf8").trim().split("\n").filter(Boolean);
  const count = (line: string) => ran().filter((entry) => entry === line).length;
  /** The owner closes the bot's tab in their Chrome. */
  const closeBoundTab = () => { const state = read(); write({ ...state, gone: state.bound, bound: null }); };
  return { spec, script, relay, ran, count, read, write, closeBoundTab };
}
const text = (reply: unknown) => ((reply as { content?: Array<{ text?: unknown }> }).content ?? []).map((item) => String(item.text ?? "")).join("\n");
const quiet = () => { vi.spyOn(console, "log").mockImplementation(noop); vi.spyOn(console, "error").mockImplementation(noop); return vi.spyOn(console, "warn").mockImplementation(noop); };

witness("TABGONE-1021: a fresh relay that meets a remembered closed tab opens a new one and the live view connects", async () => {
  quiet();
  // What a restarted Murage meets: the engine still remembers the closed tab.
  const engine = await fixture({ bound: null, gone: "TAB1" });
  const native = engine.relay();
  await expect(native.connect(noop, noop, noop)).resolves.toBeTypeOf("string");
  expect(engine.count("tab new")).toBe(1);
  expect(engine.read()).toMatchObject({ bound: "TAB2", gone: null });
  // Refused once, then answered on the new tab.
  expect(engine.count("get url")).toBe(2);
}, 30_000);

witness("TABGONE-1021: the owner's Reopen blank page works on a closed tab", async () => {
  quiet();
  const engine = await fixture();
  const native = engine.relay();
  engine.closeBoundTab();
  await expect(native.command(["open", "about:blank"])).resolves.toMatchObject({ ran: "open about:blank", tab: "TAB2" });
  expect(engine.count("tab new")).toBe(1);
}, 30_000);

witness("TABGONE-1021: the bot's step on a closed tab gets a new tab and is told once, in plain words", async () => {
  const warn = quiet();
  const engine = await fixture();
  const native = engine.relay();
  await expect(native.request("tools/call", { name: "agent_browser_snapshot", arguments: {} })).resolves.toMatchObject({ isError: false });
  engine.closeBoundTab();
  const told = await native.request("tools/call", { name: "agent_browser_click", arguments: { selector: "@e3" } });
  expect(told).toEqual({ isError: true, content: [{ type: "text", text: BROWSER_TAB_REPLACED }] });
  // The engine's own advice names its command line, which the bot does not have.
  expect(text(told)).not.toMatch(/agent-browser|tab_gone|TAB1/u);
  expect(engine.count("tab new")).toBe(1);
  expect(engine.read()).toMatchObject({ bound: "TAB2", gone: null });
  // The refused step is not replayed on the blank tab: its page is gone.
  expect(engine.count("click @e3")).toBe(1);
  // Told once: the next step runs on the new tab and says nothing more.
  const next = await native.request("tools/call", { name: "agent_browser_snapshot", arguments: {} });
  expect(next).toMatchObject({ isError: false });
  expect(text(next)).not.toContain(BROWSER_TAB_REPLACED);
  expect(engine.count("tab new")).toBe(1);
  // One new log line names what happened, with no address and no tab id in it.
  const logged = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("tab"));
  expect(logged).toEqual(["[browser] the bot's tab was closed; opened a new one"]);
}, 30_000);

witness("TABGONE-1021: a tab replaced for the owner's view is told to the bot at its next step, which does not run on the blank tab", async () => {
  quiet();
  const engine = await fixture();
  const native = engine.relay();
  engine.closeBoundTab();
  await native.connect(noop, noop, noop);
  expect(engine.count("tab new")).toBe(1);
  expect(await native.request("tools/call", { name: "agent_browser_click", arguments: { selector: "@e3" } })).toEqual({ isError: true, content: [{ type: "text", text: BROWSER_TAB_REPLACED }] });
  expect(engine.count("click @e3")).toBe(0);
  expect(await native.request("tools/call", { name: "agent_browser_snapshot", arguments: {} })).toMatchObject({ isError: false });
  expect(engine.count("tab new")).toBe(1);
}, 30_000);

witness("TABGONE-1021: a page read Murage makes inside the bot's step neither uses the notice up nor is stopped by it", async () => {
  quiet();
  const engine = await fixture();
  const native = engine.relay();
  engine.closeBoundTab();
  await native.command(["get", "url"]);
  // The reader's own call (browser-control.ts hands the reader an `internal` client) runs, and the notice is still owed to the bot.
  expect(await native.request("tools/call", { name: "agent_browser_snapshot", arguments: {} }, { internal: true })).toMatchObject({ isError: false });
  expect(await native.request("tools/call", { name: "agent_browser_click", arguments: { selector: "@e3" } })).toEqual({ isError: true, content: [{ type: "text", text: BROWSER_TAB_REPLACED }] });
  // The reader's call meets the closed tab itself: a new tab is bound, its own answer is left alone, and the bot is told next.
  engine.closeBoundTab();
  const inner = await native.request("tools/call", { name: "agent_browser_snapshot", arguments: {} }, { internal: true });
  expect(inner).toMatchObject({ isError: true, structuredContent: { response: { code: "tab_gone" } } });
  expect(engine.read()).toMatchObject({ bound: "TAB3", gone: null });
  expect(await native.request("tools/call", { name: "agent_browser_click", arguments: { selector: "@e3" } })).toEqual({ isError: true, content: [{ type: "text", text: BROWSER_TAB_REPLACED }] });
  expect(await native.request("tools/call", { name: "agent_browser_snapshot", arguments: {} })).toMatchObject({ isError: false });
}, 30_000);

witness("TABGONE-1021: a bot that opens a page next is not stopped by the notice it no longer needs", async () => {
  quiet();
  const engine = await fixture();
  const native = engine.relay();
  engine.closeBoundTab();
  await native.command(["get", "url"]);
  const opened = await native.request("tools/call", { name: "agent_browser_open", arguments: { url: "https://example.test/" } });
  expect(opened).toMatchObject({ isError: false });
  expect(engine.count("open https://example.test/")).toBe(1);
  // Opening a page was the advice, so nothing is left to tell.
  expect(await native.request("tools/call", { name: "agent_browser_click", arguments: { selector: "@e1" } })).toMatchObject({ isError: false });
}, 30_000);

witness("TABGONE-1021: commands that meet the same closed tab together open one new tab, not one each", async () => {
  quiet();
  const engine = await fixture({ bound: null, gone: "TAB1" });
  const native = engine.relay();
  const answers = await Promise.all([native.command(["get", "url"]), native.command(["get", "url"]), native.command(["open", "about:blank"])]);
  expect(answers).toHaveLength(3);
  expect(engine.count("tab new")).toBe(1);
  expect(engine.read()).toMatchObject({ bound: "TAB2", tabs: 2 });
}, 30_000);

witness("TABGONE-1021: a refusal that arrives after the new tab was bound runs again on it, and opens no second tab", async () => {
  quiet();
  const engine = await fixture({ bound: null, gone: "TAB1" });
  const native = engine.relay();
  const late = native.command(["open", "slow"]);
  // Already with the engine when the next command meets the closed tab (sent later, it would wait for the new tab and never be refused).
  for (let i = 0; i < 400 && engine.count("open slow") === 0; i++) await new Promise((resolve) => setTimeout(resolve, 25));
  expect(engine.count("open slow")).toBe(1);
  await expect(native.command(["get", "url"])).resolves.toMatchObject({ tab: "TAB2" });
  expect(engine.count("tab new")).toBe(1);
  await expect(late).resolves.toMatchObject({ ran: "open slow", tab: "TAB2" });
  // Refused for the closed tab, then run again on the tab that was already bound for it.
  expect(engine.count("open slow")).toBe(2);
  expect(engine.count("tab new")).toBe(1);
  expect(engine.read()).toMatchObject({ bound: "TAB2", tabs: 2 });
}, 30_000);

witness("TABGONE-1021: a new tab that cannot be opened leaves the failure standing, without a retry storm", async () => {
  quiet();
  const engine = await fixture({ bound: null, gone: "TAB1", newTabFails: true });
  const native = engine.relay();
  await expect(native.command(["get", "url"])).rejects.toBeInstanceOf(BrowserEngineError);
  expect(engine.count("tab new")).toBe(1);
  expect(engine.count("get url")).toBe(1);
  // The bot's step is told plainly, promised no new tab, and never handed the engine's command-line advice.
  const reply = await native.request("tools/call", { name: "agent_browser_snapshot", arguments: {} });
  expect(reply).toEqual({ isError: true, content: [{ type: "text", text: BROWSER_TAB_CLOSED }] });
  expect(text(reply)).not.toMatch(/agent-browser|tab_gone|TAB1/u);
  expect(engine.count("tab new")).toBe(2);
  // Chrome is back: the next command recovers.
  engine.write({ ...engine.read(), newTabFails: false });
  await expect(native.command(["get", "url"])).resolves.toMatchObject({ tab: "TAB2" });
}, 30_000);

witness("TABGONE-1021: an engine that still refuses after the new tab is asked once more, never in a loop", async () => {
  quiet();
  const engine = await fixture({ bound: null, gone: "TAB1", stayGone: true });
  const native = engine.relay();
  await expect(native.command(["get", "url"])).rejects.toBeInstanceOf(BrowserEngineError);
  expect(engine.count("tab new")).toBe(1);
  expect(engine.count("get url")).toBe(2);
  // The new tab did not take, so the next command opens another instead of trusting the first.
  engine.write({ ...engine.read(), stayGone: false });
  await expect(native.command(["get", "url"])).resolves.toMatchObject({ tab: "TAB3" });
  expect(engine.count("tab new")).toBe(2);
}, 30_000);

witness("TABGONE-1021: any other engine failure opens no tab", async () => {
  quiet();
  const engine = await fixture();
  const native = engine.relay();
  await expect(native.command(["open", "boom"])).rejects.toBeInstanceOf(BrowserEngineError);
  expect(engine.count("tab new")).toBe(0);
  expect(engine.count("open boom")).toBe(1);
}, 30_000);

witness("TABGONE-1021: through the controller, the bot's step after a restart is told plainly instead of handed the engine's command line", async () => {
  quiet();
  // Before: the bot was handed the engine's own advice, a command line it is told never to run, on every step.
  const engine = await fixture({ bound: null, gone: "TAB1" });
  const dir = mkdtempSync(join(tmpdir(), "murage-tabgone-state-")); scratch.push(dir);
  // The real relay; only the page check is stood in for (it needs a real Chrome to talk to, and is not what failed).
  const controller = new UnifiedBrowserController({ stateFile: join(dir, "control.json"), createNative: () => ({ ...engine.relay(), protected: async () => false, pages: async () => [] }) });
  controller.register("k", engine.spec);
  const told = await controller.dispatch("k", "tools/call", { name: "agent_browser_click", arguments: { selector: "@e3" } }, () => true);
  expect(told).toEqual({ isError: true, content: [{ type: "text", text: BROWSER_TAB_REPLACED }] });
  expect(controller.status("k")).toMatchObject({ notRunning: false });
  const next = await controller.dispatch("k", "tools/call", { name: "agent_browser_snapshot", arguments: {} }, () => true);
  expect(next).toMatchObject({ isError: false });
  expect(engine.count("tab new")).toBe(1);
}, 30_000);

witness("TABGONE-1021: the controller marks the reader's page calls as Murage's own, and the bot's own step as the bot's", async () => {
  quiet();
  const dir = mkdtempSync(join(tmpdir(), "murage-tabgone-state-")); scratch.push(dir);
  const seen: Array<{ name: unknown; internal: boolean }> = [];
  // Only the controller's wiring is under test here, so the relay is stood in for and records what it is asked.
  const native = {
    protected: async () => false, pages: async () => [], command: async () => ({}), connect: async () => "s", input: noop, resetStream: noop, close: async () => {},
    request: async (_method: string, params?: Record<string, unknown>, options?: { internal?: boolean }) => { seen.push({ name: params?.name, internal: options?.internal === true }); return { isError: true, content: [] }; },
  };
  const controller = new UnifiedBrowserController({ stateFile: join(dir, "control.json"), createNative: () => native });
  controller.register("k", { command: "fixture", args: [], env: {} });
  await controller.dispatch("k", "tools/call", { name: "agent_browser_snapshot", arguments: {} }, () => true);
  // The stand-in answers the reader's first page call with an error, so the read itself ends there.
  await expect(controller.dispatch("k", "tools/call", { name: "agent_browser_read", arguments: {} }, () => true, { readScope: "bot:thread" })).rejects.toThrow();
  expect(seen).toEqual([{ name: "agent_browser_snapshot", internal: false }, { name: "agent_browser_get_url", internal: true }]);
}, 30_000);

witness("TABGONE-1021: a mediated read after the view replaced the tab is told, not run on the blank tab", async () => {
  quiet();
  const engine = await fixture();
  const dir = mkdtempSync(join(tmpdir(), "murage-tabgone-state-")); scratch.push(dir);
  // The real relay; only the page check is stood in for. The same relay answers the owner's view and the bot's read.
  const relay = engine.relay();
  const controller = new UnifiedBrowserController({ stateFile: join(dir, "control.json"), createNative: () => ({ ...relay, protected: async () => false, pages: async () => [] }) });
  controller.register("k", engine.spec);
  engine.closeBoundTab();
  // The owner's view meets the closed tab first and binds the new one.
  await relay.command(["get", "url"]);
  expect(engine.count("tab new")).toBe(1);
  const before = engine.ran().length;
  const told = await controller.dispatch("k", "tools/call", { name: "agent_browser_read", arguments: {} }, () => true, { readScope: "bot:thread" });
  expect(told).toEqual({ isError: true, content: [{ type: "text", text: BROWSER_TAB_REPLACED }] });
  // The read did not touch the blank tab, and the notice is used up.
  expect(engine.ran().slice(before).filter((entry) => entry.startsWith("get "))).toEqual([]);
  expect(await controller.dispatch("k", "tools/call", { name: "agent_browser_snapshot", arguments: {} }, () => true)).toMatchObject({ isError: false });
}, 30_000);

witness("TABGONE-1021: a mediated read dispatched while the replacement is in flight waits for it and is told", async () => {
  quiet();
  const engine = await fixture();
  const dir = mkdtempSync(join(tmpdir(), "murage-tabgone-state-")); scratch.push(dir);
  const relay = engine.relay();
  const controller = new UnifiedBrowserController({ stateFile: join(dir, "control.json"), createNative: () => ({ ...relay, protected: async () => false, pages: async () => [] }) });
  controller.register("k", engine.spec);
  engine.closeBoundTab();
  // The replacement is held open: the engine has the tab-new command, and does not answer it yet.
  engine.write({ ...engine.read(), holdNewTab: true });
  const owner = relay.command(["get", "url"]);
  const until = async (done: () => boolean) => { for (let i = 0; i < 400 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 25)); expect(done()).toBe(true); };
  await until(() => engine.count("tab new") === 1);
  const before = engine.ran().length;
  let settled = false;
  const read = controller.dispatch("k", "tools/call", { name: "agent_browser_read", arguments: {} }, () => true, { readScope: "bot:thread" }).finally(() => { settled = true; });
  // The read is under way while the replacement is not done: it must not have run on the blank tab, nor ended.
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(settled).toBe(false);
  expect(engine.ran().slice(before).filter((entry) => entry.startsWith("get "))).toEqual([]);
  engine.write({ ...engine.read(), holdNewTab: false });
  await owner;
  expect(await read).toEqual({ isError: true, content: [{ type: "text", text: BROWSER_TAB_REPLACED }] });
}, 30_000);

// TABGONE-1021 v2: one lifecycle for the bot's tab. Each witness below takes one way into the engine.
const REPLACED = { isError: true, content: [{ type: "text", text: BROWSER_TAB_REPLACED }] };
const CLOSED = { isError: true, content: [{ type: "text", text: BROWSER_TAB_CLOSED }] };
const until = async (done: () => boolean) => { for (let i = 0; i < 400 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 25)); expect(done()).toBe(true); };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const click = (native: { request: (method: string, params?: Record<string, unknown>) => Promise<unknown> }, selector: string) => native.request("tools/call", { name: "agent_browser_click", arguments: { selector } });
type Engine = Awaited<ReturnType<typeof fixture>>;
/** The real controller over the real relay; only the page check is stood in for (it needs a real Chrome to talk to). */
const controlled = (engine: Engine, checks: Partial<{ protected: () => Promise<boolean>; pages: () => Promise<{ id: string; url: string }[]> }> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "murage-tabgone-state-")); scratch.push(dir);
  const relay = engine.relay();
  const controller = new UnifiedBrowserController({ stateFile: join(dir, "control.json"), createNative: () => ({ ...relay, protected: async () => false, pages: async () => [], ...checks }) });
  controller.register("k", engine.spec);
  const step = (name: string, args: Record<string, unknown> = {}) => controller.dispatch("k", "tools/call", { name, arguments: args }, () => true, { readScope: "bot:thread" });
  return { relay, controller, step };
};

witness("TABGONE-1021 W1: a bot action sent while the replacement is in flight waits, is told, and never reaches the new tab first", async () => {
  quiet();
  const engine = await fixture();
  const native = engine.relay();
  // The bot's tool server is already running, so its click is with the engine at once.
  expect(await native.request("tools/call", { name: "agent_browser_snapshot", arguments: {} })).toMatchObject({ isError: false });
  engine.closeBoundTab();
  // The engine has bound the new tab and holds its answer: Murage is still waiting for it.
  engine.write({ ...engine.read(), holdNewTab: true });
  const owner = native.command(["get", "url"]);
  await until(() => engine.count("tab new") === 1);
  expect(engine.read()).toMatchObject({ bound: "TAB2", gone: null });
  let settled = false;
  const acted = click(native, "@e3").finally(() => { settled = true; });
  await pause(400);
  expect(settled).toBe(false);
  expect(engine.count("click @e3")).toBe(0);
  engine.write({ ...engine.read(), holdNewTab: false });
  await owner;
  expect(await acted).toEqual(REPLACED);
  // The click never reached the tab the bot had not been told about. Told once: the next one runs.
  expect(engine.count("click @e3")).toBe(0);
  expect(await click(native, "@e4")).toMatchObject({ isError: false });
  expect(engine.count("click @e4")).toBe(1);
  expect(engine.count("tab new")).toBe(1);
}, 30_000);

witness("TABGONE-1021 W2: a mediated read whose first page call meets the closed tab is told in plain words, once", async () => {
  quiet();
  const engine = await fixture();
  const { step } = controlled(engine);
  engine.closeBoundTab();
  // Nothing met the closed tab before the read: the reader's own first call does.
  expect(await step("agent_browser_read")).toEqual(REPLACED);
  expect(engine.count("get url")).toBe(1);
  expect(engine.count("tab new")).toBe(1);
  // That was the telling: the bot's next step runs on the new tab.
  expect(await step("agent_browser_click", { selector: "@e3" })).toMatchObject({ isError: false });
  expect(engine.count("click @e3")).toBe(1);
}, 30_000);

witness("TABGONE-1021 W3: bot steps alone, with an engine that keeps refusing for the same closed tab, get two new tabs and then the plain truth", async () => {
  quiet();
  const engine = await fixture();
  const native = engine.relay();
  engine.closeBoundTab();
  // What a restarted engine does when it restores the saved closed tab: `tab new` answers, the refusal stays.
  engine.write({ ...engine.read(), stayGone: true });
  const replies = [];
  for (const selector of ["@e1", "@e2", "@e3", "@e4"]) replies.push(await click(native, selector));
  expect(replies).toEqual([REPLACED, REPLACED, CLOSED, CLOSED]);
  expect(engine.count("tab new")).toBe(2);
  // The fourth step is not sent: the engine was asked a moment ago.
  expect(engine.ran().filter((entry) => entry.startsWith("click "))).toEqual(["click @e1", "click @e2", "click @e3"]);
  for (const reply of replies) expect(text(reply)).not.toMatch(/agent-browser|tab_gone|TAB1/u);
}, 30_000);

witness("TABGONE-1021 W4: an engine that keeps refusing without naming the tab does not get a new tab per step", async () => {
  quiet();
  const engine = await fixture();
  const native = engine.relay();
  engine.closeBoundTab();
  engine.write({ ...engine.read(), stayGone: true, noTarget: true });
  const replies = [];
  for (const selector of ["@e1", "@e2", "@e3", "@e4", "@e5"]) replies.push(await click(native, selector));
  expect(replies).toEqual([REPLACED, REPLACED, CLOSED, CLOSED, CLOSED]);
  expect(engine.count("tab new")).toBe(2);
}, 30_000);

witness("TABGONE-1021 W5: the bot's own new tab, asked for while the replacement is in flight, goes out after it and needs no telling", async () => {
  quiet();
  const engine = await fixture();
  const native = engine.relay();
  expect(await native.request("tools/call", { name: "agent_browser_snapshot", arguments: {} })).toMatchObject({ isError: false });
  engine.closeBoundTab();
  engine.write({ ...engine.read(), holdNewTab: true });
  const owner = native.command(["get", "url"]);
  await until(() => engine.count("tab new") === 1);
  const own = native.request("tools/call", { name: "agent_browser_tab_new", arguments: {} });
  await pause(400);
  // Still only Murage's `tab new` is with the engine.
  expect(engine.count("tab new")).toBe(1);
  engine.write({ ...engine.read(), holdNewTab: false });
  await owner;
  expect(await own).toMatchObject({ isError: false });
  expect(engine.count("tab new")).toBe(2);
  expect(engine.read()).toMatchObject({ bound: "TAB3" });
  // The bot chose this tab, so its next step runs.
  expect(await click(native, "@e3")).toMatchObject({ isError: false });
  expect(engine.count("click @e3")).toBe(1);
}, 30_000);

witness("TABGONE-1021 W6: the new tab Murage opens for a protected page does not use up the notice the bot is owed", async () => {
  quiet();
  const engine = await fixture();
  let sensitive = false;
  // The browser lists every tab still open, by the fixture's own state.
  const pages = async () => { const state = engine.read(); return Array.from({ length: state.tabs }, (_, index) => ({ id: `TAB${index + 1}`, url: "about:blank" })).filter((tab) => tab.id !== state.gone); };
  const { relay, step } = controlled(engine, { protected: async () => { const now = sensitive; sensitive = false; return now; }, pages });
  engine.closeBoundTab();
  // The owner's view meets the closed tab and the new one is bound: the bot is owed the notice.
  await relay.command(["get", "url"]);
  expect(engine.count("tab new")).toBe(1);
  // The page check flags the page before the bot's step, which is refused without reaching the relay.
  sensitive = true;
  await expect(step("agent_browser_click", { selector: "@e1" })).rejects.toMatchObject({ code: "browser_protected_sensitive_page" });
  // Next step: the protected page is left to the owner and the bot gets a blank tab of its own (Murage's own `tab new`).
  await expect(step("agent_browser_click", { selector: "@e2" })).rejects.toMatchObject({ code: "browser_fresh_tab" });
  expect(engine.count("tab new")).toBe(2);
  expect(engine.ran().filter((entry) => entry.startsWith("click "))).toEqual([]);
  // The bot still has not been told its earlier tab was closed.
  expect(await step("agent_browser_click", { selector: "@e3" })).toEqual(REPLACED);
  expect(engine.count("click @e3")).toBe(0);
  expect(await step("agent_browser_click", { selector: "@e4" })).toMatchObject({ isError: false });
}, 30_000);

witness("TABGONE-1021: a tab closed in the middle of a mediated read ends the read with the notice, not with what the new tab shows", async () => {
  quiet();
  const engine = await fixture({ closeOnEval: true, url: "https://example.test/" });
  const { step } = controlled(engine);
  // The reader asks for the address, reads the page (the tab closes after that answer), and asks for the address again.
  expect(await step("agent_browser_read")).toEqual(REPLACED);
  expect(engine.count("get url")).toBe(2);
  expect(engine.count("tab new")).toBe(1);
  expect(await step("agent_browser_click", { selector: "@e3" })).toMatchObject({ isError: false });
}, 30_000);

witness("TABGONE-1021: a mediated read that meets the closed tab when no new one can be opened is told that, plainly", async () => {
  quiet();
  const engine = await fixture({ newTabFails: true });
  const { step } = controlled(engine);
  engine.closeBoundTab();
  const reply = await step("agent_browser_read");
  expect(reply).toEqual(CLOSED);
  expect(text(reply)).not.toMatch(/agent-browser|tab_gone|TAB1|incomplete/u);
  expect(engine.count("tab new")).toBe(1);
}, 30_000);

witness("TABGONE-1021: a page call of Murage's own, in a step that began before the tab was replaced, is not sent", async () => {
  quiet();
  const engine = await fixture();
  const native = engine.relay();
  const begun = await native.beginStep!("agent_browser_read");
  expect(begun).toEqual({ gen: 0 });
  engine.closeBoundTab();
  await native.command(["get", "url"]);
  await expect(native.request("tools/call", { name: "agent_browser_snapshot", arguments: {} }, { internal: true, stepGen: 0 })).rejects.toThrow("replaced");
  expect(engine.count("snapshot")).toBe(0);
  expect(await native.endStep!(0)).toEqual(REPLACED);
  // Told by the step's end: nothing more is owed.
  expect(await click(native, "@e1")).toMatchObject({ isError: false });
}, 30_000);

witness("TABGONE-1021: while the engine keeps refusing, the bot's own new tab is sent at once and recovers, with nothing left to tell", async () => {
  quiet();
  const engine = await fixture({ newTabFails: true });
  const native = engine.relay();
  engine.closeBoundTab();
  expect(await click(native, "@e1")).toEqual(CLOSED);
  expect(await click(native, "@e2")).toEqual(CLOSED);
  expect(engine.count("tab new")).toBe(1);
  expect(engine.count("click @e2")).toBe(0);
  // Chrome answers again. The bot asks for a tab itself.
  engine.write({ ...engine.read(), newTabFails: false });
  expect(await native.request("tools/call", { name: "agent_browser_tab_new", arguments: {} })).toMatchObject({ isError: false });
  expect(await click(native, "@e3")).toMatchObject({ isError: false });
  expect(engine.count("click @e3")).toBe(1);
}, 30_000);

witness("TABGONE-1021: while the engine keeps refusing, the owner's Reopen blank page is tried at once", async () => {
  quiet();
  const engine = await fixture();
  const native = engine.relay();
  engine.closeBoundTab();
  engine.write({ ...engine.read(), stayGone: true });
  for (const selector of ["@e1", "@e2", "@e3"]) await click(native, selector);
  expect(engine.count("tab new")).toBe(2);
  // The engine lets go of the closed tab at its next new tab; the owner asks for a page.
  engine.write({ ...engine.read(), stayGone: false });
  await expect(native.command(["open", "about:blank"])).resolves.toMatchObject({ ran: "open about:blank", tab: "TAB4" });
  expect(engine.count("tab new")).toBe(3);
  // A tab the bot did not choose: it is told once.
  expect(await click(native, "@e4")).toEqual(REPLACED);
  expect(await click(native, "@e5")).toMatchObject({ isError: false });
}, 30_000);

witness("TABGONE-1021: while the engine keeps refusing, the bot's steps make one more try per wait, and it is told as a new tab only once it works", async () => {
  quiet();
  const engine = await fixture();
  const native = engine.relay({ tabRetryMs: 1000 });
  engine.closeBoundTab();
  engine.write({ ...engine.read(), stayGone: true });
  const replies = [];
  for (const selector of ["@e1", "@e2", "@e3", "@e4", "@e5"]) replies.push(await click(native, selector));
  expect(replies.slice(2)).toEqual([CLOSED, CLOSED, CLOSED]);
  expect(engine.count("tab new")).toBe(2);
  await pause(1100);
  // The wait is over: this step is spent on one more new tab. The engine takes it and still refuses, so nothing was replaced.
  expect(await click(native, "@e6")).toEqual(CLOSED);
  expect(engine.count("tab new")).toBe(3);
  expect(engine.count("click @e6")).toBe(0);
  // A try that failed doubles the wait: a second one after the first wait's length is not made.
  await pause(1100);
  expect(await click(native, "@e7")).toEqual(CLOSED);
  expect(engine.count("tab new")).toBe(3);
  // The engine lets go of the closed tab at its next new tab.
  engine.write({ ...engine.read(), stayGone: false });
  await pause(1300);
  expect(await click(native, "@e8")).toEqual(REPLACED);
  expect(engine.count("tab new")).toBe(4);
  expect(engine.count("click @e8")).toBe(0);
  expect(await click(native, "@e9")).toMatchObject({ isError: false });
}, 30_000);

witness("TABGONE-1021: through the controller, bot steps against an engine that keeps refusing open two tabs, and the step's end opens none", async () => {
  quiet();
  const engine = await fixture();
  const { step } = controlled(engine);
  engine.closeBoundTab();
  engine.write({ ...engine.read(), stayGone: true });
  const replies = [];
  for (const selector of ["@e1", "@e2", "@e3", "@e4"]) replies.push(await step("agent_browser_click", { selector }));
  expect(replies).toEqual([REPLACED, REPLACED, CLOSED, CLOSED]);
  expect(engine.count("tab new")).toBe(2);
  // The view's attach is not run at the end of the bot's step, so it neither opens a tab nor shortens the wait.
  expect(engine.count("get url")).toBe(0);
}, 30_000);

witness("TABGONE-1021: opening an address on a closed tab goes on in the new tab", async () => {
  quiet();
  const engine = await fixture();
  const native = engine.relay();
  engine.closeBoundTab();
  const opened = await native.request("tools/call", { name: "agent_browser_open", arguments: { url: "https://example.test/" } });
  expect(opened).toMatchObject({ isError: false, structuredContent: { response: { data: { tab: "TAB2" } } } });
  expect(engine.count("open https://example.test/")).toBe(2);
  expect(engine.count("tab new")).toBe(1);
  // The bot chose its page, so nothing is left to tell.
  expect(await click(native, "@e1")).toMatchObject({ isError: false });
}, 30_000);

witness("TABGONE-1021: the owner's command sent while the replacement is in flight waits for it too", async () => {
  quiet();
  const engine = await fixture();
  const native = engine.relay();
  expect(await native.request("tools/call", { name: "agent_browser_snapshot", arguments: {} })).toMatchObject({ isError: false });
  engine.closeBoundTab();
  engine.write({ ...engine.read(), holdNewTab: true });
  // The bot's step meets the closed tab; Murage's `tab new` is with the engine, unanswered.
  const acted = click(native, "@e1");
  await until(() => engine.count("tab new") === 1);
  let settled = false;
  const opened = native.command(["open", "https://example.test/owner"]).finally(() => { settled = true; });
  await pause(400);
  expect(settled).toBe(false);
  expect(engine.count("open https://example.test/owner")).toBe(0);
  engine.write({ ...engine.read(), holdNewTab: false });
  expect(await acted).toEqual(REPLACED);
  await expect(opened).resolves.toMatchObject({ tab: "TAB2" });
  expect(engine.count("open https://example.test/owner")).toBe(1);
  expect(engine.count("tab new")).toBe(1);
}, 30_000);

witness("TABGONE-1021: a step that makes its own page calls does not begin while the replacement is in flight", async () => {
  quiet();
  const engine = await fixture();
  const native = engine.relay();
  engine.closeBoundTab();
  engine.write({ ...engine.read(), holdNewTab: true });
  const owner = native.command(["get", "url"]);
  await until(() => engine.count("tab new") === 1);
  let begun: unknown;
  const begin = native.beginStep!("agent_browser_read").then((step) => { begun = step; });
  await pause(300);
  expect(begun).toBeUndefined();
  engine.write({ ...engine.read(), holdNewTab: false });
  await owner; await begin;
  expect(begun).toEqual({ notice: REPLACED });
}, 30_000);

witness("TABGONE-1021: a new tab that did not take for the owner's command is never told to the bot as a replacement", async () => {
  quiet();
  const engine = await fixture();
  const native = engine.relay();
  engine.closeBoundTab();
  engine.write({ ...engine.read(), stayGone: true });
  // The owner's view: one new tab, the same command refused again on it.
  await expect(native.command(["get", "url"])).rejects.toBeInstanceOf(BrowserEngineError);
  expect(engine.count("tab new")).toBe(1);
  // The bot's step makes the next try rather than being told about a tab that does not work. That one does not take
  // either (the engine is asked on it before anything is said), so the bot hears the plain truth and no third tab is opened.
  expect(await click(native, "@e1")).toEqual(CLOSED);
  expect(engine.count("tab new")).toBe(2);
  expect(await click(native, "@e2")).toEqual(CLOSED);
  expect(engine.count("tab new")).toBe(2);
  expect(engine.ran().filter((entry) => entry.startsWith("click "))).toEqual([]);
}, 30_000);

witness("TABGONE-1021: answers the engine gives with no tab bound do not count as the new tab working", async () => {
  quiet();
  const engine = await fixture();
  const native = engine.relay();
  engine.closeBoundTab();
  engine.write({ ...engine.read(), stayGone: true });
  // Listing tabs and the view's stream are answered whether or not the bot has a tab.
  const idle = async () => {
    expect(await native.request("tools/call", { name: "agent_browser_tab_list", arguments: {} })).toMatchObject({ isError: false });
    await expect(native.command(["stream", "status"])).resolves.toBeTruthy();
  };
  expect(await click(native, "@e1")).toEqual(REPLACED);
  await idle();
  expect(await click(native, "@e2")).toEqual(REPLACED);
  await idle();
  // Still two new tabs and then the plain truth, however many such answers came in between.
  expect(await click(native, "@e3")).toEqual(CLOSED);
  await idle();
  expect(await click(native, "@e4")).toEqual(CLOSED);
  expect(engine.count("tab new")).toBe(2);
}, 30_000);

// A late answer: one that was already on its way when the tab closed said "the tab is live" when it
// arrived, cleared the count of tabs opened and the wait, and the bot's next step opened a third tab and a fourth.

witness("TABGONE-1021 W7: the view's attach answer that was on its way when the tab closed does not reopen the two-tab limit", async () => {
  quiet();
  const engine = await fixture({ holdReply: "get url" });
  const native = engine.relay({ tabRetryMs: 600_000 });
  // The live view attaches: its `get url` runs on the live tab, and the answer is slow to come back.
  let connected = false;
  const view = native.connect(noop, noop, noop).then((id) => { connected = true; return id; });
  await until(() => engine.count("get url") === 1);
  // Meanwhile the owner closes the bot's tab, and the engine keeps refusing for it whatever tab is opened.
  engine.write({ ...engine.read(), gone: "TAB1", bound: null, stayGone: true });
  expect([await click(native, "@e3"), await click(native, "@e3"), await click(native, "@e3")]).toEqual([REPLACED, REPLACED, CLOSED]);
  expect(engine.count("tab new")).toBe(2);
  expect(engine.count("click @e3")).toBe(3);
  expect(connected).toBe(false);
  // Now the old answer arrives. It was sent before any of this and says nothing about the tabs opened since.
  engine.write({ ...engine.read(), holdReply: undefined });
  await expect(view).resolves.toBeTypeOf("string");
  expect(engine.count("get url")).toBe(1);
  // The limit and the wait both stand: nothing is sent, no third tab.
  expect([await click(native, "@e3"), await click(native, "@e3")]).toEqual([CLOSED, CLOSED]);
  expect(engine.count("tab new")).toBe(2);
  expect(engine.count("click @e3")).toBe(3);
}, 30_000);

witness("TABGONE-1021 W8: a bot step's answer that was on its way when the tab closed does not reopen the two-tab limit either", async () => {
  quiet();
  const engine = await fixture({ holdReply: "agent_browser_snapshot" });
  const native = engine.relay({ tabRetryMs: 600_000 });
  let answered = false;
  const slow = native.request("tools/call", { name: "agent_browser_snapshot", arguments: {} }).then((reply) => { answered = true; return reply; });
  await until(() => engine.count("snapshot") === 1);
  engine.write({ ...engine.read(), gone: "TAB1", bound: null, stayGone: true });
  expect([await click(native, "@e3"), await click(native, "@e3"), await click(native, "@e3")]).toEqual([REPLACED, REPLACED, CLOSED]);
  expect(engine.count("tab new")).toBe(2);
  expect(answered).toBe(false);
  engine.write({ ...engine.read(), holdReply: undefined });
  await expect(slow).resolves.toMatchObject({ isError: false });
  expect([await click(native, "@e3"), await click(native, "@e3")]).toEqual([CLOSED, CLOSED]);
  expect(engine.count("tab new")).toBe(2);
  expect(engine.count("click @e3")).toBe(3);
}, 30_000);

witness("TABGONE-1021 W9: an owner's answer sent on the second new tab, arriving after that tab closed too, does not start the count again", async () => {
  quiet();
  const engine = await fixture();
  const native = engine.relay({ tabRetryMs: 600_000 });
  // The owner closes the bot's tab, and the next one: two new tabs, and no page command has run on either.
  engine.closeBoundTab();
  expect(await click(native, "@e3")).toEqual(REPLACED);
  engine.closeBoundTab();
  expect(await click(native, "@e3")).toEqual(REPLACED);
  expect(engine.read()).toMatchObject({ bound: "TAB3", gone: null });
  // The owner's command runs on the third tab; its answer is slow. The owner closes that tab as well.
  engine.write({ ...engine.read(), holdReply: "get url" });
  let answered = false;
  const slow = native.command(["get", "url"]).then((value) => { answered = true; return value; });
  await until(() => engine.count("get url") === 1);
  engine.closeBoundTab();
  expect(await click(native, "@e3")).toEqual(CLOSED);
  expect(engine.count("tab new")).toBe(2);
  expect(answered).toBe(false);
  engine.write({ ...engine.read(), holdReply: undefined });
  await expect(slow).resolves.toMatchObject({ tab: "TAB3" });
  // Murage has since found no working tab; the old answer does not undo that.
  expect(await click(native, "@e3")).toEqual(CLOSED);
  expect(engine.count("tab new")).toBe(2);
  expect(engine.count("click @e3")).toBe(3);
}, 30_000);

witness("TABGONE-1021 W10: an answer sent after the new tabs were opened still counts: a working tab ends the limit and the wait", async () => {
  quiet();
  const engine = await fixture({ bound: null, gone: "TAB1", stayGone: true });
  const native = engine.relay({ tabRetryMs: 600_000 });
  expect([await click(native, "@e3"), await click(native, "@e3"), await click(native, "@e3")]).toEqual([REPLACED, REPLACED, CLOSED]);
  expect(engine.count("tab new")).toBe(2);
  // The owner asks for a page and the engine is well again: that command opens its tab, runs on it, and its answer is today's news.
  engine.write({ ...engine.read(), stayGone: false });
  await expect(native.command(["open", "about:blank"])).resolves.toMatchObject({ tab: "TAB4" });
  // The bot is told about that tab; the step is not sent, so no step of the bot's has been answered yet.
  expect(await click(native, "@e3")).toEqual(REPLACED);
  expect(engine.count("click @e3")).toBe(3);
  // The owner's answer alone started the count again: the next closed tab gets its new tab.
  engine.closeBoundTab();
  expect(await click(native, "@e3")).toEqual(REPLACED);
  expect(engine.count("tab new")).toBe(4);
  expect(await click(native, "@e3")).toMatchObject({ isError: false });
}, 30_000);

witness("TABGONE-1021 W11: the bot's own new tab, answered after Murage opened another one, is not taken for the tab the bot is on", async () => {
  quiet();
  const engine = await fixture({ bound: null, gone: "TAB1", holdReply: "agent_browser_tab_new" });
  const native = engine.relay({ tabRetryMs: 600_000 });
  // The bot asks for a tab of its own (TAB2); the answer is slow. The owner closes that tab, and the view's command gets TAB3.
  let answered = false;
  const own = native.request("tools/call", { name: "agent_browser_tab_new", arguments: {} }).then((reply) => { answered = true; return reply; });
  await until(() => engine.count("tab new") === 1);
  expect(engine.read()).toMatchObject({ bound: "TAB2", gone: null });
  engine.closeBoundTab();
  await expect(native.command(["get", "url"])).resolves.toMatchObject({ tab: "TAB3" });
  expect(answered).toBe(false);
  engine.write({ ...engine.read(), holdReply: undefined });
  await expect(own).resolves.toMatchObject({ isError: false });
  // The bot chose TAB2, not TAB3: it is told before anything of its runs there.
  expect(await click(native, "@e3")).toEqual(REPLACED);
  expect(engine.count("click @e3")).toBe(0);
  expect(await click(native, "@e3")).toMatchObject({ isError: false });
  expect(engine.count("tab new")).toBe(2);
}, 30_000);

witness("TABGONE-1021 W12: an address opened again on the new tab is an answer from that tab, so the next closed tabs get theirs", async () => {
  quiet();
  const engine = await fixture();
  const native = engine.relay({ tabRetryMs: 600_000 });
  engine.closeBoundTab();
  // Refused on the closed tab, sent once more on the new one: that second answer is the new tab's own.
  expect(await native.request("tools/call", { name: "agent_browser_open", arguments: { url: "https://example.test/" } })).toMatchObject({ isError: false });
  expect(engine.count("open https://example.test/")).toBe(2);
  // So the count of tabs opened starts again, and each of the next two closed tabs gets a new one.
  engine.closeBoundTab();
  expect(await click(native, "@e3")).toEqual(REPLACED);
  engine.closeBoundTab();
  expect(await click(native, "@e3")).toEqual(REPLACED);
  expect(engine.count("tab new")).toBe(3);
  expect(engine.read()).toMatchObject({ bound: "TAB4", gone: null });
}, 30_000);
