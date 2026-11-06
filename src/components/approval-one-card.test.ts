// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// APPROVAL-ONE-CARD (1.0.15): one place to answer a permission card. The chat
// keeps one line while a card waits; the composer panel says the title once,
// one reason sentence, the command behind "Show command", and the buttons. On
// the phone the panel is a bottom bar and Details opens ONE sheet.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const surface = vi.hoisted(() => ({ desktop: true as boolean | undefined, native: false }));
vi.mock("@/lib/use-surface", () => ({ useDesktopSurface: () => surface.desktop, useSurfaceState: () => ({ desktop: surface.desktop, confirmed: true }) }));
vi.mock("@/lib/native-shell", () => ({ inNativeShell: () => surface.native }));
vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  const store = { state: { bots: [], routines: [], instances: [] }, dispatch: () => undefined };
  return { ...actual, useStore: () => store, useStoreIfAny: () => store };
});

import type { Bot, Message } from "@/state/store";
import type { CardClass } from "../../shared/fold-scopes";
import { cardFoldRows } from "@/lib/fold-words";
import { loadPlainApproval } from "@/lib/plain-approval";
import { ApprovalCard } from "./ApprovalCard";
import { ApprovalDetailsSheet, PendingApprovalActions, PendingApprovalPanel, pendingApprovals, pendingOf, type Pending } from "./PendingApproval";
import { PendingApprovalQueue } from "./PendingApprovalQueue";
import { GrantFold } from "./approval/GrantFold";
import { APPROVAL_PANEL_ATTR, APPROVAL_PANEL_REQUEST_ATTR, focusApprovalPanel, inertOutside, onOpenGrantFold, onSelectApprovalRequest, openGrantFold } from "@/lib/approval-focus";
import { FOCUSABLE_SELECTOR, trapFocus, type TrapDocument } from "@/lib/focus-trap";

beforeAll(() => loadPlainApproval());
afterEach(() => { surface.desktop = true; surface.native = false; });

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const count = (html: string, text: string) => html.split(text).length - 1;

const BOT = { id: "b1", name: "Sable", autoApprove: false, threadId: "t1" } as unknown as Bot;
const COMMAND = "npm run build && rm -rf dist/old && cp -r out dist";
/** The command as rendered markup carries it (& escaped). */
const COMMAND_HTML = COMMAND.replaceAll("&", "&amp;");
const HELD = "This action may be destructive. Review it before allowing it.";
const WHY = { key: "ux.l1.why.unreadCall", params: {} };
const WHY_TEXT = "Murage could not read this whole, so it asks. Allow it once if it is right.";
const cls = (extra: Partial<CardClass>): CardClass => ({ reason: "stop-line", unattended: false, automated: false, keys: [], ...extra });
const PUBLIC = {
  cardClass: cls({ stop: { kind: "message", public: true, placed: true, places: 1 }, keys: ["taskAllowKey", "allowKey"] }),
  taskAllowKey: "stop:public:github:ferrox/murage",
  allowKey: "stop:public:github:ferrox/murage",
};

function message(card: Record<string, unknown> = {}): Message {
  return {
    id: "m1", role: "bot", kind: "options", at: 1, from: { botId: "b1", name: "Sable" },
    card: { title: "Approval", subtitle: COMMAND, options: ["Allow", "Deny"], tool: "Bash", requestId: "req-1", ...card },
  } as unknown as Message;
}
const pending = (card: Record<string, unknown> = {}): Pending => pendingOf(message(card));
const panel = (p: Pending) => renderToStaticMarkup(createElement(PendingApprovalPanel, { pending: p, who: "Sable", bot: BOT, threadId: "t1" }));
const actions = (p: Pending) => renderToStaticMarkup(createElement(PendingApprovalActions, { pending: p, threadId: "t1", bot: BOT, onCancelTurn: () => undefined }));

