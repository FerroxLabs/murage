// SPDX-License-Identifier: AGPL-3.0-or-later
// T39: the hard floor on the built-in browser paths, as pure unit tests (no browser, no network).
import { describe, expect, it, vi } from "vitest";

import { callTool } from "./drivers/browser-proxy.ts";
import { createHeadlessBrowserProxy } from "./drivers/headless-browser-proxy.ts";
import { BuiltinFloorGate, protectedDocumentTargeted } from "./browser-floor-builtin.ts";

const page = (elements: Array<{ ref: string; role: string; name: string }>, url = "https://site.example/page", title = "Page") => ({ url, title, elements, notes: [] });

function harness(p: ReturnType<typeof page>) {
  const gate = new BuiltinFloorGate();
  const calls: Array<{ op: string; body?: object }> = [];
  const request = async (op: string, body?: object) => { calls.push({ op, body }); return p; };
  const run = async (name: string, args: unknown) => {
    const res = await callTool(name, args, request, gate);
    return res.content.map((c: any) => c.text ?? "").join("\n");
  };
  return { gate, calls, run };
}
const acted = (calls: Array<{ op: string }>) => calls.filter((c) => !["snapshot", "navigate", "state"].includes(c.op));

describe("T39 floor on the built-in browser (Electron panel path)", () => {
  it("credentials: filling a password field is the owner's turn and nothing is sent", async () => {
    const { run, calls } = harness(page([{ ref: "b1", role: "textbox", name: "Password" }, { ref: "b2", role: "button", name: "Sign in" }]));
    await run("browser_snapshot", {});
    const out = await run("browser_fill", { ref: "b1", text: "hunter2" });
    expect(out).toMatch(/^YOUR TURN:/);
    expect(acted(calls)).toEqual([]);
  });

  it("payment: pressing the final pay button is the owner's turn", async () => {
    const { run, calls } = harness(page([
      { ref: "b1", role: "textbox", name: "Card number" }, { ref: "b2", role: "textbox", name: "CVC" },
      { ref: "b3", role: "button", name: "Pay $42.00" },
    ], "https://shop.example/checkout", "Checkout"));
    await run("browser_snapshot", {});
    const out = await run("browser_click", { ref: "b3" });
    expect(out).toMatch(/^YOUR TURN:/);
    expect(acted(calls)).toEqual([]);
  });

  it("unsure: a ref the model never saw cannot be read, so the click is the owner's turn", async () => {
    const { run, calls } = harness(page([{ ref: "b1", role: "button", name: "Next" }]));
    await run("browser_snapshot", {});
    const out = await run("browser_click", { ref: "b99" });
    expect(out).toMatch(/^YOUR TURN:/);
    expect(acted(calls)).toEqual([]);
  });

  it("unsure: typing with no known focus is the owner's turn", async () => {
    const { run, calls } = harness(page([{ ref: "b1", role: "button", name: "Next" }]));
    await run("browser_snapshot", {});
    expect(await run("browser_type", { text: "hello" })).toMatch(/^YOUR TURN:/);
    expect(acted(calls)).toEqual([]);
  });

  it("benign: a calendar Accept goes through", async () => {
    const { run, calls } = harness(page([{ ref: "b1", role: "heading", name: "Lunch with Sam, Tuesday 12:30" }, { ref: "b2", role: "button", name: "Accept" }, { ref: "b3", role: "button", name: "Decline" }], "https://calendar.example/invite", "Invitation"));
    await run("browser_snapshot", {});
    const out = await run("browser_click", { ref: "b2" });
    expect(out).not.toMatch(/YOUR TURN/);
    expect(acted(calls).map((c) => c.op)).toEqual(["click"]);
  });
});

