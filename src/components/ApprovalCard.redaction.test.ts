import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as store from "../state/store";
import { PendingApprovalPanel, PendingApprovalActions, pendingOf } from "./PendingApproval";
import type { Message } from "../state/store";

afterEach(() => vi.unstubAllGlobals());

describe("approval display handles", () => {
  it.each(["allow", "deny"] as const)("approval %s sends a p. handle", async (action) => {
    const posts: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      if (init?.method === "POST") posts.push(JSON.parse(init.body));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }));
    let dispatch!: (action: store.Action) => void;
    const Probe = () => { dispatch = store.useStore().dispatch; return null; };
    renderToStaticMarkup(createElement(store.StoreProvider, null, createElement(Probe)));
    dispatch({ type: "decideRequest", threadId: "t1", requestId: "p.card-1", behavior: action });
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ requestHandle: "p.card-1", action });
  });
  it("ux.mask-then-approval retains trusted action labels", () => {
    const message: Message = { id: "card-1", role: "bot", kind: "options", at: 1, card: { title: "Approval needed", subtitle: "«redacted»", summary: "«redacted»", tool: "shell", options: ["Allow", "Deny"], requestId: "p.card-1" } };
    const html = renderToStaticMarkup(createElement(PendingApprovalPanel, { pending: pendingOf(message), threadId: "t1" }));
    const actions = renderToStaticMarkup(createElement(store.StoreProvider, null, createElement(PendingApprovalActions, { pending: pendingOf(message), threadId: "t1", onCancelTurn: () => undefined })));
    expect(actions).toContain("Cancel turn"); expect(actions).toContain("Run"); expect(actions).toContain("Don&#x27;t run");
    expect(html).not.toContain("hunter2");
  });
});
