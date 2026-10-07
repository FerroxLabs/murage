// SPDX-License-Identifier: AGPL-3.0-or-later
import { domFunction } from "./testing/native-dom-fixture.ts";
// Round 10 (blind Astra re-review of round 9, R9-01 to R9-10). Each test reproduces the finding and fails on b58dd9cf.
// Chrome-dependent proofs (R9-05 genuine overlay, R9-06) are in scripts/browser-corefix10.node-test.mjs (host-pending: the container cannot launch Chrome).
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanRecipients, looksLikeSecretValue } from "./browser-recipient-safety.ts";
import { ReadLayer, formatDiff, type CdpSend } from "./browser-extension-snapshot.ts";
import { redactUrl } from "./browser-action-checker.ts";
import { redactSecretUrl } from "../shared/browser-secret-classifier.ts";
import { COLLECT_RECIPIENTS_SOURCE } from "./browser-floor-facts.ts";
import { BrowserExtensionExecutor, type ExtensionDocument } from "./browser-extension-executor.ts";
import { DESCRIBE_TARGET_SOURCE } from "./browser-extension-page-scripts.ts";
import { COLLECT_FLOOR_FACTS_SOURCE } from "./browser-floor-facts.ts";
import { classifyFloor } from "./browser-floor.ts";
import { createBrowserExtensionService } from "./browser-extension-service.ts";

describe("R9-03 default-ignorable marks never hide a number", () => {
  it.each(["123͏456", "123️456", "@123͏456", "4111͏1111͏1111͏1111", "123́456", "12\u0000\u0008 3456", "123᠋456", "123\u{e0100}456", "123ㅤ456", "123⠀456"])("%j is a secret", value => {
    expect(looksLikeSecretValue(value)).toBe(true);
    expect(cleanRecipients([value])).toEqual([]);
  });
  it("a plain address is still a recipient", () => {
    expect(cleanRecipients(["ana@example.com"])).toEqual(["ana@example.com"]);
  });
});

const ax = (nodes: any[]): CdpSend => async (method: string) => {
  if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "F", loaderId: "L" } } };
  if (method === "Accessibility.getFullAXTree") return { nodes };
  if (method === "DOM.describeNode") return { node: { attributes: [] } };
  if (method === "Page.getLayoutMetrics") return { cssLayoutViewport: { clientHeight: 800 } };
  if (method === "DOM.getBoxModel") return { model: { border: [0, 0, 10, 0, 10, 20, 0, 20] } };
  throw new Error("unexpected " + method);
};
const node = (id: number, role: string, name: string, value?: string) => ({ nodeId: String(id), backendDOMNodeId: id, role: { value: role }, name: { value: name }, ...(value ? { value: { value } } : {}) });

describe("R9-02 a node name or dialog name carrying a field value never reaches the diff", () => {
  it("diffSince hides a textbox whose name and value are the code", async () => {
    let nodes: any[] = [node(1, "button", "Save")];
    const layer = new ReadLayer((m: string, p?: any) => ax(nodes)(m, p), { origin: () => "https://shop.test", url: () => "https://shop.test/" });
    await layer.snapshot();
    nodes = [node(1, "button", "Save"), node(2, "textbox", "482913", "482913"), node(3, "dialog", "Code 482913 sent"), node(4, "button", "Use 482913")];
    const diff = await layer.diffSince();
    expect(diff).toBeTruthy();
    expect(diff).not.toContain("482913");
    expect(layer.fenced((layer as any).last)).not.toContain("482913");
  });
  it("a code-shaped name with no value on a field is hidden too", async () => {
    let nodes: any[] = [node(1, "button", "Save")];
    const layer = new ReadLayer((m: string, p?: any) => ax(nodes)(m, p), { origin: () => "https://shop.test", url: () => "https://shop.test/" });
    await layer.snapshot();
    nodes = [node(1, "button", "Save"), node(2, "textbox", "482913")];
    expect(await layer.diffSince()).not.toContain("482913");
  });
  it("formatDiff redacts the secrets it is handed, whatever node they sit in", () => {
    const n = (name: string) => ({ key: name, ref: "e1", backendNodeId: 1, frameLoader: "F", role: "button", name, interactive: true, ordinal: 0 }) as any;
    const out = formatDiff({ url: "u", nodes: [], dialogs: [] }, { url: "u", nodes: [n("pay 482913")], dialogs: ["x 482913"] }, "https://a.test", ["482913"]);
    expect(out).not.toContain("482913");
  });
});

