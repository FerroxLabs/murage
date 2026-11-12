// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMAIL_TOOLS_ENV } from "./email-tool-schemas.ts";

// Exercise the real proxy's stdio handler with in-memory input and mocked HTTP.
const input = vi.hoisted(() => ({ line: undefined as ((line: string) => void) | undefined }));
vi.mock("node:readline", () => ({ default: { createInterface: () => ({
  on(event: string, listener: (line: string) => void) { if (event === "line") input.line = listener; },
}) } }));

type Reply = { result?: { tools?: Array<{ name: string }>; content?: Array<{ text: string }> }; error?: { code: number } };
let sequence = 0;
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
      input.line!(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  } finally { output.mockRestore(); }
}
async function proxy(mode: string, role = "") {
  vi.resetModules();
  vi.stubEnv(EMAIL_TOOLS_ENV, mode);
  vi.stubEnv("MURAGE_PROJECT_ROLE", role);
  vi.stubEnv("MURAGE_HARNESS_URL", "http://127.0.0.1:1");
  const fetch = vi.fn(async () => new Response(JSON.stringify({ text: "fixture email result" }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  await import("./agents-proxy.ts");
  return fetch;
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("T-DE-TRUST proxy", () => {
  it("lists and dispatches four tools in delegated mode, excluding only trust_offer from send mode", async () => {
    for (const mode of ["send", "delegated"]) {
      const fetch = await proxy(mode);
      const listed = (await rpc("tools/list")).result!.tools!.filter(tool => tool.name.startsWith("email_")).map(tool => tool.name);
      const allowed = ["email_list", "email_read", "email_send", "email_reply"];
      expect(listed).toEqual(mode === "send" ? [...allowed, "email_trust_offer"] : allowed);
      for (const name of allowed) {
        expect((await rpc("tools/call", { name, arguments: {} })).result!.content).toEqual([{ type: "text", text: "fixture email result" }]);
        expect(fetch).toHaveBeenLastCalledWith(`http://127.0.0.1:1/api/internal/email/${name}`, expect.objectContaining({ method: "POST" }));
      }
      fetch.mockClear();
      const trust = await rpc("tools/call", { name: "email_trust_offer", arguments: {} });
      if (mode === "send") expect(fetch).toHaveBeenCalledOnce();
      else { expect(trust.error).toEqual(expect.objectContaining({ code: -32602 })); expect(fetch).not.toHaveBeenCalled(); }
    }
  });
  it("keeps project turns without email even when the supplied mode is delegated", async () => {
    await proxy("delegated");
    expect((await rpc("tools/list")).result!.tools!.some(tool => tool.name === "email_read")).toBe(true);
    const fetch = await proxy("delegated", "lead");
    expect((await rpc("tools/list")).result!.tools!.some(tool => tool.name.startsWith("email_"))).toBe(false);
    expect((await rpc("tools/call", { name: "email_send", arguments: {} })).error?.code).toBe(-32602);
    expect(fetch).not.toHaveBeenCalled();
  });
});
