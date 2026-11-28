// SPDX-License-Identifier: AGPL-3.0-or-later
// MONEY #1 (MAIN, 1.0.24): at No limits on the owner's own turn the built-in browser skips the pay/card/password/terms floor exactly as the extension does
// (browser-extension-executor.ts noLimits). Guests, shared threads and email-triggered turns never get the flag (the host sets MURAGE_BROWSER_NO_LIMITS only from
// the turn policy, index.ts browserIntegrationInner), so their steps keep the floor. A CAPTCHA stays a hand-off at every level.
// Owners: lane q1024-paynl owns this file and the gate (browser-floor-builtin.ts); MAIN owns the policy that decides who is at No limits.
// One row per built-in browser site (SITES.md): panel proxy (browser-proxy.ts callTool), headless proxy (headless-browser-proxy.ts), unified proxy (spawned, unified-browser-proxy.ts).
// The checkout is the snapshot a Stripe test-mode Payment Element page gives (card number, expiry, CVC, terms, Pay).
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHeadlessBrowserProxy } from "./drivers/headless-browser-proxy.ts";
import { builtinNoLimits } from "./browser-floor-builtin.ts";
import { runBoundBridge } from "./testing/bound-proxy-fixture.ts";

const CHECKOUT = [
  '- heading "Test mode checkout, Acme Ltd" [ref=e1]', '- textbox "Card number" [ref=e2]', '- textbox "MM / YY" [ref=e3]', '- textbox "CVC" [ref=e4]',
  '- checkbox "I agree to the terms and conditions" [ref=e5]', '- button "Pay $19.00" [ref=e6]', '- textbox "Password" [ref=e7]', '- button "I\'m not a robot" [ref=e8]',
].join("\n");
const STEPS: Array<{ step: string; tool: string; args: Record<string, unknown>; floored: "owner-lifts" | "always" }> = [
  { step: "pay button", tool: "agent_browser_click", args: { selector: "@e6" }, floored: "owner-lifts" },
  { step: "card number entry", tool: "agent_browser_fill", args: { selector: "@e2", text: "4242424242424242" }, floored: "owner-lifts" },
  { step: "terms checkbox", tool: "agent_browser_click", args: { selector: "@e5" }, floored: "owner-lifts" },
  { step: "password entry", tool: "agent_browser_fill", args: { selector: "@e7", text: "pw" }, floored: "owner-lifts" },
  { step: "CAPTCHA control", tool: "agent_browser_click", args: { selector: "@e8" }, floored: "always" },
];
const MODES = [{ who: "owner at No limits", flag: true }, { who: "guest or email-triggered turn (no flag)", flag: false }];
// M3 also asks the host per held step; "tainted" is the owner turn whose live policy or marks no longer lift (host answers lift:false).
const UNIFIED_MODES = [...MODES.map((m) => ({ ...m, lift: true })), { who: "owner flag but the host answers lift:false (email-marked or policy changed)", flag: true, lift: false }];
const snapshotResult = { content: [{ type: "text", text: CHECKOUT }] };
const stopped = (text: string) => /^YOUR TURN:/.test(text);

describe("builtinNoLimits: only the host's exact flag counts", () => {
  it.each([[{ MURAGE_BROWSER_NO_LIMITS: "1" }, true], [{}, false], [{ MURAGE_BROWSER_NO_LIMITS: "0" }, false], [{ MURAGE_BROWSER_NO_LIMITS: "true" }, false], [{ MURAGE_NO_LIMITS: "1" }, false]] as const)("%j", (env, want) => {
    expect(builtinNoLimits(env)).toBe(want);
  });
});

describe("M1 headless proxy", () => {
  const spec = { command: "/fixture/engine", args: ["mcp"], env: { AGENT_BROWSER_SESSION: "owned", AGENT_BROWSER_ENCRYPTION_KEY: "a".repeat(64) } };
  for (const { who, flag } of MODES) for (const { step, tool, args, floored } of STEPS) it(`${step}: ${who}`, async () => {
    const sent: string[] = [];
    const request = vi.fn(async (_method: string, params?: { name?: string }) => {
      if (params?.name) sent.push(params.name);
      return params?.name === "agent_browser_snapshot" ? snapshotResult : { content: [{ type: "text", text: "ok" }] };
    });
    const proxy = createHeadlessBrowserProxy({ noLimits: flag, authorize: async () => ({ spec, held: false }), start: () => ({ request, close: async () => {} }), closeSession: async () => {} });
    await proxy.handle({ id: 1, method: "tools/call", params: { name: "agent_browser_snapshot", arguments: {} } });
    const out = await proxy.handle({ id: 2, method: "tools/call", params: { name: tool, arguments: args } }) as { result: { content: Array<{ text: string }> } };
    const refused = stopped(out.result.content[0].text);
    expect(refused, `${step} ${who}`).toBe(!flag || floored === "always");
    expect(sent.includes(tool), "the engine received the step exactly when the floor let it through").toBe(!refused);
    await proxy.close();
  });
});

