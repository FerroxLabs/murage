// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// The two ways to give a server a token: the box a pasted snippet with headers
// opens, and the link a failed sign-in leaves on the card.
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { McpBridge } from "@/lib/mcp-bridge";
import { headerFor, headerValues, inspectInput, saveRemote, type MergedDraft, type ProbeView } from "@/lib/mcp-add-flow";
import { afterSignIn, CHOSE_KEY, draftView, newCardState, withProbe, type DraftCardState } from "@/lib/mcp-card-view";
import { McpDraftCard, type McpDraftCardActions } from "./McpDraftCard";

const URL_TEXT = "https://herm.example.ts.net/mcp";
const HOST = "herm.example.ts.net";
const SNIPPET = JSON.stringify({ mcpServers: { hermes: { url: URL_TEXT, headers: { Authorization: "Bearer YOUR_TOKEN" } } } });
const NEEDS_SIGN_IN: ProbeView = { ok: false, error: "", reason: "needs-sign-in", signIn: { host: HOST } };
const LOCAL_CONFIRM: ProbeView = { ok: false, error: "", reason: "local-confirm", needs: "local-network" };
const USE_KEY = "Use a key instead";
const REV = "abc123def456";

const actions = new Proxy({}, { get: () => vi.fn() }) as unknown as McpDraftCardActions;
const html = (state: DraftCardState) => renderToStaticMarkup(createElement(McpDraftCard, { state, actions }));

/** The button with these words on the card, as React holds it. McpDraftCard has
 * no hooks, so calling it gives the same tree the page draws from. */
function button(node: ReactNode, words: string): { onClick(): void } | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = button(child as ReactNode, words);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement(node)) return undefined;
  const props = node.props as { children?: ReactNode; onClick?(): void };
  if (node.type === "button" && props.children === words && props.onClick) return { onClick: props.onClick };
  return button(props.children, words);
}

function deps(probe: ProbeView) {
  const calls: Array<{ path: string; method: string; body: string }> = [];
  const api = vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
    calls.push({ path, method: init?.method ?? "GET", body: init?.body ?? "" });
    if (path === "/api/mcp/inspect") return { ok: true, drafts: [{ name: "hermes", probe }], noteKeys: [] };
    return { servers: [{ name: "hermes", rev: REV }] };
  });
  const saveSecrets = vi.fn(async () => ({ ok: true }) as const);
  return { api, bridge: { saveSecrets } as unknown as McpBridge, calls, saveSecrets };
}

async function pasted(input: string, probe: ProbeView): Promise<{ state: DraftCardState; flow: ReturnType<typeof deps> }> {
  const flow = deps(probe);
  const outcome = await inspectInput(flow, input);
  if (!outcome.ok) throw new Error(outcome.message);
  return { state: newCardState(outcome.drafts[0]!), flow };
}

function remote(state: DraftCardState): Extract<MergedDraft, { kind: "remote" }> {
  if (state.draft.kind !== "remote") throw new Error("expected a link");
  return state.draft;
}