describe("(1) the waiting chat card is one line", () => {
  it("says who is waiting, with Answer, and no detail body, no held box, no buttons", () => {
    const html = renderToStaticMarkup(createElement(ApprovalCard, { bot: BOT, message: message({ held: HELD, why: WHY }) }));
    expect(html).toContain("Sable is waiting for you.");
    expect(html).toContain("data-approval-answer");
    expect(html).toMatch(/aria-label="Answer: Sable wants to [^"]+"/);
    expect(html).toMatch(/>Answer</);
    expect(html).not.toContain(COMMAND_HTML);
    expect(html).not.toContain(HELD);
    expect(html).not.toContain(WHY_TEXT);
    expect(html).not.toContain("Show details");
    expect(html).not.toContain("Waiting for your answer below");
    expect(html).not.toMatch(/>(Run|Don&#x27;t run|Cancel turn)</);
    expect(count(html, "<button")).toBe(1);
  });
  it("a routine card waiting reads the same one line, never the old pointer", () => {
    const html = renderToStaticMarkup(createElement(ApprovalCard, { bot: BOT, message: message({ tool: "schedule_routine", routineRequest: { version: 1, requestId: "req-1", botId: "b1", threadId: "t1", createdAt: 1, operation: { action: "create", routine: { name: "Backlog" } } } }) }));
    expect(html).toContain("Sable is waiting for you.");
    expect(html).not.toContain("Waiting for your confirmation below");
  });
});

describe("(2) the settled card is the record", () => {
  it.each(["allow", "deny", "unavailable"] as const)("keeps the title and the outcome, with the request behind a closed Show details (%s)", (answered) => {
    const html = renderToStaticMarkup(createElement(ApprovalCard, { bot: BOT, message: message({ answered, held: HELD }) }));
    expect(html).toContain("Sable wants to ");
    expect(html).toContain(answered === "allow" ? "Approved" : answered === "deny" ? "Denied" : "Sable stopped waiting for this. Ask it again.");
    expect(html).toMatch(/<details data-settled-details[^>]*>/);
    expect(html).not.toMatch(/<details data-settled-details[^>]*\sopen/);
    expect(html).toContain(COMMAND_HTML);
    expect(html).not.toContain(HELD);
    expect(html).not.toContain("is waiting for you.");
  });
});

describe("(3) the panel says each thing once", () => {
  it("title once, the why-line once, and the held note only behind Show command when a why-line exists", () => {
    const html = panel(pending({ held: HELD, why: WHY }));
    expect(count(html, "Sable wants to ")).toBe(1);
    expect(count(html, WHY_TEXT)).toBe(1);
    expect(count(html, HELD)).toBe(1);
    expect(html).toMatch(/<details data-approval-fold[^>]*>[\s\S]*data-held-note[\s\S]*<\/details>/);
    expect(html).not.toContain("Pending approval</span>");
    expect(html).not.toMatch(/ of \d+</);
    expect(html).toContain("Show command");
    expect(html).not.toMatch(/<details[^>]*\sopen/);
  });
  it("shows the held note on the panel when there is no why-line, and no why-line then", () => {
    const html = panel(pending({ held: HELD }));
    expect(count(html, HELD)).toBe(1);
    expect(html).not.toContain("data-why-line");
    expect(html).not.toContain("data-held-note");
  });
  it("a card that is not a command folds under Show details", () => {
    const html = panel(pending({ tool: "WebFetch", subtitle: "https://example.com/report" }));
    expect(html).toContain("Show details");
    expect(html).not.toContain("Show command");
  });
  it("the why-line ends with Stop asking for this when a fold exists, and it opens that card's fold", () => {
    const html = panel(pending({ tool: "other", subtitle: "post", ...PUBLIC, why: { key: "ux.l1.why.messagePublic", params: { bot: "Sable", where: "github:ferrox/murage" } } }));
    expect(html).toContain("data-stop-asking");
    const heard: string[] = [];
    const off = onOpenGrantFold((id) => heard.push(id));
    openGrantFold("req-1");
    off();
    openGrantFold("req-2");
    expect(heard).toEqual(["req-1"]);
  });
});

describe("(4) the phone bar and its one Details sheet", () => {
  it("the bar has no height cap, no command, and Details, Don't run and Run", () => {
    surface.desktop = false; surface.native = true;
    const p = pending({ tool: "other", subtitle: "post", ...PUBLIC, why: WHY });
    const queue = renderToStaticMarkup(createElement(PendingApprovalQueue, { approvals: [p], threadId: "t1", botFor: () => BOT, whoFor: () => "Sable", onCancelTurn: () => undefined }));
    expect(queue).toContain('data-approval-queue="bar"');
    expect(queue).not.toContain("max-h-[70dvh]");
    expect(queue).toContain(WHY_TEXT);
    expect(queue).toMatch(/>Details</);
    expect(queue).not.toContain("data-fold-link");
    expect(queue).not.toContain("data-fold-caret");
    expect(queue).not.toContain("Show command");
    expect(queue).not.toContain("Show details");
    // the desktop keeps its cap
    surface.desktop = true; surface.native = false;
    const desk = renderToStaticMarkup(createElement(PendingApprovalQueue, { approvals: [p], threadId: "t1", botFor: () => BOT, whoFor: () => "Sable", onCancelTurn: () => undefined }));
    expect(desk).toContain("max-h-[70dvh]");
  });
  it("Details opens one sheet holding the plain lines, the command and the fold rows", () => {
    const p = pending({ tool: "Bash", subtitle: COMMAND, ...PUBLIC });
    const rows = cardFoldRows(p.message.card);
    expect(rows.length).toBeGreaterThan(0);
    const fold = createElement(GrantFold, { id: "f", rows, bot: "Sable", level: "Ask", verb: "Run", desktop: false, variant: "menu", busy: null, autoFocus: false, onChoose: () => undefined, onClose: () => undefined });
    const html = renderToStaticMarkup(createElement(ApprovalDetailsSheet, { pending: p, bot: "Sable", fold, foot: createElement("button", null, "Run"), onClose: () => undefined }));
    expect(count(html, 'role="dialog"')).toBe(1);
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("What Sable wants to do");
    expect(html).toContain(COMMAND_HTML);
    expect(html).not.toContain("<details");
    expect(html).toContain("Run, and stop asking");
    expect(html).toContain("data-fold-row");
    expect(html).toContain('data-grant-fold="menu"');
    expect(html).not.toContain('data-grant-fold="sheet"');
  });
  it("the sheet takes the fold as the menu variant, never a sheet inside the sheet", () => {
    const source = read("./PendingApproval.tsx");
    expect(source).toContain('fold={hasFold ? foldChunk("menu", closeSheet, false) : undefined}');
    // closing the sheet hands focus back to Details
    expect(source).toContain("detailsButton.current?.focus()");
  });
});

describe("(5) Answer focuses the panel's region, never a button", () => {
  it("the region takes focus and carries the marker; the chat button calls focusApprovalPanel", () => {
    const html = panel(pending());
    expect(html).toMatch(new RegExp(`<div role="region" aria-label="Pending approval" tabindex="-1" ${APPROVAL_PANEL_ATTR}="panel"`));
    expect(read("./ApprovalCard.tsx")).toContain("onClick={() => focusApprovalPanel(message.card?.requestId)}");
  });
  it("focusApprovalPanel focuses the element marked as the panel", () => {
    const focus = vi.fn();
    const seen: string[] = [];
    const root = { querySelector: (selector: string) => { seen.push(selector); return { focus, scrollIntoView: () => undefined }; } } as unknown as ParentNode;
    expect(focusApprovalPanel(undefined, root)).toBe(true);
    expect(seen).toEqual([`[${APPROVAL_PANEL_ATTR}]`]);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(focusApprovalPanel(undefined, { querySelector: () => null } as unknown as ParentNode)).toBe(false);
  });
  it("the buttons stay in their order: Cancel turn, Don't run, Run, caret", () => {
    // a command with a fold, so the caret is there too
    const html = actions(pending({ tool: "Bash", subtitle: "rm -rf /Users/ada/Projects/site/build", cardClass: cls({ stop: { kind: "delete", public: false, placed: true, places: 1 }, keys: ["taskAllowKey", "allowKey"] }), taskAllowKey: "stop:delete:/Users/ada/Projects/site/build", allowKey: "stop:delete:/Users/ada/Projects/site/build" }));
    const at = (text: string) => html.indexOf(text);
    for (const text of [">Cancel turn<", "Don&#x27;t ", "data-approval-primary", "data-fold-caret"]) expect(at(text), text).toBeGreaterThan(-1);
    expect(at(">Cancel turn<")).toBeLessThan(at("Don&#x27;t "));
    expect(at("Don&#x27;t ")).toBeLessThan(at("data-approval-primary"));
    expect(at("data-approval-primary")).toBeLessThan(at("data-fold-caret"));
  });
});

describe("(6) the composer hides the textarea while a card waits", () => {
  it("hides the textarea, the controls and the plus menu, and drops the pointer placeholders", () => {
    const composer = read("./Composer.tsx");
    expect(composer).toContain("hidden={Boolean(approval)}");
    // TODAY's compact Tell box adds a class after it (its selector holds parentheses), so match to the end of the line
    expect(composer).toMatch(/data-composer-controls className=\{cn\([^\n]*approval && "hidden"[^\n]*\)\}>/);
    expect(composer).toContain("phoneComposer && !locked && !approval && (");
    expect(composer).not.toContain("Answer the approval above to continue");
    expect(composer).not.toContain("Answer the requests above to continue");
  });
  it("comes back on every settle path: the card leaves the waiting list when answered, stopped or dismissed", () => {
    expect(pendingApprovals([message()])).toHaveLength(1);
    for (const settled of [{ answered: "allow" }, { answered: "deny" }, { answered: "unavailable" }, { dismissed: true }]) {
      expect(pendingApprovals([message(settled)]), JSON.stringify(settled)).toHaveLength(0);
    }
  });
});

// Astra r1 (9e5cf04d): M1 Answer selects its own request, M2 the sheet holds
// the keyboard and the bar behind it is inert, M3 the sheet says the reason,
// L1 every settled record keeps its request behind the closed fold.

// A DOM small enough to read, for the focus trap and inertOutside: elements
// know their parent, focus sets the document's activeElement.
class FakeDoc {
  activeElement: unknown = null;
  listeners = { keydown: new Set<(event: never) => void>(), focusin: new Set<(event: never) => void>() };
  addEventListener(type: "keydown" | "focusin", listener: (event: never) => void) { this.listeners[type].add(listener); }
  removeEventListener(type: "keydown" | "focusin", listener: (event: never) => void) { this.listeners[type].delete(listener); }
  querySelector() { return null; }
  key(key: string, shiftKey = false) {
    const event = { key, shiftKey, defaultPrevented: false, preventDefault: () => { event.defaultPrevented = true; }, stopPropagation: () => undefined };
    for (const listener of [...this.listeners.keydown]) listener(event as never);
    return event;
  }
  /** Tab as the browser does it when nothing prevents it: the next control in the page. */
  tab(order: FakeEl[], shiftKey = false) {
    const event = this.key("Tab", shiftKey);
    if (event.defaultPrevented) return;
    const live = order.filter((el) => !el.closest("[inert]"));
    const at = live.indexOf(this.activeElement as FakeEl);
    live[(at + (shiftKey ? -1 : 1) + live.length) % live.length]!.focus();
  }
  moveFocus(target: FakeEl) {
    target.focus();
    for (const listener of [...this.listeners.focusin]) listener({ target } as never);
  }
}
class FakeEl {
  children: FakeEl[] = [];
  parentElement: FakeEl | null = null;
  attrs: Record<string, string> = {};
  isConnected = true;
  focused = 0;
  constructor(private readonly doc: FakeDoc, readonly name: string, readonly control = false) {}
  focus() { this.focused += 1; this.doc.activeElement = this; }
  add(...kids: FakeEl[]) { for (const kid of kids) { kid.parentElement = this; this.children.push(kid); } return this; }
  closest(selector: string): FakeEl | null {
    const attr = /^\[([a-z-]+)\]$/.exec(selector)?.[1];
    for (let at: FakeEl | null = this; at; at = at.parentElement) if (attr && attr in at.attrs) return at;
    return null;
  }
  hasAttribute(name: string) { return name in this.attrs; }
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
  removeAttribute(name: string) { delete this.attrs[name]; }
  getAttribute(name: string) { return this.attrs[name] ?? null; }
  matches() { return false; }
  getClientRects() { return { length: 1 }; }
  contains(node: unknown): boolean {
    for (let at = node as FakeEl | null; at; at = at.parentElement) if (at === this) return true;
    return false;
  }
  querySelectorAll(selector: string): FakeEl[] {
    const out: FakeEl[] = [];
    const walk = (el: FakeEl) => { for (const kid of el.children) { if (selector === FOCUSABLE_SELECTOR ? kid.control : kid.attrs[selector.replace(/^\[|\]$/g, "")] !== undefined) out.push(kid); walk(kid); } };
    walk(this);
    return out;
  }
}

describe("(7) Astra r1: Answer, the sheet's keyboard, the sheet's reason, the settled record", () => {
  it("M1: Answer selects its own request first, then focuses the panel showing it", () => {
    const order: string[] = [];
    const off = onSelectApprovalRequest((id) => order.push(`select:${id}`));
    const seen: string[] = [];
    const root = { querySelector: (selector: string) => { seen.push(selector); return { focus: () => order.push("focus"), scrollIntoView: () => undefined }; } } as unknown as ParentNode;
    expect(focusApprovalPanel("req-2", root)).toBe(true);
    off();
    expect(order).toEqual(["select:req-2", "focus"]);
    expect(seen).toEqual([`[${APPROVAL_PANEL_ATTR}][${APPROVAL_PANEL_REQUEST_ATTR}="req-2"]`]);
    // no panel shows that request: nothing takes focus, never another request's panel
    const other: string[] = [];
    const elsewhere = { querySelector: (selector: string) => { other.push(selector); return selector.includes(APPROVAL_PANEL_REQUEST_ATTR) ? null : { focus: () => order.push("wrong"), scrollIntoView: () => undefined }; } } as unknown as ParentNode;
    expect(focusApprovalPanel("req-9", elsewhere)).toBe(false);
    expect(order).not.toContain("wrong");
    expect(other).toHaveLength(1);
    // the panel names the request it shows, and the queue selects by the id it is given
    expect(panel(pending())).toContain(`${APPROVAL_PANEL_REQUEST_ATTR}="req-1"`);
    const queue = read("./PendingApprovalQueue.tsx");
    expect(queue).toContain("onSelectApprovalRequest((id) =>");
    expect(queue).toContain("selection.current = selectRequest(selection.current, live.current, id);");
    expect(queue).toContain("flushSync(rerender)");
  });

  it("M2: Tab and Shift+Tab stay in the sheet, and the bar's Run behind it is unreachable", () => {
    const doc = new FakeDoc();
    // queue > [panel > stop-asking, wrapper > group > [Details, Don't run, Run, backdrop > dialog > [Close, fold row, Don't run, Run]]]
    const queue = new FakeEl(doc, "queue");
    const stopAsking = new FakeEl(doc, "stop-asking", true);
    const panelEl = new FakeEl(doc, "panel").add(stopAsking);
    const details = new FakeEl(doc, "details", true);
    const barDeny = new FakeEl(doc, "bar-deny", true);
    const barRun = new FakeEl(doc, "bar-run", true);
    const close = new FakeEl(doc, "close", true);
    close.attrs["data-sheet-close"] = "";
    const foldRow = new FakeEl(doc, "fold-row", true);
    const sheetDeny = new FakeEl(doc, "sheet-deny", true);
    const sheetRun = new FakeEl(doc, "sheet-run", true);
    const dialog = new FakeEl(doc, "dialog").add(new FakeEl(doc, "title"), close, foldRow, sheetDeny, sheetRun);
    const backdrop = new FakeEl(doc, "backdrop").add(dialog);
    const group = new FakeEl(doc, "group").add(details, barDeny, barRun, backdrop);
    queue.add(panelEl, new FakeEl(doc, "wrapper").add(group));
    const pageOrder = [stopAsking, details, barDeny, barRun, close, foldRow, sheetDeny, sheetRun];
    details.focus();

    const undo = inertOutside(backdrop as never, queue as never);
    const trap = trapFocus(dialog as never, { initialFocus: "[data-sheet-close]", skipReturnFocus: true, doc: doc as unknown as TrapDocument });
    try {
      expect(doc.activeElement).toBe(close);
      for (const el of [details, barDeny, barRun, panelEl]) expect(el.hasAttribute("inert"), el.name).toBe(true);
      expect(dialog.closest("[inert]")).toBeNull();
      // Shift+Tab from Close wraps to the sheet's own last control, never the bar's Run
      doc.tab(pageOrder, true);
      expect(doc.activeElement).toBe(sheetRun);
      // Tab from the last control wraps back to Close
      doc.tab(pageOrder);
      expect(doc.activeElement).toBe(close);
      // a full lap each way stays inside
      for (const shift of [false, true]) {
        for (let i = 0; i < 6; i += 1) {
          doc.tab(pageOrder, shift);
          expect(dialog.contains(doc.activeElement), `${shift ? "Shift+" : ""}Tab ${i}`).toBe(true);
        }
      }
      // focus pushed behind the sheet comes straight back in
      doc.moveFocus(barRun);
      expect(dialog.contains(doc.activeElement)).toBe(true);
      expect(doc.activeElement).not.toBe(barRun);
    } finally {
      trap.release();
      undo();
    }
    // closing gives the bar back
    for (const el of [details, barDeny, barRun, panelEl]) expect(el.hasAttribute("inert"), el.name).toBe(false);
    // the sheet wires both: the shared trap on the dialog and the inert queue around it
    const source = read("./PendingApproval.tsx");
    expect(source).toContain('useFocusTrap(dialog, true, { initialFocus: "[data-sheet-close]", onEscape: onClose, skipReturnFocus: true });');
    expect(source).toContain('inertOutside(node as unknown as InertNode, node.closest("[data-approval-queue]")');
  });

  it("M2: inertOutside leaves what was inert before, and clears only what it set", () => {
    const doc = new FakeDoc();
    const already = new FakeEl(doc, "already");
    already.attrs.inert = "";
    const other = new FakeEl(doc, "other");
    const target = new FakeEl(doc, "target");
    const stop = new FakeEl(doc, "stop").add(already, other, target);
    const outside = new FakeEl(doc, "outside");
    new FakeEl(doc, "root").add(stop, outside);
    const undo = inertOutside(target as never, stop as never);
    expect(other.hasAttribute("inert")).toBe(true);
    expect(outside.hasAttribute("inert")).toBe(false);
    undo();
    expect(other.hasAttribute("inert")).toBe(false);
    expect(already.hasAttribute("inert")).toBe(true);
  });

  const sheet = (p: Pending) => renderToStaticMarkup(createElement(ApprovalDetailsSheet, { pending: p, bot: "Sable", foot: createElement("button", null, "Run"), onClose: () => undefined }));
  it("M3: the sheet says the why-line and the full held note, always", () => {
    const both = sheet(pending({ held: HELD, why: WHY }));
    expect(count(both, WHY_TEXT)).toBe(1);
    expect(count(both, HELD)).toBe(1);
    // held with no why-line: the held note is still there, in full
    const heldOnly = sheet(pending({ held: HELD }));
    expect(count(heldOnly, HELD)).toBe(1);
    expect(heldOnly).not.toContain("data-why-line");
    const long = `${HELD} ${"Read every line of it first. ".repeat(40)}`.trim();
    expect(sheet(pending({ held: long }))).toContain(long);
    // a card read in its own words keeps its held note too
    expect(sheet(pending({ tool: "local_computer_consent", subtitle: "Sable asks to use this computer.", held: HELD }))).toContain(HELD);
    expect(sheet(pending({ tool: "browser_extension_action", subtitle: "Send the email", held: HELD }))).toContain(HELD);
    // the why-line alone
    expect(sheet(pending({ why: WHY }))).toContain(WHY_TEXT);
  });

  it("L1: a settled computer-use question and a settled browser action sit behind the closed Show details", () => {
    for (const card of [
      { tool: "local_computer_consent", subtitle: "Sable asks to use this computer for this chat." },
      { tool: "browser_extension_action", title: "Send an email", subtitle: "Send the email to ada@example.com" },
    ]) {
      const html = renderToStaticMarkup(createElement(ApprovalCard, { bot: BOT, message: message({ ...card, answered: "allow" }) }));
      const fold = /<details data-settled-details[^>]*>([\s\S]*?)<\/details>/.exec(html);
      expect(fold, card.tool).not.toBeNull();
      expect(fold![0]).not.toMatch(/<details data-settled-details[^>]*\sopen/);
      expect(fold![1], card.tool).toContain(card.subtitle);
      expect(html.replace(fold![0], ""), card.tool).not.toContain(card.subtitle);
    }
  });
});