// A page fake, enough for DESCRIBE_TARGET_SOURCE.
describe("R9-04 every exported attribute is scrubbed", () => {
  const run = (build: () => { target: any }) => {
    const g = globalThis as any; const saved = { document: g.document, getComputedStyle: g.getComputedStyle };
    const doc: any = {}; g.document = doc; g.getComputedStyle = () => ({ visibility: "visible" });
    try {
      const { target } = build();
      target.ownerDocument = doc;
      return JSON.parse((domFunction(`return (${DESCRIBE_TARGET_SOURCE});`)() as () => string).call(target));
    } finally { g.document = saved.document; g.getComputedStyle = saved.getComputedStyle; }
  };
  const field = (value: string) => ({ nodeType: 1, tagName: "INPUT", type: "text", name: "q", id: "q", value, isContentEditable: false, checked: undefined, getAttribute: () => null, getBoundingClientRect: () => ({ width: 5, height: 5 }) });
  const make = (opts: { href?: string; action?: string; formaction?: string; role?: string }) => {
    const input = field("482913");
    const form: any = { action: opts.action ?? "https://x.test/save", method: "post", enctype: "", target: "", id: "f", getAttribute: () => null, querySelectorAll: () => [input], elements: [input] };
    const target: any = {
      nodeType: 1, tagName: "BUTTON", type: "submit", name: "", value: "", isContentEditable: false, innerText: "Save", textContent: "Save", form,
      href: opts.href ?? "", formAction: opts.formaction ?? form.action, formMethod: "post", formEnctype: "", formTarget: "", formNoValidate: false,
      getRootNode: () => ({}), matches: () => false, querySelector: () => null, closest: () => null, hasAttribute: (k: string) => k === "formaction" && !!opts.formaction,
      getAttribute: (k: string) => (k === "href" ? (opts.href ?? null) : k === "role" ? (opts.role ?? null) : null),
    };
    return { target };
  };
  it("form.action with the code in its query", () => {
    const out = run(() => make({ action: "https://x.test/save?code=482913" }));
    expect(JSON.stringify(out.display)).not.toContain("482913");
  });
  it("a link href, a formaction and a role carrying the code", () => {
    const out = run(() => make({ href: "/go?t=482913", formaction: "https://x.test/p?c=482913", role: "482913" }));
    expect(JSON.stringify(out.display)).not.toContain("482913");
  });
  it("a code-shaped path segment in the action is scrubbed even with no field holding it", () => {
    const out = run(() => make({ action: "https://x.test/save/482914/confirm" }));
    expect(JSON.stringify(out.display)).not.toContain("482914");
  });
  it("Opus gate: a live value copied into the button text or label with an invisible mark or separators never reaches the card", () => {
    const out = run(() => {
      const built = make({});
      built.target.innerText = built.target.textContent = "Use 482\u034F913";
      built.target.getAttribute = (k: string) => (k === "aria-label" ? "Code 48 29 13" : null);
      return built;
    });
    const shown = JSON.stringify(out.display);
    expect(shown).not.toMatch(/482.?913/u);
    expect(shown).not.toContain("48 29 13");
  });
  it("the raw destination stays available to the executor, privately", () => {
    const out = run(() => make({ href: "/go?t=482913" }));
    expect(out.priv.href).toBe("/go?t=482913");
  });
});

const DOC: ExtensionDocument = { profileId: "p", tabId: 1, frameId: "frame", navigationEpoch: 1, origin: "https://example.test", url: "https://example.test/" };
type Harness = { active?: number; describe: any; facts: (n: number) => any; closedTree?: any; presenceObject?: string | null; presenceBackend?: number; steps?: (hooks: any, calls: string[]) => Promise<void> };
function build(h: Harness) {
  const calls: string[] = []; let factCalls = 0; const box = { describe: h.describe, active: h.active ?? 12 };
  const executor = new BrowserExtensionExecutor({
    collectFacts: async (_i: unknown, _t: unknown, operation: string) => ({ operation, tag: "button", role: "button", name: "Send", ...h.facts(factCalls++) }) as never,
    authorize: () => true, access: async () => true, admit: async () => true,
    createEngine: hooks => ({
      resolveTarget: async () => ({ backendNodeId: 12, document: { ...DOC } }), resolveTab: async () => ({ ...DOC }), event() {}, async close() {},
      async call() { await h.steps!(hooks, calls); return { content: [] }; },
    }),
    transport: {
      document: async () => ({ ...DOC }),
      send: async (method, params) => {
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame", loaderId: "L" } } };
        if (method === "Page.createIsolatedWorld") return { executionContextId: params.worldName === "murage-presence-v1" ? 8 : 7 };
        if (method === "Runtime.evaluate") {
          const expression = String(params.expression);
          if (expression.includes("__muragePresence")) return h.presenceObject ? { result: { type: "object", objectId: h.presenceObject } } : { result: { type: "object", subtype: "null", value: null } };
          return expression.includes("__murageGuard()") ? { result: { type: "boolean", value: false } } : params.returnByValue === false ? { result: { objectId: "node" } } : { result: { value: 0 } };
        }
        if (method === "DOM.getDocument") return { root: h.closedTree ?? { nodeType: 9, children: [] } };
        if (method === "DOM.describeNode") return { node: { backendNodeId: params.objectId === h.presenceObject ? (h.presenceBackend ?? 12) : box.active, nodeName: "BUTTON" } };
        if (method === "DOM.resolveNode") return { object: { objectId: "node" } };
        if (method === "Runtime.callFunctionOn") return { result: { value: params.functionDeclaration === DESCRIBE_TARGET_SOURCE ? JSON.stringify(box.describe) : true } };
        return {};
      },
    },
  });
  return { executor, calls, box };
}
const button = (values: string[], extra: any = {}) => ({ display: { tag: "BUTTON", text: "Send" }, bound: { tag: "BUTTON", hidden: [] }, values, editable: false, priv: { href: null, skip: [-1, -1] }, ...extra });