describe("a snippet with headers", () => {
  it("opens a token box on a server that asks for sign-in, and saves the token as a header", async () => {
    const { state, flow } = await pasted(SNIPPET, NEEDS_SIGN_IN);
    expect(draftView(state)).toBe("ready");
    const page = html(state);
    expect(page).toContain('type="password"');
    expect(page).toContain("Add and test");
    expect(page).not.toContain(`Sign in to ${HOST}`);

    const typed = { ...state.typed, "header:Authorization": "tok-1" };
    const headers = headerValues(state.draft.fields, typed);
    expect(headers).toEqual({ Authorization: "Bearer tok-1" });

    const saved = await saveRemote(flow, { name: state.name, draft: remote(state), auth: "header", headers });
    expect(saved).toEqual({ ok: true });
    const post = flow.calls.find((call) => call.path === "/api/mcp/servers")!;
    expect(JSON.parse(post.body)).toMatchObject({ name: "hermes", url: URL_TEXT, auth: "header", headers: { Authorization: true }, enabled: false });
    expect(post.body).not.toContain("tok-1");
    expect(flow.saveSecrets).toHaveBeenCalledWith("hermes", { headers: { Authorization: "Bearer tok-1" }, rev: REV });
  });

  it("moves a real token out of the paste into the box", async () => {
    const real = JSON.stringify({ mcpServers: { hermes: { url: URL_TEXT, headers: { Authorization: "Bearer abc123" } } } });
    const { state } = await pasted(real, NEEDS_SIGN_IN);
    expect(state.typed).toEqual({ "header:Authorization": "abc123" });
    expect(state.draft.fields[0]).not.toHaveProperty("value");
    expect(headerValues(state.draft.fields, state.typed)).toEqual({ Authorization: "Bearer abc123" });
  });

  it("keeps the token box after the local network question", async () => {
    const { state } = await pasted(SNIPPET, LOCAL_CONFIRM);
    expect(draftView(state)).toBe("local-confirm");
    const confirmed = { ...state, ...withProbe(NEEDS_SIGN_IN), confirmed: "local-network" as const };
    expect(draftView(confirmed)).toBe("ready");
    expect(html(confirmed)).toContain('type="password"');
  });
});

describe("a failed sign-in", () => {
  const signInCard = async () => (await pasted(URL_TEXT, NEEDS_SIGN_IN)).state;

  it("has no key link before anything failed, when the server never mentioned a key", async () => {
    expect(html(await signInCard())).not.toContain(USE_KEY);
  });

  const failed = (message: string) => afterSignIn({ message, cancelled: false });

  it("offers a key even though the server never mentioned one", async () => {
    const state = { ...(await signInCard()), savedName: "hermes", ...failed(`${HOST} did not share the details Murage needs to sign in.`) };
    const page = html(state);
    expect(page).toContain(state.message);
    expect(page).toContain(USE_KEY);
  });

  it("has no key link when only the save failed, before any sign-in began", async () => {
    const state = { ...(await signInCard()), message: "A connected tool with that name already exists. Pick another name." };
    const page = html(state);
    expect(page).toContain(state.message);
    expect(page).not.toContain(USE_KEY);
  });

  it("has no key link after the owner cancelled the sign-in", async () => {
    const state = { ...(await signInCard()), savedName: "hermes", ...afterSignIn({ message: "", cancelled: true }) };
    expect(html(state)).not.toContain(USE_KEY);
  });

  it("the link, clicked, reaches a key box that replaces the saved entry under its revision", async () => {
    const { state, flow } = await pasted(URL_TEXT, NEEDS_SIGN_IN);
    const onUseKey = vi.fn();
    const clickable = { ...actions, onUseKey } as McpDraftCardActions;
    let card: DraftCardState = { ...state, savedName: state.name, ...failed("no details") };
    const link = button(McpDraftCard({ state: card, actions: clickable }), USE_KEY);
    expect(link).toBeDefined();
    link!.onClick();
    expect(onUseKey).toHaveBeenCalledTimes(1);

    card = { ...card, ...CHOSE_KEY };
    expect(card.message).toBeUndefined();
    expect(draftView(card)).toBe("key");
    expect(html(card)).toContain('type="password"');

    const { name, prefix } = headerFor(card.header, "");
    const saved = await saveRemote(flow, {
      name: card.name, draft: remote(card), auth: "header", headers: { [name]: `${prefix}tok-2` }, existing: true,
    });
    expect(saved).toEqual({ ok: true });
    const put = flow.calls.find((call) => call.method === "PUT")!;
    expect(put.path).toBe(`/api/mcp/servers/${card.name}`);
    expect(JSON.parse(put.body)).toMatchObject({ auth: "header", headers: { Authorization: true } });
    expect(flow.saveSecrets).toHaveBeenCalledWith(card.name, { headers: { Authorization: "Bearer tok-2" }, rev: REV });
  });
});
