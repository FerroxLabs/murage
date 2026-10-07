// SPDX-License-Identifier: AGPL-3.0-or-later
// Red-first tests (lane 0162-chromereal): the executor reviews the target and its form, never the whole page.
import { describe, expect, it } from "vitest";
import { BrowserExtensionExecutor, type ExtensionDocument, type ExtensionAction } from "./browser-extension-executor.ts";
import { DESCRIBE_TARGET_SOURCE } from "./browser-extension-page-scripts.ts";

function fixture(opts: { protectedPage?: boolean; childFrames?: boolean; describe?: unknown } = {}) {
  let current: ExtensionDocument = { profileId: "p", tabId: 1, frameId: "frame", navigationEpoch: 1, origin: "https://example.test", url: "https://example.test/" };
  const calls: { method: string; params: Record<string, unknown> }[] = []; const decisions: ExtensionAction[] = [];
  let describeValue: unknown = opts.describe ?? { display: { tag: "BUTTON", text: "Post", fieldCount: 2, fieldNames: ["title", "body"] }, bound: { hidden: [["op", "save"]] } };
  const state = { protectedPage: !!opts.protectedPage, dialog: undefined as undefined | string };
  const executor = new BrowserExtensionExecutor({ collectFacts: async (_io: unknown, _t: unknown, operation: string, extra?: { dialog?: unknown }) => ({ operation, ...(extra?.dialog ? { dialog: extra.dialog } : {}) }) as never,
    authorize: () => true, access: async () => true, admit: async action => { decisions.push(action); return true; },
    createEngine: hooks => ({
      resolveTarget: async () => ({ backendNodeId: 12, document: { ...current } }), resolveTab: async () => ({ ...current }), event() {}, async close() {},
      async call(name, args) {
        if (name === "agent_browser_open") { await hooks.beforeDestination(String(args.url), { ...current }); calls.push({ method: "Page.navigate", params: { url: args.url } }); state.protectedPage = false; return { content: [{ type: "text", text: "Navigated" }] }; }
        if (name === "agent_browser_snapshot") { await hooks.beforeCommand({ ...current }, "Accessibility.getFullAXTree", {}); calls.push({ method: "Accessibility.getFullAXTree", params: {} }); return { content: [{ type: "text", text: "tree" }] }; }
        if (name === "agent_browser_fill") { await hooks.beforeCommand({ ...current }, "Input.insertText", { text: args.text }); calls.push({ method: "Input.insertText", params: { text: args.text } }); return { content: [] }; }
        if (name === "agent_browser_press") { await hooks.beforeCommand({ ...current }, "Input.dispatchKeyEvent", { type: "keyDown", key: "Tab" }); calls.push({ method: "Input.dispatchKeyEvent", params: {} }); return { content: [] }; }
        if (name === "agent_browser_scroll") { await hooks.beforeCommand({ ...current }, "Input.dispatchMouseEvent", { type: "mouseWheel", x: 1, y: 1, deltaY: 100 }); calls.push({ method: "Input.dispatchMouseEvent", params: {} }); return { content: [] }; }
        if (name === "agent_browser_dialog") { await hooks.beforeCommand({ ...current }, "Page.handleJavaScriptDialog", { accept: true }); return { content: [] }; }
        return { content: [] };
      },
    }),
    transport: {
      document: async () => ({ ...current }),
      send: async (method, params) => {
        calls.push({ method, params });
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame", loaderId: "L" }, ...(opts.childFrames ? { childFrames: [{ frame: { id: "child" } }] } : {}) } };
        if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
        if (method === 'DOM.getDocument') return { root: { nodeType: 9, children: [] } };
        if (method === "DOM.getDocument") return { root: { nodeType: 9, children: [] } };
        if (method === "Runtime.evaluate") {
          if (String(params.expression).includes("__murageGuard()")) return { result: { type: "boolean", value: state.protectedPage } };
          if (params.returnByValue === false) return { result: { objectId: "node" } };
          return { result: { value: "Example" } };
        }
        if (method === "DOM.describeNode") return { node: { backendNodeId: 12, nodeName: "BUTTON" } };
        if (method === "DOM.resolveNode") return { object: { objectId: "node" } };
        if (method === "Runtime.callFunctionOn") return { result: { value: params.functionDeclaration === DESCRIBE_TARGET_SOURCE ? JSON.stringify(describeValue) : true } };
        return {};
      },
    },
  });
  return { executor, calls, decisions, state, setDescribe: (value: unknown) => { describeValue = value; }, admitHook: (fn: () => void) => { (executor as any).options.admit = async (a: ExtensionAction) => { decisions.push(a); fn(); return true; }; } };
}
const sent = (f: ReturnType<typeof fixture>, prefix: string) => f.calls.filter(c => c.method.startsWith(prefix));

