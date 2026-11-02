// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The way out of Health (Sean 11-02, 1.0.14): Back, the close button and Esc return to where the person came from,
// or Today, and every rail door leaves Health.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { initialState, reducer, type AppState, type Bot } from "@/state/store";
import { LAZY_RETRY_TEXT, LazyBoundary, PANEL_ERROR_TEXT } from "@/components/LazyBoundary";
import { healthReturn, trackShellOrigins, type ShellOrigins } from "../shell/shell-nav";
import { OPEN_ON_TOP } from "@/lib/escape-layer";
import { HealthExitButtons, HealthFrame, escapeLeavesHealth, healthEscapeListener } from "./HealthExit";
import { HealthPage } from "./HealthPage";

// HealthPage is called as a plain function below to read the tree it returns; its one hook binds Esc, tested on its own.
vi.mock("./HealthExit", async (original) => ({ ...(await original<typeof import("./HealthExit")>()), useHealthEscape: () => {} }));

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const onHealth: AppState = { ...initialState, activeView: "health" };
const noDoc = { querySelector: () => null };
const key = (k: string, extra: Partial<{ defaultPrevented: boolean; target: unknown }> = {}) => ({ key: k, defaultPrevented: false, target: null, preventDefault: vi.fn(), ...extra });

describe("Health's Back and close buttons", () => {
  it("shows a Back button with its word and a named close button, both 44 px", () => {
    const html = renderToStaticMarkup(createElement(HealthExitButtons, { onLeave: vi.fn() }));
    expect(html).toContain('data-testid="health-back"');
    expect(html).toContain(">Back</button>");
    expect(html).toContain('data-testid="health-close"');
    expect(html).toContain('aria-label="Close Health"');
    expect(html.match(/<button type="button"/g)).toHaveLength(2);
    expect(html.match(/min-h-11/g)).toHaveLength(2);
    expect(html).not.toContain("—");
  });

  it("leaves Health on a click of either button", () => {
    const onLeave = vi.fn();
    const [back, close] = (HealthExitButtons({ onLeave }) as any).props.children;
    back.props.onClick();
    expect(onLeave).toHaveBeenCalledTimes(1);
    close.props.onClick();
    expect(onLeave).toHaveBeenCalledTimes(2);
  });

  it("is in the Health header on every screen, phones next to the bot-list button", () => {
    const top = read("./HealthExit.tsx");
    const head = top.slice(top.indexOf("export function HealthHeadTop"), top.indexOf("export function HealthFrame"));
    expect(head).toContain("<HealthExitButtons onLeave={onLeave} />");
    expect(head).toContain('<div className="md:hidden">{menu}</div>');
    // the buttons are not inside the phone-only wrapper
    expect(head).not.toMatch(/md:hidden[^\n]*HealthExitButtons/);
    // the loaded page draws that same header
    const body = read("./HealthPageBody.tsx");
    expect(body.slice(body.indexOf("<BoxHead"), body.indexOf("</BoxHead>"))).toContain("<HealthHeadTop onLeave={onLeave} menu={<OpenBotListButton />} dot={<StatusDot level={status.level} />} />");
    // and so does the loading and failed frame
    expect(top.slice(top.indexOf("export function HealthFrame"))).toContain("<HealthHeadTop onLeave={onLeave} menu={<OpenBotListButton />} />");
  });
});

describe("Health while it loads or after it failed to load", () => {
  const onLeave = vi.fn();
  const page = HealthPage({ onLeave, onOpenNeedsYou: vi.fn() }) as ReactElement<{ inline?: boolean; onDismiss?: () => void; frame?: (alert: ReactNode) => ReactNode; children: ReactElement<{ fallback: ReactNode }> }>;
  /** The header with its way out comes first, and nothing is drawn over the whole screen. */
  const expectWayOut = (html: string) => {
    expect(html).toContain('data-testid="health-back"');
    expect(html).toContain('data-testid="health-close"');
    expect(html).toContain(">Health</h1>");
    expect(html.indexOf("data-box-head")).toBeLessThan(html.indexOf("data-box-body"));
    expect(html).not.toContain("fixed inset-0");
  };

  it("keeps the header, Back and close on screen while loading, with the spinner in the body", () => {
    const html = renderToStaticMarkup(page.props.children.props.fallback as ReactElement);
    expectWayOut(html);
    expect(html).toContain('aria-label="Loading Health"');
    expect(html.indexOf("data-health-loading")).toBeGreaterThan(html.indexOf("data-box-body"));
  });

  it("keeps them after the page failed to load or to show, with the retry in the body", () => {
    expect(page.props.inline).toBe(true);
    expect(page.props.onDismiss).toBe(onLeave);
    const boundary = new LazyBoundary({ ...page.props, onRetry: vi.fn() });
    boundary.state = { failed: true, broken: false };
    const failed = renderToStaticMarkup(boundary.render() as ReactElement);
    expectWayOut(failed);
    expect(failed).toContain(LAZY_RETRY_TEXT.replace("'", "&#x27;"));
    boundary.state = { failed: false, broken: true };
    const broken = renderToStaticMarkup(boundary.render() as ReactElement);
    expectWayOut(broken);
    expect(broken).toContain(PANEL_ERROR_TEXT.replace("'", "&#x27;"));
  });

  it("leaves Health from the loading header", () => {
    const leave = vi.fn();
    const frame = HealthFrame({ onLeave: leave, children: null }) as ReactElement<{ children: ReactElement<{ children: ReactElement<{ onLeave: () => void }> }>[] }>;
    frame.props.children[0].props.children.props.onLeave();
    expect(leave).toHaveBeenCalledOnce();
  });

  it("binds Esc in the eager door, outside the lazy body", () => {
    const door = read("./HealthPage.tsx");
    expect(door).toContain("useHealthEscape(props.onLeave);");
    expect(door).not.toContain("LazyFallback");
    expect(read("./HealthPageBody.tsx")).not.toContain("useHealthEscape(");
  });
});

