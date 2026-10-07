// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { BrowserExtensionExecutor, type ExtensionDocument, type ExtensionAction } from "./browser-extension-executor.ts";

function fixture(extra: Record<string, unknown> = {}) {
  let current: ExtensionDocument = { profileId: "profile", tabId: 1, frameId: "frame", navigationEpoch: 1, origin: "https://example.test", url: "https://example.test/" };
  let active = true, protectedPage = false, siteAllowed = true, denyAfterNavigation=false;
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let docCount = 0;
  const decisions: ExtensionAction[] = [];
  let admit: (action: ExtensionAction) => Promise<boolean> = async action => { decisions.push(action); return true; };
  const executor = new BrowserExtensionExecutor({ ...extra, collectFacts: async (_io: unknown, _t: unknown, operation: string, extra?: { dialog?: unknown }) => ({ operation, ...(extra?.dialog ? { dialog: extra.dialog } : {}) }) as never,
    authorize: () => active,
    access: async () => active && siteAllowed,
    admit: action => admit(action),
    createEngine:hooks=>({
      resolveTarget:async()=>({backendNodeId:12,document:{...current}}),resolveTab:async()=>({...current}),event(){},async close(){},
      async call(name,args){
        if(name==='agent_browser_open'){await hooks.beforeDestination(String(args.url),{...current});calls.push({method:'Page.navigate',params:{url:args.url}});current={...current,navigationEpoch:current.navigationEpoch+1,url:String(args.url)};if(denyAfterNavigation)siteAllowed=false;return{content:[{type:'text',text:'Navigated'}]};}
        if(name==='agent_browser_snapshot'){await hooks.beforeCommand({...current},'Accessibility.getFullAXTree',{});calls.push({method:'Accessibility.getFullAXTree',params:{}});return{content:[{type:'text',text:'- button "Post" [ref=e1]'}]};}
        if(name==='agent_browser_fill'){await hooks.beforeCommand({...current},'Input.insertText',{text:args.text});calls.push({method:'Input.insertText',params:{text:args.text}});return{content:[]};}
        if(name==='agent_browser_dialog'){await hooks.beforeCommand({...current},'Page.handleJavaScriptDialog',{accept:args.accept===true});calls.push({method:'Page.handleJavaScriptDialog',params:{accept:args.accept===true}});return{content:[]};}
        if(name==='agent_browser_click'){await hooks.beforeCommand({...current},'Input.dispatchMouseEvent',{type:'mousePressed',x:20,y:30});calls.push({method:'Input.dispatchMouseEvent',params:{}});return{content:[]};}
        return{content:[]};
      }
    }),
    transport: {
      document: async () => { docCount++; return { ...current }; },
      send: async (method, params) => {
        calls.push({ method, params });
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame", loaderId: "L" } } };
        if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
        if (method === 'DOM.getDocument') return { root: { nodeType: 9, children: [] } };
        if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
        if (method === "Runtime.evaluate") {
          if (String(params.expression).includes("__murageGuard()")) return { result: { type: "boolean", value: protectedPage } };
          if (params.returnByValue === false) return { result: { objectId: "node" } };
          return { result: { value: "Example" } };
        }
        if (method === "Accessibility.getFullAXTree") return { nodes: [{ backendDOMNodeId: 12, role: { value: "button" }, name: { value: "Post" } }] };
        if (method === "DOM.describeNode") return {node:{backendNodeId:12}};
        if (method === "DOM.resolveNode") return { object: { objectId: "node" } };
        if (method === "Runtime.callFunctionOn") return { result: { value: String(params.functionDeclaration).includes("review too large") ? JSON.stringify({tag:"BUTTON",text:"Post",content:[]}) : String(params.functionDeclaration).includes("elementFromPoint") ? true : { x: 20, y: 30, w: 40, h: 50, clear: true } } };
        if (method === "Page.navigate") { current = { ...current, navigationEpoch: current.navigationEpoch + 1, url: String(params.url) }; return {}; }
        return {};
      },
    },
  });
  return { executor, calls, decisions, docCount: () => docCount, setActive: (v: boolean) => { active = v; }, setSiteAllowed: (v: boolean) => { siteAllowed = v; }, setProtected: (v: boolean) => { protectedPage = v; }, denyAfterNavigation:()=>{denyAfterNavigation=true;}, setAdmit: (fn: typeof admit) => { admit = fn; }, navigate: () => { current = { ...current, navigationEpoch: current.navigationEpoch + 1 }; } };
}