describe("R9-01 the recipients are the ones scanned at admission", () => {
  it("a recipient chip changed while approval is pending cancels both halves of the click", async () => {
    const h = build({
      describe: button(["x"]),
      // Scan 0 is the pre-admission floor check (Ana); every later scan sees Mallory.
      facts: n => ({ recipients: [n === 0 ? "ana@example.com" : "mallory@evil.example"], recipientScanFailed: false }),
      steps: async (hooks, calls) => {
        for (const type of ["mousePressed", "mouseReleased"]) { await hooks.beforeCommand({ ...DOC }, "Input.dispatchMouseEvent", { type, x: 1, y: 1, button: "left" }); calls.push(type); }
      },
    });
    await expect(h.executor.call("agent_browser_click", { selector: "#b" })).rejects.toThrow(/recipients changed/);
    expect(h.calls).toEqual([]);
  });
  it("unchanged recipients still let the click through", async () => {
    const h = build({
      describe: button(["x"]), facts: () => ({ recipients: ["ana@example.com"], recipientScanFailed: false }),
      steps: async (hooks, calls) => { for (const type of ["mousePressed", "mouseReleased"]) { await hooks.beforeCommand({ ...DOC }, "Input.dispatchMouseEvent", { type, x: 1, y: 1, button: "left" }); calls.push(type); } },
    });
    await h.executor.call("agent_browser_click", { selector: "#b" });
    expect(h.calls).toEqual(["mousePressed", "mouseReleased"]);
  });
});

describe("R9-10 mouse activations are always fully bound", () => {
  const editableContainer = (values: string[]) => ({ display: { tag: "DIV", text: "" }, bound: { tag: "DIV", hidden: [] }, values, editable: true, priv: { href: null, skip: [-1, -1] } });
  it("a clickable container with an editable descendant: another value changing on mousedown cancels the mouseup", async () => {
    let h!: ReturnType<typeof build>;
    h = build({
      describe: editableContainer(["ana@example.com", "note"]), facts: () => ({ recipients: ["ana@example.com"], recipientScanFailed: false }),
      steps: async (hooks, calls) => {
        for (const type of ["mousePressed", "mouseReleased"]) {
          await hooks.beforeCommand({ ...DOC }, "Input.dispatchMouseEvent", { type, x: 1, y: 1, button: "left" }); calls.push(type);
          if (type === "mousePressed") h.box.describe = editableContainer(["ana@example.com", "CHANGED"]);
        }
      },
    });
    await expect(h.executor.call("agent_browser_click", { selector: "#b" })).rejects.toThrow(/changed/);
    expect(h.calls).toEqual(["mousePressed"]);
  });
  it("a key press that types into the edited field itself is still allowed, a change to another field is not", async () => {
    const typing = (self: string, other: string) => ({ display: { tag: "INPUT", text: "" }, bound: { tag: "INPUT", hidden: [] }, values: [other, self, self], editable: true, priv: { href: null, skip: [1, 2] } });
    for (const [other, expected] of [["note", ["keyDown", "keyUp"]], ["SWAPPED", ["keyDown"]]] as const) {
      let h!: ReturnType<typeof build>;
      h = build({
        describe: typing("a", "note"), facts: () => ({ recipients: ["ana@example.com"], recipientScanFailed: false }),
        steps: async (hooks, calls) => {
          for (const type of ["keyDown", "keyUp"]) {
            await hooks.beforeCommand({ ...DOC }, "Input.dispatchKeyEvent", { type, key: "Enter" }); calls.push(type);
            if (type === "keyDown") h.box.describe = typing("ab", other);
          }
        },
      });
      await h.executor.call("agent_browser_press", { key: "Enter" }).catch(() => undefined);
      expect(h.calls).toEqual(expected);
    }
  });
});