describe("Round 9 (R8-01, reverses Fable H1): any element can host a closed root, so the guard reads the browser's own tree", () => {
  it("reads the pierced tree for an action, and again before the input", async () => {
    const f = fixture(); await f.executor.call("agent_browser_snapshot", {}); await f.executor.call("agent_browser_fill", { selector: "textarea", text: "x" });
    expect(sent(f, "DOM.getDocument").length).toBeGreaterThan(0);
  });
});
describe("Fable H3 and Astra 9: frames and closed shadow roots do not refuse the page", () => {
  it("snapshot works on a page with child frames", async () => {
    const f = fixture({ childFrames: true }); await expect(f.executor.call("agent_browser_snapshot", {})).resolves.toBeDefined();
  });
  it("opening another URL is still possible from a page the owner must use directly", async () => {
    const f = fixture({ protectedPage: true });
    await expect(f.executor.call("agent_browser_snapshot", {})).rejects.toThrow("take over");
    await expect(f.executor.call("agent_browser_open", { url: "https://example.test/next" })).resolves.toBeDefined();
    expect(sent(f, "Page.navigate")).toHaveLength(1);
  });
  it("a target inside a frame or a closed root is refused in plain words", async () => {
    for (const [said, expected] of [["MURAGE_FRAME", /embedded frame/], ["MURAGE_CLOSED_SHADOW", /protected page content/]] as const) {
      const f = fixture(); (f.executor as any).options.transport.send = async (method: string) => method === "Runtime.callFunctionOn" ? { exceptionDetails: { exception: { description: `Error: ${said}` } } } : method === "Page.getFrameTree" ? { frameTree: { frame: { id: "f" } } } : method === "Page.createIsolatedWorld" ? { executionContextId: 7 } : method === "DOM.getDocument" ? { root: { nodeType: 9, children: [] } } : method === "Runtime.evaluate" ? { result: { type: "boolean", value: false, objectId: "n" } } : method === "DOM.describeNode" ? { node: { backendNodeId: 12 } } : { object: { objectId: "n" } };
      await expect(f.executor.call("agent_browser_fill", { selector: "textarea", text: "x" })).rejects.toThrow(expected);
    }
  });
  it("focus inside an iframe is refused", async () => {
    const f = fixture(); const send = (f.executor as any).options.transport.send;
    (f.executor as any).options.transport.send = async (method: string, params: any, doc: any) => method === "DOM.describeNode" && params.objectId ? { node: { backendNodeId: 12, nodeName: "IFRAME" } } : send(method, params, doc);
    await expect(f.executor.call("agent_browser_press", { key: "Enter" })).rejects.toThrow(/embedded frame/);
    expect(sent(f, "Input.")).toHaveLength(0);
  });
});
describe("Fable H4 and Astra 12: a long text can be approved, and is reviewed as the page's target and form", () => {
  it("a 2,500 character body is approvable and shown whole", async () => {
    const f = fixture(); const body = "word ".repeat(500);
    await f.executor.call("agent_browser_fill", { selector: "textarea", text: body });
    expect(f.decisions[0].summary).toContain(body.trim()); expect(f.decisions[0].summary.length).toBeLessThan(12000);
  });
  it("describes fields by name and a count, and labels what the page wrote", async () => {
    const f = fixture(); await f.executor.call("agent_browser_fill", { selector: "textarea", text: "hi" });
    const summary = f.decisions[0].summary;
    expect(summary).toMatch(/From the page, written by the site and not by Murage/); expect(summary).toContain("2 fields in this form: title, body");
  });
  it("a page with fifty visible checkboxes no longer refuses a click", async () => {
    const f = fixture({ describe: { display: { tag: "A", fieldCount: 50, fieldNames: Array.from({ length: 12 }, (_, i) => `row${i}`) }, bound: {} } });
    await expect(f.executor.call("agent_browser_click", { selector: "a" })).resolves.toBeDefined();
  });
  it("refuses only beyond what can be reviewed", async () => {
    const f = fixture(); await expect(f.executor.call("agent_browser_fill", { selector: "textarea", text: "x".repeat(13000) })).rejects.toThrow(/too large to review/);
  });
  it("the push summary carries field names and a count, never typed text or values", async () => {
    const f = fixture(); await f.executor.call("agent_browser_fill", { selector: "textarea", text: "SECRET-BODY-TEXT" });
    const push = f.decisions[0].pushSummary!; expect(push).not.toContain("SECRET-BODY-TEXT"); expect(push).toContain("title, body"); expect(push).toContain("(2)");
  });
});
describe("Astra 4: the approval digest binds the effective submission", () => {
  it("a changed submitter, form action or hidden field changes the digest and stops the action", async () => {
    const f = fixture(); await f.executor.call("agent_browser_click", { selector: "button" }); const first = f.decisions[0].digest;
    const g = fixture({ describe: { display: { tag: "BUTTON", text: "Post", fieldCount: 2, fieldNames: ["title", "body"] }, bound: { hidden: [["op", "send"]] } } }); await g.executor.call("agent_browser_click", { selector: "button" });
    expect(g.decisions[0].digest).not.toBe(first);
    const h = fixture(); h.admitHook(() => h.setDescribe({ display: { tag: "BUTTON", text: "Post", fieldCount: 2, fieldNames: ["title", "body"] }, bound: { hidden: [["op", "send"]] } }));
    await expect(h.executor.call("agent_browser_click", { selector: "button" })).rejects.toThrow(/changed while waiting/);
    expect(sent(h, "Input.")).toHaveLength(0);
  });
  // The form's own action and method are read through the native HTMLFormElement accessors (dom.formProperty), so a
  // control named "action" or "method" cannot stand in for them.
  it("the page script reads the submitter's formaction, formmethod, name, value and the hidden fields", () => {
    for (const token of ["formAction", "formMethod", "formEnctype", "hidden", "submitter", "formProperty(form,'action')", "formProperty(form,'method')"]) expect(DESCRIBE_TARGET_SOURCE).toContain(token);
  });
});
describe("Fable M1: clipboard keys are refused before any card", () => {
  it("press Control+v, Meta+c and Shift+Insert never raise a card", async () => {
    for (const key of ["Control+v", "Meta+c", "Shift+Insert", "ControlOrMeta+a"]) { const f = fixture(); await expect(f.executor.call("agent_browser_press", { key })).rejects.toThrow(/Pasting, copying/); expect(f.decisions).toHaveLength(0); }
  });
});
describe("Fable M3 (partial): looking around is free", () => {
  it("scroll and Tab raise no card; Enter and the arrows still do", async () => {
    const f = fixture(); await f.executor.call("agent_browser_scroll", { direction: "down" }); await f.executor.call("agent_browser_press", { key: "Tab" });
    expect(f.decisions.every(d => d.mutation === false)).toBe(true);
    const g = fixture(); await g.executor.call("agent_browser_press", { key: "Enter" }); expect(g.decisions[0].mutation).toBe(true);
  });
});
describe("Fable L6: closing the session is not free", () => {
  it("close on a shared page needs approval", async () => {
    const f = fixture(); await f.executor.call("agent_browser_close", {}); expect(f.decisions[0].mutation).toBe(true);
  });
});
describe("Fable M4: a JavaScript dialog is answered only with the owner", () => {
  it("a confirm and an alert are each one gated step (T43), and nothing outside a tool call is answered", async () => {
    const f = fixture(); f.executor.event(1, 1, "Page.javascriptDialogOpening", { type: "confirm", message: "Delete everything?" });
    await f.executor.call("agent_browser_dialog" as never, {}).catch(() => {}); // not in the contract: refused before it runs
    const g = fixture(); g.executor.event(1, 1, "Page.javascriptDialogOpening", { type: "alert", message: "hi" });
    expect(g.decisions).toHaveLength(0);
    const answer = (h: ReturnType<typeof fixture>) => (h.executor as any).answerDialog({ profileId: "p", tabId: 1, frameId: "frame", navigationEpoch: 1, origin: "https://example.test", url: "https://example.test/" }, { accept: true });
    await expect(answer(f)).rejects.toThrow(/owner to answer/);
    (f.executor as any).executing = true; await answer(f);
    expect(f.decisions[0].summary).toContain("Delete everything?"); expect(f.decisions[0].summary).toMatch(/written by the site/); expect(f.decisions[0].mutation).toBe(true);
    await expect(answer(g)).rejects.toThrow(/owner to answer/); // an alert the owner opened is left alone too
    (g.executor as any).executing = true; await answer(g); expect(g.decisions).toHaveLength(1); expect(g.decisions[0].name).toBe("agent_browser_dialog_accept");
  });
});

describe("Vultr live bug 11: ref is accepted as a selector", () => {
  it("click with ref resolves the same element as @ref, after a snapshot", async () => {
    const f = fixture(); await f.executor.call("agent_browser_snapshot", {});
    await expect(f.executor.call("agent_browser_click", { ref: "e3" })).resolves.toBeDefined();
    expect(f.decisions.at(-1)!.arguments).toMatchObject({ selector: "@e3" }); expect(f.decisions.at(-1)!.arguments).not.toHaveProperty("ref");
  });
  it("still refuses an argument the tool does not take, by name", async () => {
    const f = fixture(); await expect(f.executor.call("agent_browser_click", { selector: "button", colour: "red" })).rejects.toThrow(/colour/);
  });
});
