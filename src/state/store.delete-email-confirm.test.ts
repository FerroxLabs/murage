// Restore park B3b: deleteBot carries the owner's email confirm token on the DELETE body, and only then.
// Without a token the DELETE is exactly the request the store always sent (same method, url, headers, and no body).
// Drives the REAL wrapped dispatch out of StoreProvider (the harness of store.delete-drafts.test.ts).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StoreProvider, useStore, type Action } from "./store";

afterEach(() => { vi.unstubAllGlobals(); });

async function deleteRequest(action: Action): Promise<{ url: string; init: Record<string, unknown> }> {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); }, removeItem: (k: string) => { values.delete(k); }, key: (i: number) => [...values.keys()][i] ?? null, get length() { return values.size; } });
  const sent: Array<{ url: string; init: Record<string, unknown> }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    sent.push({ url: String(url), init: (init ?? {}) as Record<string, unknown> });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }));
  let dispatch: ((next: Action) => void) | null = null;
  const Probe = () => { dispatch = useStore().dispatch; return null; };
  renderToStaticMarkup(createElement(StoreProvider, null, createElement(Probe)));
  dispatch!(action);
  await vi.waitFor(() => expect(sent.some((call) => call.init.method === "DELETE")).toBe(true));
  return sent.find((call) => call.init.method === "DELETE")!;
}

describe("deleteBot and the email confirm token", () => {
  it("with a token the DELETE body is exactly {emailConfirm: token}", async () => {
    const call = await deleteRequest({ type: "deleteBot", source: "local", attempt: "a1", botId: "bramble", emailConfirm: "tok_del_1" });
    expect(call.url).toBe("/api/bots/bramble");
    expect(call.init.body).toBe(JSON.stringify({ emailConfirm: "tok_del_1" }));
    expect((call.init.headers as Record<string, string>)["x-murage-attempt"]).toBe("a1");
  });

  it("without a token the request is the base request: same url, method and attempt header, and no body at all", async () => {
    const call = await deleteRequest({ type: "deleteBot", source: "local", attempt: "a2", botId: "bramble" });
    expect(call.url).toBe("/api/bots/bramble");
    expect(call.init.method).toBe("DELETE");
    expect((call.init.headers as Record<string, string>)["x-murage-attempt"]).toBe("a2");
    expect("body" in call.init).toBe(false);
  });

  it("an empty token counts as no token, and an archived delete keeps its query", async () => {
    const call = await deleteRequest({ type: "deleteBot", source: "local", attempt: "a3", botId: "bramble", archived: true, emailConfirm: "" });
    expect(call.url).toBe("/api/bots/bramble?ifArchived=1");
    expect("body" in call.init).toBe(false);
  });
});