const presenceTree = (backendNodeId: number) => ({ nodeType: 9, children: [{ nodeType: 1, nodeName: "MURAGE-PRESENCE", localName: "murage-presence", backendNodeId, attributes: ["data-murage-presence", ""], children: [],
  shadowRoots: [{ shadowRootType: "closed", nodeType: 11, children: [{ nodeType: 1, nodeName: "DIV", children: [{ nodeType: 3, nodeValue: "482913" }] }] }] }] });
describe("R9-05 only the overlay the extension itself built may hold a closed root", () => {
  it("a page-made look-alike (no overlay in the extension's own world) is refused", async () => {
    const h = build({ describe: button([]), facts: () => ({}), closedTree: presenceTree(5), presenceObject: null });
    expect(await h.executor.protectedDocument({ ...DOC })).toBe(true);
  });
  it("a look-alike while a genuine overlay exists elsewhere is refused", async () => {
    const h = build({ describe: button([]), facts: () => ({}), closedTree: presenceTree(6), presenceObject: "host", presenceBackend: 5 });
    expect(await h.executor.protectedDocument({ ...DOC })).toBe(true);
  });
  it("the genuine overlay, known by its identity, is let through", async () => {
    const h = build({ describe: button([]), facts: () => ({}), closedTree: presenceTree(5), presenceObject: "host", presenceBackend: 5 });
    expect(await h.executor.protectedDocument({ ...DOC })).toBe(false);
  });
});

describe("R9-07 one final exhaustion flag", () => {
  it("13,000 empty descendants before the agreement sentence inside a Continue button: facts are incomplete", () => {
    class E {
      nodeType = 1; tagName: string; localName: string; children: any[] = []; childNodes: any[] = []; labels: any[] = []; id = ""; name = ""; parentNode: any = null; parentElement: any = null; ownerDocument: any;
      constructor(tag: string, public attrs: Record<string, string> = {}) { this.tagName = tag.toUpperCase(); this.localName = tag; }
      getAttribute(k: string) { return this.attrs[k] ?? null; } hasAttribute(k: string) { return k in this.attrs; }
      matches() { return false; } getRootNode() { return D; } closest() { return null; } querySelector() { return null; }
      querySelectorAll(sel: string) { const out: any[] = []; const walk = (n: any) => { for (const e of n.children) { if (sel === "*") out.push(e); walk(e); } }; walk(this); return out; }
      getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 30, width: 100, height: 30 }; }
      contains(e: any): boolean { return e === this || this.children.some(c => c.contains(e)); }
      append(n: any) { n.parentNode = this; n.parentElement = this; this.childNodes.push(n); if (n.nodeType === 1) this.children.push(n); }
    }
    const D: any = new E("html"); D.nodeType = 9; D.title = "Notes"; D.location = { hostname: "example.test", pathname: "/" }; D.baseURI = "https://example.test/";
    const body = new E("body"); D.append(body); D.body = body; D.documentElement = body;
    const btn: any = new E("button", { "aria-label": "Continue" }); btn.type = "button"; body.append(btn); btn.ownerDocument = D; D.elementFromPoint = () => btn;
    for (let i = 0; i < 13000; i++) btn.append(new E("span"));
    btn.append({ nodeType: 3, nodeValue: "By clicking Continue you agree to the terms." });
    body.append({ nodeType: 3, nodeValue: "Neutral text ".repeat(50) });
    const g = globalThis as any; const saved = { document: g.document, location: g.location, window: g.window, getComputedStyle: g.getComputedStyle };
    g.document = D; g.location = D.location; g.window = { innerWidth: 1000, innerHeight: 800 };
    g.getComputedStyle = () => ({ display: "block", visibility: "visible", opacity: "1", webkitTextSecurity: "none" });
    try {
      const raw = (domFunction(`return (${COLLECT_FLOOR_FACTS_SOURCE})`)() as any).call(btn, { operation: "click", name: "Continue", selectors: { consent: [], captcha: [], payment: [], paymentRequest: [], challenge: [] }, currency: { source: "[$][0-9]", flags: "" } });
      expect(raw.nearFailed).toBe(true);
      expect(classifyFloor({ operation: "click", tag: raw.tag, type: raw.type, name: raw.fallbackName, submits: raw.submits, snippets: raw.snippets, factsFailed: raw.valuesCapped || raw.fieldsCapped || raw.nearFailed || raw.shadowNoForm }).floor).not.toBeNull();
    } finally { g.document = saved.document; g.location = saved.location; g.window = saved.window; g.getComputedStyle = saved.getComputedStyle; }
  });
});