describe("Esc on Health", () => {
  it("leaves Health on Esc", () => {
    const onLeave = vi.fn();
    const event = key("Escape");
    healthEscapeListener(onLeave, () => noDoc)(event);
    expect(onLeave).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it("ignores other keys and an Esc something else already used", () => {
    const onLeave = vi.fn();
    const listen = healthEscapeListener(onLeave, () => noDoc);
    listen(key("Enter"));
    listen(key("Escape", { defaultPrevented: true }));
    expect(onLeave).not.toHaveBeenCalled();
  });

  it("lets a dialog, Settings or a menu on top close first", () => {
    const seen: string[] = [];
    const open = { querySelector: (selector: string) => { seen.push(selector); return {} as Element; } };
    expect(escapeLeavesHealth(key("Escape"), open)).toBe(false);
    expect(seen).toEqual([OPEN_ON_TOP]);
    for (const part of ["dialog[open]", '[role="dialog"][aria-modal="true"]', '[role="menu"]', "[data-bot-menu]", "[data-room-menu]"]) expect(OPEN_ON_TOP).toContain(part);
  });

  it("lets the phone drawer use up the Esc that closes it, and only when no modal layer is over the drawer", () => {
    const sidebar = read("../Sidebar.tsx");
    // The drawer's own listener, bound while it is open (the + menu has one of its own above it).
    const at = sidebar.indexOf("if (!open) return;\n    const closeOnEscape = ");
    expect(at).toBeGreaterThan(-1);
    expect(sidebar.slice(at, at + 220)).toContain("takeDrawerEscape(event, document, () => { setPlusOpen(false); onClose(); })");
    expect(sidebar).not.toMatch(/event\.key === "Escape"\) \{ event\.preventDefault\(\); onClose\(\); \}/);
    // and Health then ignores that key
    const onLeave = vi.fn();
    healthEscapeListener(onLeave, () => noDoc)(key("Escape", { defaultPrevented: true }));
    expect(onLeave).not.toHaveBeenCalled();
  });

  it("leaves an Esc that ends an IME composition alone", () => {
    expect(escapeLeavesHealth({ ...key("Escape"), isComposing: true }, noDoc)).toBe(false);
  });

  it("leaves a field's own Esc to the field", () => {
    const input = { closest: (selector: string) => (selector.includes("input") ? {} : null) };
    expect(escapeLeavesHealth(key("Escape", { target: input }), noDoc)).toBe(false);
    expect(escapeLeavesHealth(key("Escape", { target: { isContentEditable: true, closest: () => null } }), noDoc)).toBe(false);
    expect(escapeLeavesHealth(key("Escape", { target: { closest: () => null } }), noDoc)).toBe(true);
  });
});

describe("Back goes where the person came from", () => {
  const state = { bots: [{ id: "b1" } as Bot, { id: "b2" } as Bot], groups: [], needsYouTab: undefined };
  const view = (v: AppState["activeView"], chatId?: string | null) => ({ view: v, chatId });
  it("returns to each view it was opened from", () => {
    expect(healthReturn(view("chat", "b1"), state)).toEqual({ type: "select", id: "b1" });
    expect(healthReturn(view("all-chats"), state)).toEqual({ type: "showAllChats" });
    expect(healthReturn(view("today"), state)).toEqual({ type: "showToday" });
    expect(healthReturn(view("needs-you"), state)).toEqual({ type: "showNeedsYou" });
    expect(healthReturn(view("needs-you"), { ...state, needsYouTab: "results" as AppState["needsYouTab"] })).toEqual({ type: "showNeedsYou", tab: "results" });
    expect(healthReturn(view("routines"), state)).toEqual({ type: "showRoutines" });
    expect(healthReturn(view("team-map"), state)).toEqual({ type: "showTeamMap" });
    expect(healthReturn(view("skill-recorder"), state, true)).toEqual({ type: "showSkillRecorder" });
  });

  it("goes to Today when the origin is not known or is gone", () => {
    expect(healthReturn(undefined, state)).toEqual({ type: "showToday" });
    expect(healthReturn(view("health"), state)).toEqual({ type: "showToday" });
    expect(healthReturn(view("chat", null), state)).toEqual({ type: "showToday" });
    expect(healthReturn(view("skill-recorder"), state, false)).toEqual({ type: "showToday" });
  });

  it("goes to Today, not another chat, when the chat it came from was removed meanwhile", () => {
    // b1 was open when Health opened; it is removed and the selection moves on to b2
    const origin = trackShellOrigins("chat", "health", "b1", { calendar: "chat", health: undefined }).health;
    expect(origin).toEqual({ view: "chat", chatId: "b1" });
    expect(healthReturn(origin, { ...state, bots: [{ id: "b2" } as Bot] })).toEqual({ type: "showToday" });
    expect(healthReturn(origin, state)).toEqual({ type: "select", id: "b1" });
  });

  it("always takes the person off Health", () => {
    for (const v of [undefined, "today", "needs-you", "routines", "all-chats", "team-map", "chat", "health"] as const) {
      expect(reducer(onHealth, healthReturn(v && view(v, "gone"), onHealth)).activeView, String(v)).not.toBe("health");
    }
  });

  it("keeps each page's Back target across a trip between Routines and Health", () => {
    let o: ShellOrigins = { calendar: "chat", health: undefined };
    const walk = (...views: AppState["activeView"][]) => { for (let i = 1; i < views.length; i++) o = trackShellOrigins(views[i - 1], views[i], "b1", o); };
    // Today, Routines, Health, Back to Routines: Routines' Back still goes to Today
    walk("today", "routines", "health", "routines");
    expect(o.calendar).toBe("today");
    expect(o.health?.view).toBe("routines");
    // Today, Health, Routines (rail), Back to Health: Health's Back still goes to Today
    o = { calendar: "chat", health: undefined };
    walk("today", "health", "routines", "health");
    expect(o.health?.view).toBe("today");
    expect(o.calendar).toBe("health");
    // a fresh open from a chat records the chat; All chats sends Routines back to the chat
    o = { calendar: "chat", health: undefined };
    walk("all-chats", "routines");
    expect(o.calendar).toBe("chat");
    walk("routines", "chat", "health");
    expect(o.health).toEqual({ view: "chat", chatId: "b1" });
  });

  it("is wired in App: the origins move with the view and the page gets onLeave", () => {
    const app = read("../../App.tsx");
    expect(app).toContain("<HealthPage onOpenNeedsYou={() => nav.showNeedsYou()} onLeave={leaveHealth} />");
    expect(app).toContain("trackShellOrigins(previousViewRef.current, state.activeView, state.selectedId, { calendar: calendarOriginRef.current, health: healthOriginRef.current });");
    expect(app).toContain("dispatch(healthReturn(healthOriginRef.current, now,");
  });
});

describe("the rail leaves Health", () => {
  it("opens Today, Chats, Needs you and Routines from Health", () => {
    expect(reducer(onHealth, { type: "showToday" }).activeView).toBe("today");
    expect(reducer(onHealth, { type: "showAllChats" }).activeView).toBe("all-chats");
    expect(reducer(onHealth, { type: "showNeedsYou" }).activeView).toBe("needs-you");
    expect(reducer(onHealth, { type: "showRoutines" }).activeView).toBe("routines");
  });

  it("sends each door to its own view, on the rail and in the phone drawer", () => {
    for (const file of ["../../App.tsx", "../Sidebar.tsx"]) {
      const source = read(file);
      const at = source.indexOf("const openDoor = ");
      const door = source.slice(at, source.indexOf("};", at) + 400);
      expect(at, file).toBeGreaterThan(0);
      expect(door, file).toContain('if (door === "today") dispatch({ type: "showToday" });');
      expect(door, file).toContain('else if (door === "chats") dispatch({ type: "showAllChats" });');
      expect(door, file).toContain('else if (door === "needs-you") dispatch({ type: "showNeedsYou" });');
      expect(door, file).toContain('else dispatch({ type: "showRoutines" });');
    }
    expect(read("../Sidebar.tsx")).toContain("onOpen={(door) => { openDoor(door); onNavigate(); }}");
  });
});
