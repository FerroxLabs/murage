// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// SETTINGS-LOCKED-1019.md 4.1, row by row: the state, whether it can be picked, its tone, its line and its one fix.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import "@/lib/settings-copy";
import { EngineRow } from "@/components/EngineRow";
import { CREDIT_MAX_AGE_MS, isFluxRouted, routeState, type RouteInstance } from "./route-state";

const NOW = 1_800_000_000_000;
type Over = Omit<Partial<RouteInstance>, "snapshot"> & { snapshot?: Partial<RouteInstance["snapshot"]> };
const engine = (over: Over = {}): RouteInstance => ({
  instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", enabled: true,
  ...over,
  snapshot: { state: "available", authenticated: true, ...over.snapshot },
});
const fuigo = (over: Over = {}) => engine({ instanceId: "fuigo", driverKind: "fuigoAgent", displayName: "Fuigo", ...over });
const fresh = (state: "ok" | "low" | "out" | "unknown", more: object = {}) => ({ state, asOf: NOW - 1000, ...more });
const rs = (instance: RouteInstance, connection?: Parameters<typeof routeState>[2], credit?: Parameters<typeof routeState>[3]) =>
  routeState({ instanceId: instance.instanceId, model: "m" }, instance, connection, credit, NOW);

describe("routeState, the nine states in the locked order", () => {
  it("Off: turned off by you, cannot be picked, muted, with Turn on", () => {
    const r = rs(engine({ enabled: false }));
    expect(r).toMatchObject({ state: "off", selectable: false, tone: "muted", line: "Off. Turn it on to use Claude again." });
    expect(r.fix).toMatchObject({ action: "turnOn", label: "Turn on", name: "Turn on Claude" });
  });
  it("Install: unavailable without a repair, blocked, with Install", () => {
    const r = rs(engine({ snapshot: { state: "unavailable" } }));
    expect(r).toMatchObject({ state: "install", selectable: false, tone: "blocked", line: "Claude is not installed on this computer." });
    expect(r.fix?.action).toBe("install");
  });
  it("Repair: setupAction repair wins over the unavailable reading", () => {
    const r = rs(engine({ snapshot: { state: "unavailable", setupAction: "repair" } }));
    expect(r).toMatchObject({ state: "repair", selectable: false, tone: "blocked", line: "Claude needs a repair." });
    expect(r.fix?.action).toBe("repair");
  });
  it("Renew: still selectable, a warning, with Renew; it beats a signed-out reading", () => {
    const r = rs(engine({ snapshot: { renewSignIn: true, authenticated: false } }));
    expect(r).toMatchObject({ state: "renew", selectable: true, tone: "warning", line: "Sign in to Claude again on your computer." });
    expect(r.fix).toMatchObject({ action: "renew", label: "Sign in again", name: "Sign in to Claude again" });
  });
  it("Sign in: authenticated false only, blocked, and the button is named for its fix", () => {
    const r = rs(engine({ snapshot: { authenticated: false } }));
    expect(r).toMatchObject({ state: "signIn", selectable: false, tone: "blocked", line: "Claude needs you to sign in." });
    expect(r.fix).toMatchObject({ action: "signIn", label: "Sign in", name: "Sign in to Claude" });
  });
  it("Sign in on the Codex row adds the ChatGPT account hint, and nowhere else", () => {
    const codex = rs(engine({ driverKind: "codex", displayName: "Codex", snapshot: { authenticated: false } }));
    expect(codex.line).toBe("Codex needs you to sign in. Or use your ChatGPT account in Accounts and keys.");
    expect(rs(engine({ snapshot: { authenticated: false } })).line).not.toContain("ChatGPT");
  });
  it("authenticated undefined is not signed out: drivers that do not probe are never called signed out", () => {
    expect(rs(engine({ snapshot: { authenticated: undefined } })).state).toBe("ready");
  });
  it("Checking: a sign-in that did not answer is selectable and muted, with no fix", () => {
    const r = rs(engine({ snapshot: { authenticated: undefined, authUnverified: true } }));
    expect(r).toMatchObject({ state: "checking", selectable: true, tone: "muted", line: "Checking Claude's sign-in…", fix: null });
  });
  it("Checking credit: a Flux route with no reading, an unknown one, or one older than five minutes", () => {
    for (const credit of [undefined, null, fresh("unknown"), { state: "ok" as const, asOf: NOW - CREDIT_MAX_AGE_MS - 1 }]) {
      expect(rs(fuigo(), { kind: "flux" }, credit), String(credit && JSON.stringify(credit))).toMatchObject({ state: "checking", selectable: true, tone: "muted", line: "Checking credit…", fix: null });
    }
  });
  it("a reading with no timestamp, a failed refresh, or a stale low or out is Checking, and a balance on it is never shown", () => {
    const untrusted = [{ state: "ok" as const }, { state: "low" as const }, { state: "out" as const, balance: "$0" }, { state: "failed" as const, asOf: NOW - 1000, balance: "$0" },
      { state: "out" as const, asOf: NOW - CREDIT_MAX_AGE_MS - 1, balance: "$0.00" }, { state: "low" as const, asOf: NOW - CREDIT_MAX_AGE_MS - 1 }, { state: "ok" as const, asOf: Number.NaN }];
    for (const credit of untrusted) {
      const r = rs(fuigo(), { kind: "flux" }, credit);
      expect(r, JSON.stringify(credit)).toMatchObject({ state: "checking", line: "Checking credit…", selectable: true, fix: null });
      expect(r.line).not.toContain("$");
    }
  });
  it("a reading exactly five minutes old still counts", () => {
    expect(rs(fuigo(), { kind: "flux" }, { state: "ok", asOf: NOW - CREDIT_MAX_AGE_MS }).state).toBe("ready");
  });
  it("Add credit: out on a Flux route is blocked with Add credit; included credit says so; a balance is shown as read", () => {
    expect(rs(fuigo(), { kind: "flux" }, fresh("out"))).toMatchObject({ state: "addCredit", selectable: false, tone: "blocked", line: "Your Flux credit has run out." });
    expect(rs(fuigo(), { kind: "flux" }, fresh("out", { kind: "included" })).line).toBe("Your included credit is used up.");
    const withBalance = rs(fuigo(), { kind: "flux" }, fresh("out", { balance: "$0.42" }));
    expect(withBalance.line).toBe("Your Flux credit has run out. Balance: $0.42.");
    expect(withBalance.fix).toMatchObject({ action: "addCredit", label: "Add credit", name: "Add credit for Fuigo" });
    expect(rs(fuigo(), { kind: "flux" }, fresh("out")).line).not.toContain("$");
  });
  it("Low credit: a warning on a route that can still be picked, with Add credit", () => {
    const r = rs(fuigo(), { kind: "flux" }, fresh("low"));
    expect(r).toMatchObject({ state: "lowCredit", selectable: true, tone: "warning", line: "Low credit: Fuigo runs one thing at a time." });
    expect(r.fix?.action).toBe("addCredit");
  });
  it("credit never touches a route that does not spend Flux credit", () => {
    expect(rs(engine(), { kind: "account" }, fresh("out")).state).toBe("ready");
    expect(rs(engine(), { kind: "key" }, fresh("low")).state).toBe("ready");
    expect(rs(engine(), { kind: "local", localModels: 2 }, undefined).state).toBe("ready");
    expect(rs(engine(), undefined, undefined).state).toBe("ready");
  });
  it("Ready reads its source: account, signed in, Flux credit, your key, local models", () => {
    expect(rs(engine(), { kind: "account", account: "ada@work.example" }).line).toBe("Ready · signed in as ada@work.example");
    expect(rs(engine(), { kind: "account" }).line).toBe("Ready · signed in");
    expect(rs(engine()).line).toBe("Ready · signed in");
    expect(rs(fuigo(), { kind: "flux" }, fresh("ok")).line).toBe("Ready · on Flux credit");
    expect(rs(fuigo(), undefined, fresh("ok")).line).toBe("Ready · on Flux credit");
    expect(rs(engine(), { kind: "key" }).line).toBe("Ready · your key");
    expect(rs(engine(), { kind: "local", localModels: 3 }).line).toBe("Ready · 3 models on this computer");
    expect(rs(engine(), { kind: "local", localModels: 1 }).line).toBe("Ready · 1 model on this computer");
    expect(rs(engine({ snapshot: { authenticated: undefined } })).line).toBe("Ready");
    expect(rs(engine(), { kind: "account" })).toMatchObject({ state: "ready", selectable: true, tone: "ready", fix: null });
  });
  it("first match wins: off beats install, install beats sign in, sign in beats credit, checking beats credit", () => {
    expect(rs(engine({ enabled: false, snapshot: { state: "unavailable" } })).state).toBe("off");
    expect(rs(engine({ snapshot: { state: "unavailable", authenticated: false } })).state).toBe("install");
    expect(rs(fuigo({ snapshot: { authenticated: false } }), { kind: "flux" }, fresh("out")).state).toBe("signIn");
    expect(rs(fuigo({ snapshot: { authUnverified: true } }), { kind: "flux" }, fresh("out")).state).toBe("checking");
  });
  it("a warning never blocks and a block never runs: selectable is independent of tone", () => {
    const states = [rs(engine({ snapshot: { renewSignIn: true } })), rs(fuigo(), { kind: "flux" }, fresh("low"))];
    for (const r of states) expect([r.tone, r.selectable]).toEqual(["warning", true]);
    const blocked = [rs(engine({ enabled: false })), rs(engine({ snapshot: { state: "unavailable" } })), rs(engine({ snapshot: { authenticated: false } })), rs(fuigo(), { kind: "flux" }, fresh("out"))];
    for (const r of blocked) expect(r.selectable).toBe(false);
  });
  it("every state that cannot be picked offers a fix, so no row is ever a dead end", () => {
    const all = [rs(engine({ enabled: false })), rs(engine({ snapshot: { state: "unavailable" } })), rs(engine({ snapshot: { setupAction: "repair", state: "unavailable" } })), rs(engine({ snapshot: { authenticated: false } })), rs(fuigo(), { kind: "flux" }, fresh("out"))];
    for (const r of all) expect(r.fix, r.state).not.toBeNull();
  });
  it("uses the clock when none is passed", () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    try { expect(routeState(null, fuigo(), { kind: "flux" }, { state: "ok", asOf: NOW - 1000 }).state).toBe("ready"); } finally { vi.useRealTimers(); }
  });
});