describe("R9-08 incomplete facts are the owner's before any safe consent verdict", () => {
  it.each(["Reject all", "Settings", "Save preferences", "Manage preferences", "Necessary only"])("%s with factsFailed hands over", name => {
    const verdict = classifyFloor({ operation: "click", tag: "button", role: "button", name, text: name, fallbackName: name, factsFailed: true, signatures: { consentManager: true } } as never);
    expect(verdict.floor).not.toBeNull();
  });
  it("complete facts still let Reject all through", () => {
    const verdict = classifyFloor({ operation: "click", tag: "button", role: "button", name: "Reject all", text: "Reject all", fallbackName: "Reject all", signatures: { consentManager: true } } as never);
    expect(verdict.floor).toBeNull();
  });
});

describe("R9-09 the extension is fenced before the new state is persisted", () => {
  const A = "https://fixture.test";
  const cleanup: string[] = [];
  afterEach(async () => { for (const directory of cleanup.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });
  it("at the moment of the bind, the state file does not yet hold the new setting", async () => {
    const directory = await fs.mkdtemp(path.resolve(".corefix10-")); cleanup.push(directory); await fs.chmod(directory, 0o700);
    const stateFile = path.join(directory, "state.json");
    const seen: { operation: string; saved: string | null }[] = [];
    const bindings = new Map<string, any>();
    const broker = {
      profiles: () => [{ version: 1, type: "hello", profileId: "profile", browser: "chromium", extensionVersion: "1.0", capabilities: ["scoped_cdp", "durable_stop", "explicit_share", "manual_pause", "engine_cdp_v1", "unexpected_input_pause", "ordered_requests_v1", "lifecycle_v1"] }],
      async request(_p: string, command: any) {
        let saved: string | null = null;
        try { saved = JSON.parse(await fs.readFile(stateFile, "utf8")).bindings?.[0]?.sites?.[A] ?? null; } catch { saved = null; }
        seen.push({ operation: command.operation, saved });
        let b = bindings.get(command.bindingId);
        if (!b) { b = { generation: 1, state: "active", tabs: [{ tabId: 1, navigationEpoch: 1, origin: A, url: A + "/" }] }; bindings.set(command.bindingId, b); }
        return { version: 1, type: "response", id: command.id, bindingId: command.bindingId, generation: command.generation, result: structuredClone(b) } as never;
      },
    };
    const options = { broker, workspaceId: "workspace", stateFile, askSite: async () => "ask" as const, askAction: async () => true, approvalMode: () => "task" as const };
    const service = await createBrowserExtensionService(options as never);
    await service.ensureBinding({ botId: "bot", threadId: "thread", profileId: "profile" });
    seen.length = 0;
    await service.settingsChanged("bot", { origin: A, rule: "never" });
    const bind = seen.find(item => item.operation === "bind");
    expect(bind, JSON.stringify(seen)).toBeTruthy();
    expect(bind!.saved).not.toBe("never");
    expect(JSON.parse(await fs.readFile(stateFile, "utf8")).bindings[0].sites[A]).toBe("never");
  });
});

// ---- Findings of the blind review of round 9 (R10-01 to R10-09) ----
describe("R10-08 brackets or a plus never exempt a code-length number", () => {
  it.each(["(482913)", "+(41111111)", "+482913", "(1234)", "+(078)05-1120"])("%j is a secret", value => {
    expect(looksLikeSecretValue(value)).toBe(true);
    expect(cleanRecipients([value])).toEqual([]);
  });
  it.each(["+1 555 123 4567", "(555) 123-4567", "+442071234567"])("%j is still a phone number", value => {
    expect(cleanRecipients([value])).toEqual([value]);
  });
});

describe("R10-06 a copied value is found after normalisation", () => {
  it("a button named Use 482<U+034F>913 beside a field holding 482913 is hidden", async () => {
    let nodes: any[] = [node(1, "button", "Save")];
    const layer = new ReadLayer((m: string, p?: any) => ax(nodes)(m, p), { origin: () => "https://shop.test", url: () => "https://shop.test/" });
    await layer.snapshot();
    nodes = [node(1, "button", "Save"), node(2, "textbox", "Notes", "482913"), node(3, "button", "Use 482\u034f913"), node(4, "dialog", "Sent \uff14\uff18\uff12\uff19\uff11\uff13")];
    const diff = await layer.diffSince();
    expect(diff).toBeTruthy();
    // The random fence identifier can contain these digits without disclosing page data.
    expect(diff?.replace(/id=[a-f0-9]+/g, "id=opaque")).not.toMatch(/482|913|\uff14/);
    expect(layer.fenced((layer as any).last)).not.toMatch(/482\u034f913|\uff14\uff18/);
  });
});

describe("R10-05 and R10-04 URLs", () => {
  const build2 = (href: string) => {
    const g = globalThis as any; const saved = { document: g.document, getComputedStyle: g.getComputedStyle };
    const doc: any = {}; g.document = doc; g.getComputedStyle = () => ({ visibility: "visible" });
    try {
      const input = { nodeType: 1, tagName: "INPUT", type: "text", name: "q", id: "q", value: "482913", isContentEditable: false, getAttribute: () => null, getBoundingClientRect: () => ({ width: 5, height: 5 }) };
      const form: any = { action: "https://x.test/save", method: "post", enctype: "", target: "", id: "f", getAttribute: () => null, querySelectorAll: () => [input], elements: [input] };
      const target: any = { nodeType: 1, tagName: "A", ownerDocument: doc, type: "", name: "", value: "", isContentEditable: false, innerText: "Next", textContent: "Next", form, href, formAction: "", formMethod: "", formEnctype: "", formTarget: "", formNoValidate: false,
        getRootNode: () => ({}), matches: () => false, querySelector: () => null, closest: () => form, hasAttribute: () => false, getAttribute: (k: string) => (k === "href" ? href : null) };
      return JSON.parse((domFunction(`return (${DESCRIBE_TARGET_SOURCE});`)() as () => string).call(target));
    } finally { g.document = saved.document; g.getComputedStyle = saved.getComputedStyle; }
  };
  it("a percent-encoded live value with a suffix does not survive", () => {
    const out = build2("/next?x=%34%38%32%39%31%33_suffix");
    expect(JSON.stringify(out.display)).not.toMatch(/%34%38|482913/);
  });
  it("a path carrying the code is redacted for the checker, and on the card", () => {
    expect(redactUrl("https://shop.test/continue/482913?token=abc")).not.toContain("482913");
    expect(redactSecretUrl("https://shop.test/continue/482913/ok?a=1")).toBe("https://shop.test/continue/~/ok?a=1");
    expect(redactSecretUrl("https://shop.test/a/%34%38%32%39%31%33")).not.toContain("%34");
    expect(redactSecretUrl("https://shop.test/orders/list?page=2")).toBe("https://shop.test/orders/list?page=2");
  });
});

describe("R10-02 the key-up of an activation key reaches only the approved focus", () => {
  it("keydown moves focus to another button: the keyup never reaches the page", async () => {
    let h!: ReturnType<typeof build>;
    h = build({
      describe: button(["x"]), facts: () => ({ recipients: ["ana@example.com"], recipientScanFailed: false }),
      steps: async (hooks, calls) => {
        for (const type of ["keyDown", "keyUp"]) {
          await hooks.beforeCommand({ ...DOC }, "Input.dispatchKeyEvent", { type, key: " " }); calls.push(type);
          if (type === "keyDown") h.box.active = 99;
        }
      },
    });
    await expect(h.executor.call("agent_browser_press", { key: " " })).rejects.toThrow(/focus/i);
    expect(h.calls).toEqual(["keyDown"]);
  });
});

describe("R10-07 text cut at the character limit inside a control's own name is incomplete too", () => {
  it("long neutral text before the agreement sentence in a Continue button", () => {
    class E {
      nodeType = 1; tagName: string; localName: string; children: any[] = []; childNodes: any[] = []; labels: any[] = []; id = ""; name = ""; parentNode: any = null; parentElement: any = null; ownerDocument: any;
      constructor(tag: string, public attrs: Record<string, string> = {}) { this.tagName = tag.toUpperCase(); this.localName = tag; }
      getAttribute(k: string) { return this.attrs[k] ?? null; } hasAttribute(k: string) { return k in this.attrs; }
      matches() { return false; } getRootNode() { return D; } closest() { return null; } querySelector() { return null; }
      querySelectorAll() { return []; }
      getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 30, width: 100, height: 30 }; }
      contains(e: any): boolean { return e === this || this.children.some(c => c.contains(e)); }
      append(n: any) { n.parentNode = this; n.parentElement = this; this.childNodes.push(n); if (n.nodeType === 1) this.children.push(n); }
    }
    const D: any = new E("html"); D.nodeType = 9; D.title = "Notes"; D.location = { hostname: "example.test", pathname: "/" }; D.baseURI = "https://example.test/";
    const body = new E("body"); D.append(body); D.body = body; D.documentElement = body;
    const btn: any = new E("button"); btn.type = "button"; body.append(btn); btn.ownerDocument = D; D.elementFromPoint = () => btn;
    btn.append({ nodeType: 3, nodeValue: "Neutral words here. ".repeat(80) });
    btn.append({ nodeType: 3, nodeValue: "By clicking Continue you agree to the terms." });
    const g = globalThis as any; const saved = { document: g.document, location: g.location, window: g.window, getComputedStyle: g.getComputedStyle };
    g.document = D; g.location = D.location; g.window = { innerWidth: 1000, innerHeight: 800 };
    g.getComputedStyle = () => ({ display: "block", visibility: "visible", opacity: "1", webkitTextSecurity: "none" });
    try {
      const raw = (domFunction(`return (${COLLECT_FLOOR_FACTS_SOURCE})`)() as any).call(btn, { operation: "click", name: "Continue", selectors: { consent: [], captcha: [], payment: [], paymentRequest: [], challenge: [] }, currency: { source: "[$][0-9]", flags: "" } });
      expect(raw.nearFailed).toBe(true);
    } finally { g.document = saved.document; g.location = saved.location; g.window = saved.window; g.getComputedStyle = saved.getComputedStyle; }
  });
});

