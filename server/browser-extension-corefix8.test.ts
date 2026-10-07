// SPDX-License-Identifier: AGPL-3.0-or-later
import { domFunction, nativeRealm } from "./testing/native-dom-fixture.ts";
// Round 8 (Codex Astra chrome7 report, SEC-01 to SEC-10). Each test reproduces the attack the report describes and fails on the base
// commit b569630c. Chrome-dependent proofs (a real page, a real closed shadow root) are in scripts/browser-corefix8.node-test.mjs.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyFloor } from "./browser-floor.ts";
import { COLLECT_RECIPIENTS_SOURCE, isSecretDescriptor } from "./browser-floor-facts.ts";
import { cleanRecipients, looksLikeSecretValue, withoutSecretValues } from "./browser-recipient-safety.ts";
import { looksLikeSecretName } from "../shared/browser-secret-classifier.ts";
import { BrowserExtensionExecutor, type ExtensionAction, type ExtensionDocument } from "./browser-extension-executor.ts";
import { DESCRIBE_TARGET_SOURCE } from "./browser-extension-page-scripts.ts";
import { createBrowserExtensionService } from "./browser-extension-service.ts";
// @ts-ignore -- a plain .mjs module with no declaration file
import { SENSITIVE_RECTS } from "../extensions/murage-browser/runtime.mjs";
import type { BrowserExtensionCommand, BrowserExtensionHello, BrowserExtensionResponse } from "../shared/browser-extension-protocol.ts";

