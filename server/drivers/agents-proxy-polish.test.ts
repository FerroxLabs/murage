// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMAIL_TOOLS_ENV } from "./email-tool-schemas.ts";

// Exercise the real proxy's stdio handler with in-memory input and mocked HTTP.
const input = vi.hoisted(() => ({ line: undefined as ((line: string) => void) | undefined }));
vi.mock("node:readline", () => ({ default: { createInterface: () => ({
  on(event: string, listener: (line: string) => void) { if (event === "line") input.line = listener; },
}) } }));

type Reply = { result?: { tools?: Array<{ name: string; description: string; inputSchema: unknown }>; content?: Array<{ text: string }>; isError?: boolean }; error?: { code: number } };
let sequence = 0;
let requestIngress: ReturnType<typeof import("../consuming-turn-ingress.ts")["createConsumingIngress"]>;

async function rpc(method: string, params = {}): Promise<Reply> {
  const id = ++sequence;
  const output = vi.spyOn(process.stdout, "write");
  try {
    return await new Promise<Reply>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Proxy did not answer")), 1000);
      output.mockImplementation((chunk: string | Uint8Array, ...args: unknown[]) => {
        const reply = JSON.parse(String(chunk));
        if (reply.id === id) { clearTimeout(timeout); resolve(reply); }
        // The real catalog writer advances only after stdout confirms its flush.
        const callback = args.find(arg => typeof arg === "function") as (() => void) | undefined;
        if (callback) queueMicrotask(callback);
        return true;
      });
      const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      requestIngress.request(frame, () => input.line!(frame));
    });
  } finally { output.mockRestore(); }
}
async function proxy(mode: string, role = "") {
  vi.resetModules();
  vi.stubEnv(EMAIL_TOOLS_ENV, mode);
  vi.stubEnv("MURAGE_PROJECT_ROLE", role);
  vi.stubEnv("MURAGE_HARNESS_URL", "http://127.0.0.1:1");
  const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ message: "Delegation queued.", taskId: "task-1" }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  // The HTTP spy models the harness; the real retained ledger still owns
  // request admission, upstream accounting, and final stdout acceptance.
  const { consumingFixture } = await import("../testing/consuming-fixture.ts");
  const { createConsumingIngress } = await import("../consuming-turn-ingress.ts");
  const { createProxyTurnRelease } = await import("../proxy-turn-release.ts");
  const { registerConsumingDescriptor } = await import("../consuming-turn-response.ts");
  const { accountedResponse, withUpstreamOwner } = await import("../memory/upstream-reader.ts");
  const fixture = consumingFixture();
  const descriptor = registerConsumingDescriptor("proxy:agents:frame", "body");
  const ingress = createConsumingIngress(fixture.binding, "email-fixture");
  requestIngress = ingress;
  cleanups.push(() => { ingress.retire(); fixture.close(); });
  const release = createProxyTurnRelease("email-fixture", {
    verdict: async frame => ingress.issue(frame),
    envelope: async envelope => { ingress.deliver(envelope, frame => process.stdout.write(frame + "\n")); },
    seal: ingress.seal, terminal: () => {}, close: () => {},
  });
  vi.doMock("../proxy-turn-release.ts", async original => ({
    ...await original<typeof import("../proxy-turn-release.ts")>(),
    releaseProxyFrame: (_role: string, value: unknown) => {
      const frame = typeof value === "string" ? value : JSON.stringify(value);
      return release.release(JSON.parse(frame).id ?? null, { frame, refs: [], descriptor });
    },
    proxyFetch: async (_role: string, ...args: Parameters<typeof globalThis.fetch>) => {
      const awaited = await globalThis.fetch(...args);
      try { return withUpstreamOwner({ budgets: [fixture.budget], refuse: () => release.transportLost() }, () => accountedResponse(awaited)); }
      catch (error) { release.transportLost(); throw error; }
    },
  }));
  // Fixture construction loads catalog dependencies; re-import the entry
  // after installing its admitted in-process transport ports.
  vi.resetModules();
  await import("./agents-proxy.ts");
  return fetch;
}
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); vi.doUnmock("../proxy-turn-release.ts"); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("delegation titles and catalog size", () => {
  it("lists an optional title and uses it as the saved hand-off headline and result", async () => {
    const fetch = await proxy("send");
    const tool = (await rpc("tools/list")).result!.tools!.find(tool => tool.name === "delegate_bot")!;
    expect(tool.inputSchema).toMatchObject({ properties: { title: { type: "string", maxLength: 120 } } });
    const reply = await rpc("tools/call", { name: "delegate_bot", arguments: { bot_id: "peer", message: "Draft the report", title: "Weekly report", reason: "For the review" } });
    expect(reply.result!.content![0].text).toContain("Weekly report");
    const body = JSON.parse(String(fetch.mock.calls[0][1]!.body));
    expect(body).toMatchObject({ message: "Draft the report", reason: "Weekly report: For the review" });
  });
  it("refuses an overlong title before it can queue work", async () => {
    const fetch = await proxy("send");
    const reply = await rpc("tools/call", { name: "delegate_bot", arguments: { bot_id: "peer", message: "Draft", title: "x".repeat(121) } });
    expect(reply.result!.isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps every listed tool within a byte budget, naming an oversized tool", async () => {
    await proxy("send");
    const module = await import("./agents-proxy.ts");
    const check = (module as unknown as { assertAgentCatalogBudget: (tools: unknown[]) => void }).assertAgentCatalogBudget;
    expect(check).toBeTypeOf("function");
    const tools = (await rpc("tools/list")).result!.tools!;
    expect(() => check(tools)).not.toThrow();
    expect(() => check([{ name: "delegate_bot", description: "界".repeat(3000), inputSchema: {} }])).toThrow(/delegate_bot/);
    const delegate = tools.find(tool => tool.name === "delegate_bot")!;
    expect(Buffer.byteLength(JSON.stringify(delegate))).toBeLessThanOrEqual(2400);
  });
});