describe("extension executor authority boundary", () => {
  it("refuses arbitrary evaluation before touching the transport", async () => {
    const f = fixture();
    await expect(f.executor.call("agent_browser_eval", { script: "document.cookie" })).rejects.toThrow("not permitted");
    expect(f.calls).toHaveLength(0);
  });
  it("a step on an element carries the engine's node id and the document's frame to the decision (round 6)", async () => {
    const f = fixture();
    await f.executor.call("agent_browser_fill", { selector: "textarea", text: "hi" });
    expect(f.decisions.at(-1)?.node).toEqual({ backendNodeId: 12, frameId: "frame" });
  });
  it("does not inspect even the guard before site admission", async () => {
    const f = fixture(); f.setSiteAllowed(false);
    await expect(f.executor.call("agent_browser_snapshot", {})).rejects.toThrow("not approved");
    // Cleanup cannot inspect a page that was never admitted.
    expect(f.calls).toHaveLength(0);
  });
  it("refuses observations on a protected document", async () => {
    const f = fixture(); f.setProtected(true);
    await expect(f.executor.call("agent_browser_snapshot", {})).rejects.toThrow("take over");
    expect(f.calls.some(c => c.method === "Accessibility.getFullAXTree")).toBe(false);
  });
  it("revalidates stop after an outstanding approval", async () => {
    const f = fixture(); f.setAdmit(async () => { f.setActive(false); return true; });
    await expect(f.executor.call("agent_browser_click", { selector: "button" })).rejects.toThrow("no longer authorised");
    expect(f.calls.some(c => c.method.startsWith("Input."))).toBe(false);
  });
  it("invalidates approval when navigation happens while waiting", async () => {
    const f = fixture(); f.setAdmit(async () => { f.navigate(); return true; });
    await expect(f.executor.call("agent_browser_fill", { selector: "textarea", text: "hello" })).rejects.toThrow("page changed");
    expect(f.calls.some(c => c.method.startsWith("Input."))).toBe(false);
  });
  it("does not return a new page without admission after navigation", async () => {
    const f = fixture();
    f.denyAfterNavigation();
    await expect(f.executor.call("agent_browser_open", { url: "https://example.test/next" })).rejects.toThrow("Site access was not approved");
    expect(f.calls.some(c => c.method === "Accessibility.getFullAXTree")).toBe(false);
  });
  it("produces refs from AX then refuses them on a later document", async () => {
    const f = fixture();
    expect(JSON.stringify(await f.executor.call("agent_browser_snapshot", {}))).toContain('[ref=e1]');
    f.navigate();
    await expect(f.executor.call("agent_browser_click", { selector: "@e1" })).rejects.toThrow("references expired");
    expect(f.calls.some(c => c.method === "Input.dispatchMouseEvent")).toBe(false);
  });
  it("approval summary and digest derive from actual arguments", async () => {
    const f = fixture();
    await f.executor.call("agent_browser_fill", { selector: "textarea", text: "actual message" });
    expect(f.decisions[0].summary).toContain("actual message");
    expect(f.decisions[0].digest).toMatch(/^[a-f0-9]{64}$/);
    expect(f.calls.find(c => c.method === "Input.insertText")?.params).toEqual({ text: "actual message" });
  });
});

it("advertises the exact effective pinned27-tool contract",()=>{const names=fixture().executor.tools().map(tool=>tool.name);expect(names).toHaveLength(27);expect(names).toContain("agent_browser_tab_switch");expect(names).toContain("agent_browser_close");expect(names).not.toContain("agent_browser_eval");expect(names).not.toContain("agent_browser_keyboard_type");});

describe("C3 action cost (SPD-001, MEM-002)", () => {
  it("a simplified click registers the guard once per attachment and uses at most half the transport commands it used to", async () => {
    const f = fixture();
    await f.executor.call("agent_browser_snapshot", {});
    await f.executor.call("agent_browser_click", { selector: "@e1" });
    const docsBefore = f.docCount(), before = f.calls.length + docsBefore, from = f.calls.length;
    await f.executor.call("agent_browser_click", { selector: "@e1" });
    const second = f.calls.length + f.docCount() - before;
    const histogram: Record<string, number> = { "document()": f.docCount() - docsBefore };
    for (const c of f.calls.slice(from)) histogram[c.method] = (histogram[c.method] ?? 0) + 1;
    console.log("C3 second click histogram " + JSON.stringify(histogram));
    const registrations = f.calls.filter(c => c.method === "Page.addScriptToEvaluateOnNewDocument").length;
    console.log(`C3 transport commands: snapshot+2 clicks total=${f.calls.length + f.docCount()} two clicks=${second}`);
    expect(registrations).toBe(1);
    // The same fixture click cost 129 transport commands before this lane (60 sends and 69 document looks); at least half is gone.
    expect(second).toBeLessThanOrEqual(64);
    expect(f.calls.filter(c => c.method === "Input.dispatchMouseEvent").length).toBeGreaterThan(0);
  });
  it("a new tab or a closed engine registers the guard again", async () => {
    const f = fixture();
    await f.executor.call("agent_browser_snapshot", {});
    await f.executor.close();
    await f.executor.call("agent_browser_snapshot", {});
    expect(f.calls.filter(c => c.method === "Page.addScriptToEvaluateOnNewDocument").length).toBe(2);
  });
  it("fresh mutable-fact and guard verdict checks still run before every input", async () => {
    const f = fixture();
    await f.executor.call("agent_browser_snapshot", {});
    await f.executor.call("agent_browser_click", { selector: "@e1" });
    f.setProtected(true);
    await expect(f.executor.call("agent_browser_click", { selector: "@e1" })).rejects.toThrow();
    const last = f.calls.filter(c => c.method === "Input.dispatchMouseEvent").length;
    expect(last).toBe(1);
  });
});