describe("M2 panel proxy (browser-proxy.ts, default gate from env)", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
  const elements = [{ ref: "b2", role: "textbox", name: "Card number" }, { ref: "b3", role: "textbox", name: "CVC" }, { ref: "b5", role: "checkbox", name: "I agree to the terms and conditions" }, { ref: "b6", role: "button", name: "Pay $19.00" }, { ref: "b8", role: "button", name: "I'm not a robot" }];
  const PANEL: Array<{ step: string; tool: string; args: Record<string, unknown>; always: boolean }> = [
    { step: "pay button", tool: "browser_click", args: { ref: "b6" }, always: false },
    { step: "card number entry", tool: "browser_fill", args: { ref: "b2", text: "4242424242424242" }, always: false },
    { step: "terms checkbox", tool: "browser_click", args: { ref: "b5" }, always: false },
    { step: "CAPTCHA control", tool: "browser_click", args: { ref: "b8" }, always: true },
  ];
  for (const { who, flag } of MODES) for (const { step, tool, args, always } of PANEL) it(`${step}: ${who}`, async () => {
    if (flag) vi.stubEnv("MURAGE_BROWSER_NO_LIMITS", "1");
    vi.resetModules();
    const { callTool } = await import("./drivers/browser-proxy.ts");
    const calls: string[] = [];
    const request = async (op: string) => { calls.push(op); return { url: "https://checkout.example/c/pay", title: "Checkout", elements, notes: [] }; };
    await callTool("browser_snapshot", {}, request as never);
    const res = await callTool(tool, args, request as never);
    const text = res.content.map((c: any) => c.text ?? "").join("\n");
    expect(stopped(text), `${step} ${who}`).toBe(!flag || always);
    expect(calls.includes(tool.replace("browser_", "")), "the host got the step exactly when the floor let it through").toBe(!stopped(text));
  });
});

describe("M3 unified proxy, spawned (the proxy the built-in browser mounts)", () => {
  const rpc = (id: number, name: string, args: object) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  async function host(lift: boolean) {
    const forwarded: string[] = [];
    const server = createServer((req, res) => {
      let body = ""; req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const call = JSON.parse(body || "{}") as { method?: string; params?: { name?: string } };
        if (call.method === "tools/call" && call.params?.name) forwarded.push(call.params.name);
        res.writeHead(200, { "content-type": "application/json" });
        if (call.method === "murage/floor-lift") { res.end(JSON.stringify({ lift })); return; }
        res.end(JSON.stringify(call.params?.name === "agent_browser_snapshot" ? snapshotResult : { content: [{ type: "text", text: "ok" }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { forwarded, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => { server.closeAllConnections(); server.close(); } };
  }
  const script = "const m=await import('./server/drivers/unified-browser-proxy.ts');void m.runUnifiedBrowserProxy();";
  for (const { who, flag, lift } of UNIFIED_MODES) for (const { step, tool, args, floored } of STEPS) it(`${step}: ${who}`, async () => {
    const h = await host(lift);
    try {
      const env = { MURAGE_CONTROL_URL: h.url, MURAGE_CONTROL_TOKEN: "fixture-token", MURAGE_BOT_ID: "B", MURAGE_THREAD_ID: "T", ...(flag ? { MURAGE_BROWSER_NO_LIMITS: "1" } : {}) };
      const init = JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
      const frames = await runBoundBridge(script, [init, rpc(1, "agent_browser_snapshot", {}), rpc(2, tool, args)], 3, false, { role: "unifiedBrowser", env, owner: true, delays: [0, 1_000, 1_000], timeoutMs: 60_000 });
      const reply = frames.map((f) => JSON.parse(f) as { id?: number; result?: { content?: Array<{ text?: string }> } }).find((r) => r.id === 2);
      const refused = stopped(reply?.result?.content?.[0]?.text ?? "");
      expect(refused, `${step} ${who}`).toBe(!flag || !lift || floored === "always");
      expect(h.forwarded.includes(tool), "the host got the step exactly when the floor let it through").toBe(!refused);
    } finally { h.close(); }
  }, 90_000);
});
