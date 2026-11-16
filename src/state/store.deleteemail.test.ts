// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// R31 (1.0.19): the bot DELETE carries {"emailConfirm": token} only when the dialog was given one, and a retry reuses it.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StoreProvider, useStore, type Action } from "./store";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

async function deleteWith(extra: Record<string, unknown>, responses: Array<() => Response>) {
  vi.useFakeTimers();
  const bodies: Array<string | undefined> = [];
  let n = 0;
  vi.stubGlobal("fetch", ((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/api/bots/x")) { bodies.push(init?.body as string | undefined); return Promise.resolve(responses[Math.min(n++, responses.length - 1)]!()); }
    return Promise.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
  }) as typeof fetch);
  let dispatch: ((action: Action) => void) | null = null;
  const Probe = () => { dispatch = useStore().dispatch; return null; };
  renderToStaticMarkup(createElement(StoreProvider, null, createElement(Probe)));
  let settled: unknown;
  dispatch!({ type: "deleteBot", source: "local", botId: "x", attempt: "a", onSettled: (r: unknown) => { settled = r; }, ...extra } as Action);
  for (let i = 0; i < 20 && settled === undefined; i += 1) await vi.advanceTimersByTimeAsync(30_000);
  return { bodies, settled };
}
const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
const bad = () => new Response("<html>bad gateway</html>", { status: 502 });

describe("R31: bot DELETE body", () => {
  it('emailConfirm "" is sent as {"emailConfirm":""} on every try', async () => {
    const { bodies, settled } = await deleteWith({ emailConfirm: "" }, [bad, bad, ok]);
    // MAIN RULING R31-EMPTY-CONFIRM: an empty token is transmitted by presence on every retry.
    expect(bodies).toEqual(Array(3).fill(JSON.stringify({ emailConfirm: "" })));
    expect(settled).toMatchObject({ outcome: "deleted" });
  });
  it("a non-string emailConfirm sends no body", async () => {
    for (const value of [5, null]) { const { bodies } = await deleteWith({ emailConfirm: value }, [ok]); expect(bodies).toEqual([undefined]); }
  });
  it("parked inbox: the body is exactly {emailConfirm}", async () => {
    const { bodies, settled } = await deleteWith({ emailConfirm: "tok-1" }, [ok]);
    expect(bodies).toEqual([JSON.stringify({ emailConfirm: "tok-1" })]);
    expect(settled).toMatchObject({ outcome: "deleted" });
  });
  it("no token: no body", async () => {
    const { bodies } = await deleteWith({}, [ok]);
    expect(bodies).toEqual([undefined]);
  });
  it("a retry reuses the same body", async () => {
    const { bodies, settled } = await deleteWith({ emailConfirm: "tok-1" }, [bad, bad, ok]);
    expect(bodies).toEqual(Array(3).fill(JSON.stringify({ emailConfirm: "tok-1" })));
    expect(settled).toMatchObject({ outcome: "deleted" });
  });
});