describe("C3 phase timestamps (T52)", () => {
  it("logs admitted, then first visible content, then first input dispatch, in order", async () => {
    const events: { phase: string; sinceAdmitted: number }[] = [];
    const f = fixture({ phase: (e: { phase: string; sinceAdmitted: number }) => events.push(e) });
    await f.executor.call("agent_browser_snapshot", {});
    await f.executor.call("agent_browser_click", { selector: "@e1" });
    expect(events.map(e => e.phase)).toEqual(["admitted", "first_content", "first_input"]);
    expect(events[1].sinceAdmitted).toBeGreaterThanOrEqual(0);
    expect(events[2].sinceAdmitted).toBeGreaterThanOrEqual(events[1].sinceAdmitted);
  });
});

describe("C3 T43 dialogs as a modal state", () => {
  const doc = { profileId: "profile", tabId: 1, frameId: "frame", navigationEpoch: 1, origin: "https://example.test", url: "https://example.test/" };
  // The pinned 27-tool contract has no dialog tool: the engine answers mid-call, through the command hook, which is where the rules sit.
  const answer = async (f: ReturnType<typeof fixture>, accept: boolean) => { const x = f.executor as any; x.executing = true; try { await x.answerDialog(doc, { accept }); } finally { x.executing = false; } };
  const open = (f: ReturnType<typeof fixture>, type: string, message = "Delete everything?") => f.executor.event(1, 1, "Page.javascriptDialogOpening", { type, message });
  it("every tool except snapshot, screenshot and the answer says a dialog is open", async () => {
    const f = fixture();
    open(f, "confirm", "Really send?");
    await expect(f.executor.call("agent_browser_click", { selector: "@e1" })).rejects.toThrow(/A dialog is open on the page: "Really send\?".*Answer it first/);
    await expect(f.executor.call("agent_browser_fill", { selector: "textarea", text: "x" })).rejects.toThrow("Answer it first");
    expect(JSON.stringify(await f.executor.call("agent_browser_snapshot", {}))).toContain("ref=e1");
    expect(f.calls.some(c => c.method === "Input.dispatchMouseEvent" || c.method === "Input.insertText")).toBe(false);
  });
  it("answering clears the modal state", async () => {
    const f = fixture();
    open(f, "confirm");
    await answer(f, false);
    f.executor.event(1, 1, "Page.javascriptDialogClosed", {});
    await f.executor.call("agent_browser_snapshot", {});
    await f.executor.call("agent_browser_click", { selector: "@e1" });
  });
  it("an alert is gated like any step, a dismiss is dialog_dismiss, an accept is dialog_accept, with the dialog's facts", async () => {
    const f = fixture();
    open(f, "alert", "Saved");
    await answer(f, true);
    expect(f.decisions.at(-1)?.name).toBe("agent_browser_dialog_accept");
    expect((f.decisions.at(-1)?.facts as { dialog?: { kind: string } })?.dialog?.kind).toBe("alert");
    open(f, "confirm");
    await answer(f, false);
    expect(f.decisions.at(-1)?.name).toBe("agent_browser_dialog_dismiss");
  });
  it("a beforeunload card asks 'Leave this page?'", async () => {
    const f = fixture();
    open(f, "beforeunload", "Changes you made may not be saved.");
    await answer(f, true);
    expect(f.decisions.at(-1)?.summary).toContain("Leave this page?");
    expect((f.decisions.at(-1)?.facts as { dialog?: { kind: string } })?.dialog?.kind).toBe("beforeunload");
  });
  it("a dialog the owner opened while the bot was not acting is left alone", async () => {
    const f = fixture();
    open(f, "alert", "Owner's own");
    await expect((f.executor as any).answerDialog(doc, { accept: true })).rejects.toThrow("needs the owner");
    expect(f.decisions).toHaveLength(0);
  });
});

describe("C3 review fixes (Astra xr-c3)", () => {
  it("per-tab caches stay bounded when tabs vanish without the bot closing them", async () => {
    const f = fixture();
    for (let tab = 1; tab <= 80; tab++) { const d = { profileId: "profile", tabId: tab, frameId: "frame", navigationEpoch: 1, origin: "https://example.test", url: "https://example.test/" }; await (f.executor as any).world(d, false, true); (f.executor as any).guardRegistered.add(`profile:${tab}`); await (f.executor as any).world(d, true, true); }
    expect((f.executor as any).worlds.size).toBeLessThanOrEqual(32);
    expect((f.executor as any).worlds.size).toBeGreaterThan(0);
  });
});