describe("T39 floor on the unified and headless paths (agent_browser tools)", () => {
  const snapshot = (yaml: string) => ({ content: [{ type: "text", text: yaml }] });

  it("credentials by ref", async () => {
    const gate = new BuiltinFloorGate();
    gate.rememberToolResult("agent_browser_snapshot", snapshot('- textbox "Password" [ref=e1]\n- button "Log in" [ref=e2]'));
    expect(await gate.guardAgentBrowser("agent_browser_fill", { selector: "@e1", text: "x" })).toMatch(/^YOUR TURN:/);
  });

  it("payment by ref", async () => {
    const gate = new BuiltinFloorGate();
    gate.rememberToolResult("agent_browser_snapshot", snapshot('- textbox "Card number" [ref=e1]\n- textbox "CVC" [ref=e2]\n- button "Pay now" [ref=e3]'));
    expect(await gate.guardAgentBrowser("agent_browser_click", { selector: "@e3" })).toMatch(/^YOUR TURN:/);
  });

  it("unsure: an unknown ref", async () => {
    const gate = new BuiltinFloorGate();
    gate.rememberToolResult("agent_browser_snapshot", snapshot('- button "Next" [ref=e1]'));
    expect(await gate.guardAgentBrowser("agent_browser_click", { selector: "@e7" })).toMatch(/^YOUR TURN:/);
  });

  it("refused: a failed read of a CSS-selector target stops the step", async () => {
    const gate = new BuiltinFloorGate();
    const read = vi.fn(async () => { throw new Error("engine down"); });
    expect(await gate.guardAgentBrowser("agent_browser_click", { selector: "#go" }, read)).toMatch(/^YOUR TURN:/);
    expect(read).toHaveBeenCalledOnce();
  });

  it("a CSS selector on a password input is read as that element and floors", async () => {
    const gate = new BuiltinFloorGate();
    const read = async () => '<input type="password" name="pw" id="pw">';
    expect(await gate.guardAgentBrowser("agent_browser_fill", { selector: "#pw", text: "x" }, read)).toMatch(/^YOUR TURN:/);
  });

  it("benign calendar Accept passes", async () => {
    const gate = new BuiltinFloorGate();
    gate.rememberToolResult("agent_browser_snapshot", snapshot('- heading "Lunch with Sam" [ref=e1]\n- button "Accept" [ref=e2]'));
    expect(await gate.guardAgentBrowser("agent_browser_click", { selector: "@e2" })).toBeNull();
  });

  it("reads and scrolls are never stopped", async () => {
    const gate = new BuiltinFloorGate();
    expect(await gate.guardAgentBrowser("agent_browser_snapshot", {})).toBeNull();
    expect(await gate.guardAgentBrowser("agent_browser_scroll", {})).toBeNull();
  });
});

describe("Opus Batch 2 review: focus the gate cannot see", () => {
  const snapshot = (yaml: string) => ({ content: [{ type: "text", text: yaml }] });
  it("a Tab moves focus off the clicked field, so typing next is the owner's turn, not judged on the old field", async () => {
    const gate = new BuiltinFloorGate();
    gate.rememberToolResult("agent_browser_snapshot", snapshot('- textbox "Search" [ref=e1]\n- textbox "Billing note" [ref=e2]'));
    expect(await gate.guardAgentBrowser("agent_browser_click", { selector: "@e1" })).toBeNull();
    expect(await gate.guardAgentBrowser("agent_browser_press", { key: "Tab" })).toBeNull();
    expect(await gate.guardAgentBrowser("agent_browser_keyboard_type", { text: "4111 1111 1111 1111" })).toMatch(/^YOUR TURN:/);
  });
  it("the Electron panel path: press Tab then type is stopped the same way", async () => {
    const gate = new BuiltinFloorGate();
    gate.remember({ elements: [{ ref: "e1", role: "textbox", name: "Search" }, { ref: "e2", role: "textbox", name: "Note" }] });
    gate.noteFocus("e1");
    expect(await gate.check("press", { key: "Tab" })).toBeNull();
    expect(await gate.check("type", {})).toMatch(/^YOUR TURN:/);
  });
  it("typing straight after a click on a plain field still goes ahead", async () => {
    const gate = new BuiltinFloorGate();
    gate.rememberToolResult("agent_browser_snapshot", snapshot('- textbox "Search" [ref=e1]'));
    expect(await gate.guardAgentBrowser("agent_browser_click", { selector: "@e1" })).toBeNull();
    expect(await gate.guardAgentBrowser("agent_browser_keyboard_type", { text: "boots" })).toBeNull();
  });
});