// A compact element fixture for native child traversal and recipient attributes.
class N2 {
  nodeType = 1;
  parentNode: N2 | null = null; host = null; children: N2[] = []; shadowRoot = null; childNodes: { nodeType: number; textContent: string }[] = [];
  id = ""; name = ""; value = ""; type = ""; labels: { textContent: string }[] = []; ownerDocument: unknown = {}; form: unknown = null; textContent = ""; elements?: N2[];
  constructor(public localName: string, public attrs: Record<string, string> = {}) { this.id = attrs.id ?? ""; this.name = attrs.name ?? ""; this.type = attrs.type ?? ""; this.value = attrs.value ?? ""; }
  getAttribute(k: string) { return k in this.attrs ? this.attrs[k] : null; }
  add(...kids: N2[]) { for (const k of kids) { k.parentNode = this; this.children.push(k); } return this; }
  contains(n: N2 | null): boolean { for (let c: N2 | null = n; c; c = c.parentNode) if (c === this) return true; return false; }
}
describe("R10-01 controls tied to a form by id are part of its payload and its recipients", () => {
  it("a bcc input outside the form is a recipient", () => {
    const body = new N2("body"); const form = new N2("form", { id: "f" }); const send = new N2("button", { "aria-label": "Send" });
    const to = new N2("input", { type: "email", name: "to", value: "ana@example.com" });
    const bcc = new N2("input", { type: "email", name: "bcc", form: "f", value: "mallory@evil.example" });
    form.add(to, send); body.add(form, bcc); form.elements = [to, bcc];
    send.ownerDocument = { body, documentElement: body };
    const g = globalThis as any; const before = g.getComputedStyle; g.getComputedStyle = () => ({ webkitTextSecurity: "none" });
    try {
      const result = (domFunction(`return (${COLLECT_RECIPIENTS_SOURCE});`)() as () => { recipients: string[] }).call(send);
      expect(result.recipients).toContain("mallory@evil.example");
    } finally { g.getComputedStyle = before; }
  });
  it("the description binds a form-associated field that sits outside the form", () => {
    const g = globalThis as any; const saved = { document: g.document, getComputedStyle: g.getComputedStyle };
    const doc: any = {}; g.document = doc; g.getComputedStyle = () => ({ visibility: "visible" });
    try {
      const box = { width: 5, height: 5 };
      const inside = { nodeType: 1, tagName: "INPUT", type: "text", attrs: { name: "to", id: "to" }, name: "to", id: "to", value: "ana@example.com", isContentEditable: false, getAttribute: () => null, getBoundingClientRect: () => box, matches: () => true };
      const outside = { nodeType: 1, tagName: "INPUT", type: "text", attrs: { name: "bcc", id: "bcc" }, name: "bcc", id: "bcc", value: "mallory@evil.example", isContentEditable: false, getAttribute: () => null, getBoundingClientRect: () => box, matches: () => true };
      const form: any = { action: "https://x.test/s", method: "post", enctype: "", target: "", id: "f", getAttribute: () => null, querySelectorAll: () => [inside], elements: [inside, outside] };
      const target: any = { nodeType: 1, tagName: "BUTTON", type: "submit", name: "", value: "", isContentEditable: false, innerText: "Send", textContent: "Send", form, ownerDocument: doc, href: "", formAction: form.action, formMethod: "post", formEnctype: "", formTarget: "", formNoValidate: false,
        getRootNode: () => ({}), matches: () => false, querySelector: () => null, closest: () => null, hasAttribute: () => false, getAttribute: () => null };
      const out = JSON.parse((domFunction(`return (${DESCRIBE_TARGET_SOURCE});`)() as () => string).call(target));
      expect(out.values).toContain("mallory@evil.example");
      expect(out.display.fieldNames).toContain("bcc");
    } finally { g.document = saved.document; g.getComputedStyle = saved.getComputedStyle; }
  });
});