describe("isFluxRouted", () => {
  it("follows the connection when there is one, and Fuigo's own route when there is not", () => {
    expect(isFluxRouted(fuigo(), { kind: "key" })).toBe(false);
    expect(isFluxRouted(engine(), { kind: "flux" })).toBe(true);
    expect(isFluxRouted(fuigo())).toBe(true);
    expect(isFluxRouted(engine())).toBe(false);
  });
});

describe("EngineRow", () => {
  const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node).replaceAll("&#x27;", "'");
  it("draws the name, the line as a word, and the fix as a button named for what it does", () => {
    const out = html(createElement(EngineRow, { name: "Codex", state: rs(engine({ driverKind: "codex", displayName: "Codex", snapshot: { authenticated: false } })), onFix: () => {} }));
    expect(out).toContain('data-route-state="signIn"');
    expect(out).toContain('data-selectable="false"');
    expect(out).toContain("Codex needs you to sign in.");
    expect(out).toContain('aria-label="Sign in to Codex"');
    expect(out).toContain(">Sign in</button>");
    expect(out).not.toContain("disabled");
  });
  it("draws no button when the state has no fix, and always draws one for every state that cannot be picked", () => {
    expect(html(createElement(EngineRow, { name: "Claude", state: rs(engine()), onFix: () => {} }))).not.toContain("<button");
    const blocked = [rs(engine({ enabled: false })), rs(engine({ snapshot: { state: "unavailable" } })), rs(engine({ snapshot: { setupAction: "repair", state: "unavailable" } })), rs(engine({ snapshot: { authenticated: false } })), rs(fuigo(), { kind: "flux" }, fresh("out"))];
    for (const state of blocked) expect(html(createElement(EngineRow, { name: "x", state, onFix: () => {} })), state.state).toContain("<button");
  });
  it("pressing the button runs the fix once with its action, and a busy row ignores the press", () => {
    type Node = { props: { onClick?: () => void; children?: unknown } };
    const press = (busy: boolean, onFix: (a: string) => void) => {
      const tree = (EngineRow as unknown as (p: object) => { props: { children: unknown[] } })({ name: "Claude", busy, state: rs(engine({ snapshot: { authenticated: false } })), onFix });
      const button = tree.props.children.find((child) => (child as Node | undefined)?.props?.onClick) as Node;
      button.props.onClick?.();
    };
    const idle = vi.fn(); press(false, idle);
    expect(idle).toHaveBeenCalledTimes(1); expect(idle).toHaveBeenCalledWith("signIn");
    const busy = vi.fn(); press(true, busy);
    expect(busy).not.toHaveBeenCalled();
  });
  it("marks a running fix busy for assistive tech", () => {
    expect(html(createElement(EngineRow, { name: "Claude", busy: true, state: rs(engine({ snapshot: { authenticated: false } })), onFix: () => {} }))).toContain('aria-busy="true"');
  });
  it("a warning row is still a pickable row with its warning in words", () => {
    const out = html(createElement(EngineRow, { name: "Fuigo", state: rs(fuigo(), { kind: "flux" }, fresh("low")), onFix: () => {} }));
    expect(out).toContain('data-selectable="true"');
    expect(out).toContain('data-route-tone="warning"');
    expect(out).toContain("Low credit: Fuigo runs one thing at a time.");
  });
});