describe("L11a: the Use my Chrome guard asks a targeted question", () => {
  it("a page the isolated-world guard marks protected is answered without DOM.getDocument", async () => {
    const methods: string[] = [];
    const send = async (method: string) => {
      methods.push(method);
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "f1" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
      if (method === "Runtime.evaluate") return { result: { type: "boolean", value: true } };
      throw new Error(`unexpected ${method}`);
    };
    expect(await protectedDocumentTargeted(send, "guard()", "w")).toBe(true);
    expect(methods).not.toContain("DOM.getDocument");
  });
  it("an uninspectable page throws, which the caller treats as protected", async () => {
    const send = async (method: string) => method === "Page.getFrameTree" ? { frameTree: { frame: { id: "f1" } } } : method === "Page.createIsolatedWorld" ? { executionContextId: 1 } : { exceptionDetails: {} };
    await expect(protectedDocumentTargeted(send, "g()", "w")).rejects.toThrow();
  });
});

describe("T39 headless engine path end to end (fake engine)", () => {
  const spec = { command: "/fixture/engine", args: ["mcp"], env: { AGENT_BROWSER_SESSION: "owned", AGENT_BROWSER_ENCRYPTION_KEY: "a".repeat(64) } };
  it("a snapshot then a password fill: the engine never receives the fill", async () => {
    const sent: string[] = [];
    const request = vi.fn(async (method: string, params?: any) => {
      if (method === "tools/call") sent.push(params.name);
      return { content: [{ type: "text", text: params?.name === "agent_browser_snapshot" ? '- textbox "Password" [ref=e1]' : "ok" }] };
    });
    const proxy = createHeadlessBrowserProxy({ authorize: async () => ({ spec, held: false }), start: () => ({ request, close: async () => {} }), closeSession: async () => {} });
    await proxy.handle({ id: 1, method: "tools/call", params: { name: "agent_browser_snapshot", arguments: {} } });
    const out = await proxy.handle({ id: 2, method: "tools/call", params: { name: "agent_browser_fill", arguments: { selector: "@e1", text: "x" } } }) as any;
    expect(out.result.content[0].text).toMatch(/^YOUR TURN:/);
    expect(sent).toEqual(["agent_browser_snapshot"]);
    await proxy.close();
  });
});

describe("L11a: a closed shadow root is never clear", () => {
  // Opus Batch 2 review: a closed root can hang off a plain div, not only a custom element.
  const fake = (dom: () => unknown) => {
    const methods: string[] = [];
    const send = async (method: string, params: any = {}) => {
      methods.push(method);
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "f1" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
      if (method === "Runtime.evaluate") return String(params.expression).includes("__murageGuard()") ? { result: { type: "boolean", value: false } } : { result: { type: "number", value: 0 } };
      if (method === "DOM.getDocument") return dom();
      if (method === "DOM.describeNode") return { node: { nodeName: "DIV" } };
      throw new Error(`unexpected ${method}`);
    };
    return { send, methods };
  };
  const page = (host: Record<string, unknown>) => ({ root: { nodeName: "#document", children: [{ nodeName: "HTML", children: [{ nodeName: "BODY", children: [host] }] }] } });
  it("a closed root on a custom element is handed over to the owner", async () => {
    const { send } = fake(() => page({ nodeName: "LOGIN-BOX", shadowRoots: [{ shadowRootType: "closed", children: [{ nodeName: "INPUT" }] }] }));
    expect(await protectedDocumentTargeted(send, "guard()", "w")).toBe(true);
  });
  it("a closed root on a plain div (not a custom element) is handed over to the owner", async () => {
    const { send } = fake(() => page({ nodeName: "DIV", shadowRoots: [{ shadowRootType: "closed", children: [{ nodeName: "INPUT" }] }] }));
    expect(await protectedDocumentTargeted(send, "guard()", "w")).toBe(true);
  });
  it("a tree that cannot be read counts as protected, not clear", async () => {
    const { send } = fake(() => { throw new Error("gone"); });
    expect(await protectedDocumentTargeted(send, "guard()", "w")).toBe(true);
  });
  it("open roots only stay clear", async () => {
    const { send } = fake(() => page({ nodeName: "MY-ICON", shadowRoots: [{ shadowRootType: "open", children: [{ nodeName: "SPAN" }] }] }));
    expect(await protectedDocumentTargeted(send, "guard()", "w")).toBe(false);
  });
});