describe("R10-03 every restrictive route fences the extension before the file is written", () => {
  const A = "https://fixture.test";
  const cleanup: string[] = [];
  afterEach(async () => { for (const directory of cleanup.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });
  async function rig() {
    const directory = await fs.mkdtemp(path.resolve(".corefix10-")); cleanup.push(directory); await fs.chmod(directory, 0o700);
    const stateFile = path.join(directory, "state.json");
    const seen: { operation: string; saved: string | null; savedState: string | null }[] = [];
    const bindings = new Map<string, any>();
    const broker = {
      profiles: () => [{ version: 1, type: "hello", profileId: "profile", browser: "chromium", extensionVersion: "1.0", capabilities: ["scoped_cdp", "durable_stop", "explicit_share", "manual_pause", "engine_cdp_v1", "unexpected_input_pause", "ordered_requests_v1", "lifecycle_v1"] }],
      async request(_p: string, command: any) {
        let saved: string | null = null; let savedState: string | null = null;
        try { const file = JSON.parse(await fs.readFile(stateFile, "utf8")); saved = file.bindings?.[0]?.sites?.[A] ?? null; savedState = file.bindings?.[0]?.state ?? null; } catch { saved = null; }
        seen.push({ operation: command.operation, saved, savedState });
        if (command.operation === "pause" || command.operation === "stop") { const was = bindings.get(command.bindingId); if (was) { was.state = command.operation === "pause" ? "paused" : "stopped"; was.generation += 1; } }
        let b = bindings.get(command.bindingId);
        if (!b) { b = { generation: 1, state: "active", tabs: [{ tabId: 1, navigationEpoch: 1, origin: A, url: A + "/" }] }; bindings.set(command.bindingId, b); }
        return { version: 1, type: "response", id: command.id, bindingId: command.bindingId, generation: command.generation, result: structuredClone(b) } as never;
      },
    };
    const service = await createBrowserExtensionService({ broker, workspaceId: "workspace", stateFile, askSite: async () => "ask" as const, askAction: async () => true, approvalMode: () => "task" as const } as never);
    const binding = await service.ensureBinding({ botId: "bot", threadId: "thread", profileId: "profile" });
    await service.setSiteAccess(binding.bindingId, A, "allow");
    seen.length = 0;
    return { service, id: binding.bindingId, seen, stateFile, directory };
  }
  it("revoke: at the bind the file still holds the old rule", async () => {
    const r = await rig();
    await r.service.revoke(r.id, A);
    const bind = r.seen.find(item => item.operation === "bind");
    expect(bind, JSON.stringify(r.seen)).toBeTruthy();
    expect(bind!.saved).toBe("allow");
  });
  it("lowering a site to Never through the direct route: the same order", async () => {
    const r = await rig();
    await r.service.setSiteAccess(r.id, A, "never");
    const bind = r.seen.find(item => item.operation === "bind");
    expect(bind, JSON.stringify(r.seen)).toBeTruthy();
    expect(bind!.saved).toBe("allow");
  });
  it("pause: at the pause request the file still holds the old state", async () => {
    const r = await rig();
    await r.service.pause(r.id);
    const pause = r.seen.find(item => item.operation === "pause");
    expect(pause, JSON.stringify(r.seen)).toBeTruthy();
    expect(pause!.savedState, JSON.stringify(r.seen)).toBe("active");
  });
  it("stop: at the stop request the file still holds the old state", async () => {
    const r = await rig();
    await r.service.stop(r.id);
    const stop = r.seen.find(item => item.operation === "stop");
    expect(stop, JSON.stringify(r.seen)).toBeTruthy();
    expect(stop!.savedState, JSON.stringify(r.seen)).toBe("active");
  });
  // A write that cannot land must not delay or undo the fence: the extension has already been told.
  const breakWrites = async (r: Awaited<ReturnType<typeof rig>>) => { await fs.chmod(r.directory, 0o500); };
  it("pause: a failed write still leaves the extension fenced", async () => {
    const r = await rig(); await breakWrites(r);
    try { await r.service.pause(r.id).catch(() => {}); } finally { await fs.chmod(r.directory, 0o700); }
    expect(r.seen.some(item => item.operation === "pause")).toBe(true);
    expect(r.service.status().bindings.find(b => b.bindingId === r.id)?.state).toBe("paused");
  });
  it("stop: a failed write still leaves the extension fenced", async () => {
    const r = await rig(); await breakWrites(r);
    try { await r.service.stop(r.id).catch(() => {}); } finally { await fs.chmod(r.directory, 0o700); }
    expect(r.seen.some(item => item.operation === "stop")).toBe(true);
    expect(r.service.status().bindings.find(b => b.bindingId === r.id)?.state).toBe("stopped");
  });
});