// ---------------------------------------------------------------------------------------------------------------------------------
// SEC-01: incomplete facts on any activating action go to the owner, whatever name the page gave the control.
describe("SEC-01 incomplete facts on an activating action are the owner's", () => {
  it.each([
    ["click", undefined], ["submit", undefined], ["dblclick", undefined], ["check", undefined], ["press", "Enter"], ["press", " "],
  ] as const)("%s %s with a harmless-looking name but failed facts is floor (unsure)", (operation, key) => {
    const got = classifyFloor({ operation, ...(key ? { key } : {}), tag: "a", role: "link", name: "Next page", factsFailed: true } as never);
    expect(got.floor).not.toBeNull();
    expect(got.unsure).toBe(true);
  });
  it("a key that only moves focus (Tab) is still not an activation", () => {
    expect(classifyFloor({ operation: "press", key: "Tab", tag: "a", name: "Next page", factsFailed: true } as never).floor).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// SEC-06 / SEC-08 / SEC-09: one shared classifier, applied wherever a value can leave a page.
describe("SEC-08 the shared secret classifier", () => {
  it.each([
    "4111.1111.1111.1111", "4111 1111 1111 1111", "4111-1111-1111-1111", "078-05-1120", "078 05 1120", "078.05.1120", "12345678", "1234567", "123456", "1234",
    "41111111", "11111111", "４１１１．１１１１．１１１１．１１１１", "１２３４５６", "٤١١١١١١١", "१२३४५६७८", "๑๒๓๔๕๖", "@４１１１１１１１", "@12345678",
  ])("%s is a secret value", value => {
    expect(looksLikeSecretValue(value)).toBe(true);
    expect(cleanRecipients([value])).toEqual([]);
    expect(withoutSecretValues([value])).toEqual([]);
  });
  it.each(["ana@example.com", "@ana_k", "+1 555 123 4567", "(555) 123-4567", "5551234567", "+15551234567", "ana.k@example.co.uk"])("%s is still a recipient", value => {
    expect(looksLikeSecretValue(value)).toBe(false);
    expect(cleanRecipients([value])).toEqual([value]);
  });
  it("names are judged in the common languages", () => {
    for (const name of ["カード番号", "密码", "National ID", "パスワード", "비밀번호", "номер карты", "Kreditkarte", "verification code"]) expect(looksLikeSecretName(name), name).toBe(true);
    for (const name of ["To", "Recipient", "bcc-recipients", "Subject"]) expect(looksLikeSecretName(name), name).toBe(false);
  });
  it("the descriptor check knows a credential named in another script, even when no form flag is raised", () => {
    expect(isSecretDescriptor({ type: "text", autocomplete: "", names: "密码", idName: "", masked: false })).toBe(true);
    expect(isSecretDescriptor({ type: "text", autocomplete: "", names: "カード番号", idName: "", masked: false })).toBe(true);
    expect(isSecretDescriptor({ type: "email", autocomplete: "", names: "To", idName: "to", masked: false })).toBe(false);
  });
});

class Node_ {
  nodeType = 1;
  parentNode: Node_ | null = null; host: Node_ | null = null; children: Node_[] = []; shadowRoot: Node_ | null = null; childNodes: { nodeType: number; textContent: string }[] = [];
  id = ""; name = ""; value = ""; type = ""; labels: { textContent: string }[] = []; ownerDocument: unknown = {}; form: Node_ | null = null; textContent = "";
  constructor(public localName: string, public attrs: Record<string, string> = {}, text = "") {
    this.id = attrs.id ?? ""; this.name = attrs.name ?? ""; this.type = attrs.type ?? ""; this.value = attrs.value ?? "";
    if (text) { this.childNodes.push({ nodeType: 3, textContent: text }); this.textContent = text; }
  }
  getAttribute(k: string) { return k in this.attrs ? this.attrs[k] : null; }
  add(...kids: Node_[]) { for (const k of kids) { k.parentNode = this; this.children.push(k); this.textContent += k.textContent; } return this; }
}
const el = (tag: string, attrs: Record<string, string> = {}, text = "") => new Node_(tag, attrs, text);
type Scan = { recipients: string[]; incomplete: boolean; fields: unknown[] };
const scan = (build: (button: Node_) => Node_): Scan => {
  const button = el("button", { "aria-label": "Send" }); const root = build(button); button.ownerDocument = { body: root, documentElement: root };
  const g = globalThis as any; const before = g.getComputedStyle; g.getComputedStyle = () => ({ webkitTextSecurity: "none" });
  try { return (domFunction(`return (${COLLECT_RECIPIENTS_SOURCE});`)() as () => Scan).call(button); } finally { g.getComputedStyle = before; }
};
const form = (...kids: Node_[]) => { const f = el("form"); f.add(...kids); return f; };

describe("SEC-08 the recipient scan never lets a secret through in another shape", () => {
  it.each(["4111.1111.1111.1111", "078-05-1120", "12345678", "41111111", "11111111", "４１１１１１１１"])("a recipient-labelled field holding %s is not a recipient and the scan says unknown", value => {
    const result = scan(button => form(el("input", { name: "to", value }), button));
    expect(result.recipients).toEqual([]);
    expect(result.incomplete).toBe(true);
  });
  it("a full-width number wrapped as an @handle is dropped", () => {
    const result = scan(button => form(el("input", { name: "to", value: "@４１１１１１１１" }), button));
    expect(result.recipients).toEqual([]);
    expect(result.incomplete).toBe(true);
  });
  it("a hidden input named like a recipient but holding a card number is dropped", () => {
    const result = scan(button => form(el("input", { type: "hidden", name: "to", value: "4111.1111.1111.1111" }), button));
    expect(result.recipients).toEqual([]);
  });
  it("a plain address still comes through, with a descriptor for every token", () => {
    const result = scan(button => form(el("input", { name: "to", value: "ana@example.com" }), button));
    expect(result.recipients).toEqual(["ana@example.com"]);
    expect(result.fields).toHaveLength(1);
    expect(result.fields[0]).not.toBeNull();
  });
});

describe("SEC-09 contenteditable regions are classified, with their ancestors", () => {
  it("a contenteditable labelled in Japanese as a card number inside a To region is not harvested", () => {
    const result = scan(button => form(el("div", { contenteditable: "true", "aria-label": "To" }).add(el("div", { contenteditable: "true", "aria-label": "カード番号" }, "4111.1111.1111.1111")), button));
    expect(result.recipients).toEqual([]);
  });
  it("a noneditable private ancestor does not hide an editable recipient", () => {
    const outer = el("div", { "aria-label": "Password reset", id: "pw-zone" });
    const region = el("div", { contenteditable: "true", "aria-label": "To" }, "ana@example.com");
    outer.add(region);
    const result = scan(button => form(outer, button));
    expect(result.recipients).toEqual(["ana@example.com"]);
  });
  it("every harvested token carries a descriptor", () => {
    const result = scan(button => form(el("div", { contenteditable: "true", "aria-label": "Recipients" }, "ana@example.com"), button));
    expect(result.recipients).toEqual(["ana@example.com"]);
    expect(result.fields.length).toBe(result.recipients.length);
    expect(result.fields.every(field => field !== null && field !== undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Executor: SEC-02 (re-check before every activating input) and SEC-10 (no live values in descriptions or digests).
const DOC: ExtensionDocument = { profileId: "p", tabId: 1, frameId: "frame", navigationEpoch: 1, origin: "https://example.test", url: "https://example.test/" };
type Describe = { display: Record<string, unknown>; bound: unknown; values?: unknown[]; editable?: boolean };
function executorFixture(initial: Describe, onMouseDown?: (set: (value: Describe) => void) => void) {
  let describeValue = initial; const calls: { method: string; params: Record<string, unknown> }[] = []; const decisions: ExtensionAction[] = [];
  const set = (value: Describe) => { describeValue = value; };
  const executor = new BrowserExtensionExecutor({
    // The facts stay benign on purpose: only the executor's own re-check can catch the change.
    collectFacts: async (_io: unknown, _t: unknown, operation: string) => ({ operation, tag: "button", role: "button", name: "Continue" }) as never,
    authorize: () => true, access: async () => true, admit: async action => { decisions.push(action); return true; },
    createEngine: hooks => ({
      resolveTarget: async () => ({ backendNodeId: 12, document: { ...DOC } }), resolveTab: async () => ({ ...DOC }), event() {}, async close() {},
      async call(name) {
        if (name === "agent_browser_click") {
          await hooks.beforeCommand({ ...DOC }, "Input.dispatchMouseEvent", { type: "mousePressed", x: 5, y: 5, button: "left", clickCount: 1 });
          calls.push({ method: "Input.dispatchMouseEvent", params: { type: "mousePressed" } });
          onMouseDown?.(set);
          await hooks.beforeCommand({ ...DOC }, "Input.dispatchMouseEvent", { type: "mouseReleased", x: 5, y: 5, button: "left", clickCount: 1 });
          calls.push({ method: "Input.dispatchMouseEvent", params: { type: "mouseReleased" } });
        }
        return { content: [{ type: "text", text: "ok" }] };
      },
    }),
    transport: {
      document: async () => ({ ...DOC }),
      send: async (method, params) => {
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame", loaderId: "L" } } };
        if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
        if (method === 'DOM.getDocument') return { root: { nodeType: 9, children: [] } };
        if (method === "Runtime.evaluate") {
          if (String(params.expression).includes("__murageGuard()")) return { result: { type: "boolean", value: false } };
          if (params.returnByValue === false) return { result: { objectId: "node" } };
          return { result: { value: 0 } };
        }
        if (method === "DOM.describeNode") return { node: { backendNodeId: 12, nodeName: "BUTTON" } };
        if (method === "DOM.resolveNode") return { object: { objectId: "node" } };
        if (method === "Runtime.callFunctionOn") return { result: { value: params.functionDeclaration === DESCRIBE_TARGET_SOURCE ? JSON.stringify(describeValue) : true } };
        return {};
      },
    },
  });
  return { executor, calls, decisions, set };
}
const BUTTON: Describe = { display: { tag: "BUTTON", text: "Continue", fieldCount: 0, fieldNames: [] }, bound: { tag: "BUTTON", hidden: [] }, values: [], editable: false };

describe("SEC-02 the target is checked again right before each half of a click", () => {
  it("a button that becomes 'Accept terms' on mousedown is never released", async () => {
    const f = executorFixture(BUTTON, set => set({ ...BUTTON, display: { ...BUTTON.display, text: "Accept terms" } }));
    await expect(f.executor.call("agent_browser_click", { selector: "button" })).rejects.toThrow(/changed/);
    expect(f.calls.map(call => call.params.type)).toEqual(["mousePressed"]);
  });
  it("a payload that changes between mousedown and mouseup (a hidden field) cancels the activation", async () => {
    const f = executorFixture(BUTTON, set => set({ ...BUTTON, bound: { tag: "BUTTON", hidden: [["amount", "9999"]] } }));
    await expect(f.executor.call("agent_browser_click", { selector: "button" })).rejects.toThrow(/changed/);
    expect(f.calls.map(call => call.params.type)).toEqual(["mousePressed"]);
  });
  it("a field value that changes under the click cancels the activation of a button", async () => {
    const f = executorFixture({ ...BUTTON, values: ["a"] }, set => set({ ...BUTTON, values: ["b"] }));
    await expect(f.executor.call("agent_browser_click", { selector: "button" })).rejects.toThrow(/changed/);
  });
  it("a page that does not change gets both halves", async () => {
    const f = executorFixture(BUTTON);
    await expect(f.executor.call("agent_browser_click", { selector: "button" })).resolves.toBeDefined();
    expect(f.calls.map(call => call.params.type)).toEqual(["mousePressed", "mouseReleased"]);
  });
});

describe("SEC-10 a field's live value is never in a description or an unkeyed digest", () => {
  const editable = (value: string): Describe => ({ display: { tag: "DIV", text: "", fieldCount: 1, fieldNames: ["notes"] }, bound: { tag: "DIV", hidden: [], fields: [["notes", null]] }, values: [value], editable: true });
  const digestFor = async (value: string) => {
    const f = executorFixture(editable(value));
    await f.executor.call("agent_browser_click", { selector: "#notes" });
    return f.decisions[0];
  };
  it("the card and the push text never show the value", async () => {
    const action = await digestFor("482913");
    expect(JSON.stringify(action)).not.toContain("482913");
  });
  it("a changed value still changes the digest, and the same value gives the same digest", async () => {
    const a = await digestFor("482913"), b = await digestFor("482914"), c = await digestFor("482913");
    expect(a.digest).not.toBe(b.digest);
    expect(a.digest).toBe(c.digest);
  });
  it("the digest cannot be rebuilt by hashing the plain value (no dictionary attack on a six-digit code)", async () => {
    const a = await digestFor("482913");
    const plain = createHash("sha256").update(JSON.stringify([{ name: "agent_browser_click", arguments: { selector: "#notes" } }, DOC, 12, "", ""])).digest("hex");
    expect(a.digest).not.toBe(plain);
    for (const guess of ["482913", "000000"]) {
      const bare = createHash("sha256").update(JSON.stringify(editable(guess).bound) + guess).digest("hex");
      expect(a.digest).not.toBe(bare);
    }
  });
  it("the describing page function leaves editable text out of the description", () => {
    expect(DESCRIBE_TARGET_SOURCE).toContain("holdsEditable?''");
    expect(DESCRIBE_TARGET_SOURCE).not.toMatch(/bound=\{[^}]*e\.value/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Screenshot masks (SEC-05, SEC-06).
describe("screenshot masks use the shared classifier and cover what the guard cannot read", () => {
  const box = (x: number) => ({ x, y: 1, width: 10, height: 5 });
  const field = (x: number, attrs: Record<string, string>, value = "") => ({ nodeType: 1, localName: "input", getBoundingClientRect: () => box(x), type: attrs.type ?? "text", name: attrs.name ?? "", id: attrs.id ?? "", value, isContentEditable: false, getAttribute: (k: string) => attrs[k] ?? null, parentNode: null });
  const mask = async (children: unknown[]) => {
    let got: { x: number }[] = [];
    const document = { documentElement: { nodeType: 1, localName: "html", children } };
    await runInNewContext(SENSITIVE_RECTS, { ...nativeRealm, document, getComputedStyle: () => ({ webkitTextSecurity: "none" }), innerWidth: 800, innerHeight: 600, __muragePresence: { capture: (_on: boolean, rects: { x: number }[]) => { got = rects; return true; } } });
    return got.map(r => r.x).sort((a, b) => a - b);
  };
  it("a field called National ID is covered", async () => { expect(await mask([field(10, { "aria-label": "National ID" })])).toEqual([10]); });
  it("a field called カード番号 is covered", async () => { expect(await mask([field(11, { "aria-label": "カード番号" })])).toEqual([11]); });
  it("a field holding a one-time code, whatever it is called, is covered", async () => { expect(await mask([field(12, { "aria-label": "Notes" }, "482913")])).toEqual([12]); });
  it("a plain field is not covered", async () => { expect(await mask([field(13, { "aria-label": "Subject" }, "hello")])).toEqual([]); });
  it("an empty custom element (a closed root or a widget this world cannot read) is covered", async () => {
    const host = { nodeType: 1, localName: "x-card", shadowRoot: null, children: [], textContent: "", getBoundingClientRect: () => box(14) };
    expect(await mask([host])).toEqual([14]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Service: SEC-03, SEC-04, SEC-07.
const A = "https://fixture.test";
const cleanup: string[] = [];
const services: Awaited<ReturnType<typeof createBrowserExtensionService>>[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.close(); for (const directory of cleanup.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });
type Tab = { tabId: number; navigationEpoch: number; origin: string; url: string };
async function serviceFixture(extra: Record<string, unknown> = {}) {
  const directory = await fs.mkdtemp(path.resolve(".corefix8-")); cleanup.push(directory); await fs.chmod(directory, 0o700);
  const bindings = new Map<string, { generation: number; state: string; tabs: Tab[] }>();
  const calls: BrowserExtensionCommand[] = []; const siteAsked: string[] = []; const cards: string[] = [];
  let facts: Record<string, unknown> = { tag: "textarea", role: "textbox", name: "Notes" };
  const broker = {
    profiles: (): BrowserExtensionHello[] => [{ version: 1, type: "hello", profileId: "profile", browser: "chromium", extensionVersion: "1.0", capabilities: ["scoped_cdp", "durable_stop", "explicit_share", "manual_pause", "engine_cdp_v1", "unexpected_input_pause", "ordered_requests_v1", "lifecycle_v1"] } as never],
    async request(_profile: string, command: BrowserExtensionCommand): Promise<BrowserExtensionResponse> {
      calls.push(command);
      let b = bindings.get(command.bindingId);
      if (!b) { b = { generation: 1, state: "active", tabs: [{ tabId: 1, navigationEpoch: 1, origin: A, url: A + "/" }] }; bindings.set(command.bindingId, b); }
      if (command.operation === "stop" || command.operation === "pause") { b.generation++; b.state = command.operation === "stop" ? "stopped" : "paused"; }
      let result: any = b;
      if (command.operation === "cdp") {
        const { method, params } = command.params as any; let value: any = {};
        if (method === "Page.getFrameTree") value = { frameTree: { frame: { id: "frame", loaderId: "L" } } };
        if (method === "Page.createIsolatedWorld") value = { executionContextId: 7 };
        if (method === 'DOM.getDocument') value = { root: { nodeType: 9, children: [] } };
        if (method === "DOM.describeNode") value = { node: { backendNodeId: 12 } };
        if (method === "DOM.resolveNode") value = { object: { objectId: "target" } };
        if (method === "Runtime.evaluate") value = { result: { value: String(params.expression).includes("__murageGuard()") ? false : "page", objectId: "target" } };
        if (method === "Runtime.callFunctionOn") value = { result: { value: String(params.functionDeclaration).includes("elementFromPoint") ? true : JSON.stringify({ display: { tag: "BUTTON", text: "x", label: "x" }, bound: null }) } };
        result = { result: value, ...b.tabs[0] };
      }
      return { version: 1, type: "response", id: command.id, bindingId: command.bindingId, generation: command.generation, result: structuredClone(result) };
    },
  };
  const options = {
    collectFacts: async (_io: unknown, _t: unknown, operation: string) => ({ operation, ...facts, visibility: { box: { x: 1, y: 1, width: 50, height: 20 }, inViewport: true, opacity: 1, visibility: "visible", ariaHidden: false, coveredBy: null } }) as never,
    createEngine: (engine: import("./browser-extension-engine.ts").BrowserExtensionEngineOptions) => ({
      resolveTarget: async () => ({ backendNodeId: 12, document: await engine.transport.selected() }), resolveTab: async () => engine.transport.selected(), event() {}, async close() {},
      async call(name: string, args: Record<string, unknown>) {
        const document = await engine.transport.selected();
        if (name === "agent_browser_click") { for (const type of ["mousePressed", "mouseReleased"]) { const params = { type, x: 1, y: 1, button: "left", clickCount: 1 }; await engine.beforeCommand(document, "Input.dispatchMouseEvent", params); await engine.transport.send("Input.dispatchMouseEvent", params, document); } return { content: [{ type: "text", text: "ok" }] }; }
        const method = name === "agent_browser_fill" ? "Input.insertText" : "Accessibility.getFullAXTree"; const params = name === "agent_browser_fill" ? { text: args.text } : {};
        await engine.beforeCommand(document, method, params); await engine.transport.send(method, params, document); return { content: [{ type: "text", text: "ok" }] };
      },
    }) as never,
    broker, workspaceId: "workspace", stateFile: path.join(directory, "state.json"),
    askSite: async (_c: unknown, origin: string) => { siteAsked.push(origin); return "allow" as const; },
    askAction: async (_c: unknown, a: { summary: string }) => { cards.push(a.summary); return true; },
    ownerInstruction: () => ({ id: "m1", text: "please type hello into the notes box" }),
    approvalMode: () => "task" as const,
    ...extra,
  };
  const service = await createBrowserExtensionService(options as never);
  services.push(service);
  const binding = await service.ensureBinding({ botId: "bot", threadId: "thread", profileId: "profile" });
  const id = binding.bindingId;
  const run = (name: string, args: Record<string, unknown> = {}) => service.dispatch(id, name, args, () => true);
  let typed = 0; const fill = () => run("agent_browser_fill", { selector: "textarea", text: `hello ${++typed}` });
  const inputs = () => calls.filter(call => call.operation === "cdp" && String((call.params as any).method).startsWith("Input.")).length;
  return { service, id, calls, siteAsked, cards, run, fill, inputs, options, bindings, setFacts: (v: Record<string, unknown>) => { facts = v; } };
}
const SEND = { tag: "button", role: "button", name: "Send message" };
const gate = () => { let open!: () => void; const wait = new Promise<void>(resolve => { open = resolve; }); return { wait, open }; };

describe("SEC-03 changing the mode or the checker while a decision is in flight", () => {
  it("tightening Full to Step while the checker is thinking refuses the step; nothing reaches the page", async () => {
    const box = { mode: "full" as "full" | "step" }; const g = gate(); let asked = 0;
    const transport = vi.fn(async (request: { model: string }) => { asked++; await g.wait; return request.model === "s1" ? "ALLOW" : JSON.stringify({ decision: "allow", reason: "ok" }); });
    const f = await serviceFixture({ approvalMode: () => box.mode, checker: () => ({ deps: { transport, models: { stage1: "s1", stage2: "s2" } } }) });
    f.setFacts(SEND);
    const running = f.run("agent_browser_click", { selector: "button" }); const settled = running.then(() => "done", (error: Error) => error.message);
    await vi.waitFor(() => expect(asked).toBeGreaterThan(0), { timeout: 15000 });
    box.mode = "step";
    g.open();
    expect(String(await settled)).toMatch(/settings|NOT DONE/);
    expect(f.inputs()).toBe(0);
  });
  it("the settings change fences the binding and kills a pending card before it returns", async () => {
    const g = gate();
    const f = await serviceFixture({ approvalMode: () => "step" as const, askAction: async () => { await g.wait; return true; } });
    const running = f.fill(); const settled = running.then(() => "done", (error: Error) => error.message);
    await vi.waitFor(() => expect(f.siteAsked.length).toBe(1), { timeout: 15000 });
    await new Promise(resolve => setTimeout(resolve, 20));
    const changed = f.service.settingsChanged("bot");
    g.open(); await changed;
    expect(String(await settled)).not.toBe("done");
    expect(f.inputs()).toBe(0);
  });
});

describe("SEC-04 revoking a site takes its live task grants back", () => {
  it("after Ask the site cards again, and the task holds no grant for it", async () => {
    const f = await serviceFixture();
    await f.fill(); expect(f.siteAsked).toEqual([A]); await f.fill(); expect(f.siteAsked).toEqual([A]);
    expect(f.service.taskInfo(f.id)?.sites.map(site => site.origin)).toContain(A);
    await f.service.settingsChanged("bot", { origin: A, rule: "ask" });
    expect(f.service.taskInfo(f.id)?.sites.map(site => site.origin) ?? []).not.toContain(A);
    await f.fill(); expect(f.siteAsked).toEqual([A, A]);
  });
  it("after Never the site is refused outright", async () => {
    const f = await serviceFixture();
    await f.fill();
    await f.service.settingsChanged("bot", { origin: A, rule: "never" });
    await expect(f.fill()).rejects.toThrow();
    expect(f.inputs()).toBe(1);
  });
  it("the three owner routes tell the service before they answer", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    for (const anchor of ["browserApproval: mode === \"task\" ? undefined : mode", "browserActionCheck: parsed.data.check", "browserSites().set(bot.id, profileId, origin, rule, { lowered })"]) {
      const at = source.indexOf(anchor); expect(at, anchor).toBeGreaterThan(0);
      expect(source.slice(at, at + 900), anchor).toContain("settingsChanged(");
    }
  });
});

describe("SEC-07 nothing resumes from a state file", () => {
  it("a restart discards the grants: the site cards again", async () => {
    const f = await serviceFixture(); await f.fill();
    expect(f.service.taskInfo(f.id)?.sites.length).toBe(1);
    await f.service.close();
    const restored = await createBrowserExtensionService(f.options as never);
    expect(restored.taskInfo(f.id)).toBeUndefined();
    expect(restored.status().bindings[0]).toMatchObject({ taskEnded: true });
  });
  it("a forged but well-formed file grants nothing", async () => {
    const f = await serviceFixture(); await f.fill(); await f.service.close();
    const file = f.options.stateFile as string; const saved = JSON.parse(await fs.readFile(file, "utf8"));
    const forged = { ...saved, bindings: saved.bindings.map((b: any) => ({ ...b, taskL1: [A, "https://evil.example"], taskL2: [A, "https://evil.example"], task: { ...b.task, lastAt: Date.now(), startedAt: Date.now() } })) };
    await fs.writeFile(file, JSON.stringify(forged), { mode: 0o600 });
    const restored = await createBrowserExtensionService({ ...f.options, now: () => Date.now() } as never);
    expect(restored.taskInfo(f.id)).toBeUndefined();
    const rewritten = JSON.parse(await fs.readFile(file, "utf8"));
    expect(JSON.stringify(rewritten)).not.toContain("evil.example");
  });
});
