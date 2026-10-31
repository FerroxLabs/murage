// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The local-only Undo host (handoffs/UNDO-HOST-DESIGN.md section 8): the 8 s
// window, holds and the 2 s floor, newer offers, page hide, Esc, the key
// guards and notices. It never sends a request, so there are no server rows.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UNDO_NOTICE_MS,
  UNDO_RESUME_FLOOR_MS,
  UNDO_WINDOW_MS,
  connectUndoHost,
  createUndoHost,
  isEditableTarget,
  undoEscHandled,
  undoKeyHandled,
  type LocalOp,
  type UndoEscInput,
  type UndoKeyInput,
} from "./undo";

const local = (over: Partial<LocalOp> = {}): LocalOp => ({ kind: "local", key: "tip:x", message: "Tip hidden.", undo: vi.fn(), ...over });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the window", () => {
  it("shows the offer for 8 seconds, then closes with the change standing", () => {
    const host = createUndoHost();
    const op = local();
    host.offerUndo(op);
    vi.advanceTimersByTime(UNDO_WINDOW_MS - 1);
    expect(host.view()).toMatchObject({ message: "Tip hidden.", canUndo: true, detail: null });
    vi.advanceTimersByTime(1);
    expect(host.view()).toBeNull();
    expect(host.undo()).toBe(false);
    expect(op.undo).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("runs the local undo once and closes; a second Undo does nothing", () => {
    const host = createUndoHost();
    const op = local();
    const { id } = host.offerUndo(op);
    expect(host.undo(id)).toBe(true);
    expect(host.undo(id)).toBe(false);
    expect(host.undo()).toBe(false);
    expect(op.undo).toHaveBeenCalledTimes(1);
    expect(host.view()).toBeNull();
  });

  it("refuses an Undo past the deadline even when the timer has not fired yet (a throttled or woken page)", () => {
    const host = createUndoHost();
    const op = local();
    host.offerUndo(op);
    vi.setSystemTime(Date.now() + UNDO_WINDOW_MS + 500);
    expect(host.hasOpen()).toBe(false);
    expect(host.undo()).toBe(false);
    expect(op.undo).not.toHaveBeenCalled();
  });

  it("acts once when Undo and the timer land in the same tick", () => {
    const host = createUndoHost();
    const op = local();
    const { id } = host.offerUndo(op);
    vi.setSystemTime(Date.now() + UNDO_WINDOW_MS);
    expect(host.undo(id)).toBe(false);
    vi.runOnlyPendingTimers();
    expect(op.undo).not.toHaveBeenCalled();
    expect(host.view()).toBeNull();
  });

  it("takes its own length, and refuses a length that is not a positive number", () => {
    const host = createUndoHost();
    host.offerUndo(local({ ms: 3000 }));
    vi.advanceTimersByTime(3000);
    expect(host.view()).toBeNull();
    expect(() => host.offerUndo(local({ ms: 0 }))).toThrow(TypeError);
    expect(() => host.offerUndo(local({ ms: Number.NaN }))).toThrow(TypeError);
  });

  it("settle() ends the window at once and is a no-op afterwards", () => {
    const host = createUndoHost();
    const op = local();
    const handle = host.offerUndo(op);
    handle.settle();
    expect(host.view()).toBeNull();
    handle.settle();
    expect(host.undo()).toBe(false);
    expect(op.undo).not.toHaveBeenCalled();
  });
});

describe("pause on hover or focus", () => {
  it("holds the window while the pointer is over the toast, and resumes with at least 2 seconds", () => {
    const host = createUndoHost();
    host.offerUndo(local());
    vi.advanceTimersByTime(7000);
    host.setHold("pointer", true);
    vi.advanceTimersByTime(60_000);
    expect(host.hasOpen()).toBe(true);
    host.setHold("pointer", false);
    vi.advanceTimersByTime(UNDO_RESUME_FLOOR_MS - 1);
    expect(host.hasOpen()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(host.hasOpen()).toBe(false);
  });

  it("resumes with the time that was left when that is more than the floor", () => {
    const host = createUndoHost();
    host.offerUndo(local());
    vi.advanceTimersByTime(2000);
    host.setHold("focus", true);
    vi.advanceTimersByTime(30_000);
    host.setHold("focus", false);
    vi.advanceTimersByTime(5999);
    expect(host.hasOpen()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(host.hasOpen()).toBe(false);
  });

  it("stays held while focus is still inside after the pointer leaves", () => {
    const host = createUndoHost();
    host.offerUndo(local());
    host.setHold("pointer", true);
    host.setHold("focus", true);
    host.setHold("pointer", false);
    vi.advanceTimersByTime(60_000);
    expect(host.hasOpen()).toBe(true);
  });

  it("does not hold while the page is hidden", () => {
    const host = createUndoHost();
    host.offerUndo(local());
    host.setHold("pointer", true);
    host.setPageVisible(false);
    vi.advanceTimersByTime(UNDO_WINDOW_MS);
    expect(host.hasOpen()).toBe(false);
  });

  it("a hold that comes after the deadline does not reopen the window", () => {
    const host = createUndoHost();
    host.offerUndo(local());
    vi.setSystemTime(Date.now() + UNDO_WINDOW_MS);
    host.setHold("pointer", true);
    expect(host.hasOpen()).toBe(false);
  });

  for (const reason of ["pointer", "focus"] as const) {
    it(`a late ${reason} hold for a card that already went does not pause the next offer`, () => {
      const host = createUndoHost();
      host.offerUndo(local({ message: "First." }));
      vi.setSystemTime(Date.now() + UNDO_WINDOW_MS);
      host.setHold(reason, true);
      expect(host.view()).toBeNull();
      host.offerUndo(local({ message: "Second." }));
      vi.advanceTimersByTime(UNDO_WINDOW_MS - 1);
      expect(host.hasOpen()).toBe(true);
      vi.advanceTimersByTime(1);
      expect(host.hasOpen()).toBe(false);
    });

    it(`a ${reason} hold on a hidden card is dropped, so the offer still ends on time`, () => {
      const host = createUndoHost();
      host.offerUndo(local());
      host.dismiss();
      host.setHold(reason, true);
      vi.advanceTimersByTime(UNDO_WINDOW_MS);
      expect(host.hasOpen()).toBe(false);
    });
  }
});

describe("a newer offer", () => {
  it("ends the older one first: its Undo is gone and its undo never runs", () => {
    const host = createUndoHost();
    const first = local({ key: "tip:a", message: "First." });
    const second = local({ key: "tip:b", message: "Second." });
    const a = host.offerUndo(first);
    const b = host.offerUndo(second);
    expect(host.view()).toMatchObject({ id: b.id, message: "Second.", canUndo: true });
    expect(host.undo(a.id)).toBe(false);
    expect(host.undo()).toBe(true);
    expect(first.undo).not.toHaveBeenCalled();
    expect(second.undo).toHaveBeenCalledTimes(1);
  });

  for (const reason of ["pointer", "focus"] as const) {
    it(`keeps a ${reason} hold: the card never blanks, so the new window stays held`, () => {
      const host = createUndoHost();
      const seen: (number | null)[] = [];
      host.subscribe(() => seen.push(host.view()?.id ?? null));
      host.offerUndo(local({ message: "First." }));
      host.setHold(reason, true);
      const b = host.offerUndo(local({ message: "Second." }));
      expect(seen).not.toContain(null);
      vi.advanceTimersByTime(60_000);
      expect(host.view()).toMatchObject({ id: b.id, message: "Second.", canUndo: true });
      host.setHold(reason, false);
      vi.advanceTimersByTime(UNDO_WINDOW_MS - 1);
      expect(host.hasOpen()).toBe(true);
      vi.advanceTimersByTime(1);
      expect(host.hasOpen()).toBe(false);
    });
  }

  it("gets its own full window", () => {
    const host = createUndoHost();
    host.offerUndo(local());
    vi.advanceTimersByTime(6000);
    host.offerUndo(local());
    vi.advanceTimersByTime(UNDO_WINDOW_MS - 1);
    expect(host.hasOpen()).toBe(true);
  });
});

describe("the page going away", () => {
  it("ends an open offer on pagehide: no Undo afterwards and nothing left to fire", () => {
    const host = createUndoHost();
    const op = local();
    host.offerUndo(op);
    host.onPageHide();
    expect(host.view()).toBeNull();
    expect(host.undo()).toBe(false);
    vi.advanceTimersByTime(UNDO_WINDOW_MS * 2);
    expect(op.undo).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Esc and X", () => {
  it("hide the toast only: the offer keeps its deadline and Cmd/Ctrl+Z still reaches it", () => {
    const host = createUndoHost();
    const op = local();
    host.offerUndo(op);
    host.dismiss();
    expect(host.view()).toBeNull();
    expect(host.hasOpen()).toBe(true);
    expect(host.undo()).toBe(true);
    expect(op.undo).toHaveBeenCalledTimes(1);
  });

  it("a hidden offer still closes at its deadline, and a hold from before the hide is released", () => {
    const host = createUndoHost();
    host.offerUndo(local());
    vi.advanceTimersByTime(7000);
    host.setHold("pointer", true);
    host.dismiss();
    vi.advanceTimersByTime(UNDO_RESUME_FLOOR_MS);
    expect(host.hasOpen()).toBe(false);
  });
});

describe("notices", () => {
  it("say why a local undo failed, and re-show a toast that Esc hid", () => {
    const host = createUndoHost();
    host.offerUndo(local({ undo: () => { throw new Error("The tip list is closed"); } }));
    host.dismiss();
    expect(host.undo()).toBe(false);
    expect(host.view()).toMatchObject({ message: "Tip hidden.", canUndo: false, detail: "Could not undo: The tip list is closed" });
    vi.advanceTimersByTime(UNDO_NOTICE_MS);
    expect(host.view()).toBeNull();
  });

  it("use plain words when the failure has no message", () => {
    const host = createUndoHost();
    host.offerUndo(local({ undo: () => { throw new Error(""); } }));
    host.undo();
    expect(host.view()?.detail).toBe("Could not undo: That did not go through");
  });

  it("stack under a newer offer instead of replacing its Undo", () => {
    const host = createUndoHost();
    host.offerUndo(local({ message: "First.", undo: () => { throw new Error("gone"); } }));
    host.undo();
    const b = host.offerUndo(local({ message: "Second." }));
    expect(host.view()).toMatchObject({ id: b.id, message: "Second.", canUndo: true, detail: null, extra: [{ text: "Could not undo: gone" }] });
  });

  it("tell listeners about every change", () => {
    const host = createUndoHost();
    const listener = vi.fn();
    const off = host.subscribe(listener);
    host.offerUndo(local());
    host.dismiss();
    off();
    host.undo();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("offerUndo is local only (P3)", () => {
  const shapes: [string, unknown][] = [
    ["apply", { apply: async () => ({ revision: "r" }) }],
    ["commit", { commit: async () => undefined }],
    ["revision", { revision: "r1" }],
    ["check", { check: async () => "absent" }],
    ["prepare", { prepare: () => 1 }],
    ["a server kind", { kind: "delete" }],
    ["an async undo", { undo: async () => undefined }],
    ["no undo", { undo: undefined }],
  ];
  for (const [name, extra] of shapes) {
    it(`throws on ${name}, and shows nothing`, () => {
      const host = createUndoHost();
      expect(() => host.offerUndo({ ...local(), ...(extra as object) } as LocalOp)).toThrow(TypeError);
      expect(host.view()).toBeNull();
    });
  }

  it("throws without a key or a message", () => {
    const host = createUndoHost();
    expect(() => host.offerUndo(local({ key: "" }))).toThrow(TypeError);
    expect(() => host.offerUndo(local({ message: " " }))).toThrow(TypeError);
  });

  const thenables: [string, () => unknown][] = [
    ["a resolving promise", () => Promise.resolve()],
    ["a rejecting promise", () => Promise.reject(new Error("server said no"))],
    ["a fetch-shaped promise", () => new Promise(() => undefined)],
    // A thenable on purpose: the host must refuse it like a promise.
    // oxlint-disable-next-line unicorn/no-thenable
    ["a plain thenable", () => ({ then: () => undefined })],
  ];
  for (const [name, make] of thenables) {
    it(`a plain function that returns ${name} is not undone: "Could not undo", never success`, async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const host = createUndoHost();
      const { id } = host.offerUndo(local({ undo: make as () => void }));
      expect(host.undo(id)).toBe(false);
      expect(host.view()).toMatchObject({ id, canUndo: false, detail: "Could not undo: That did not go through" });
      expect(host.hasOpen()).toBe(false);
      expect(host.undo(id)).toBe(false);
      expect(error).toHaveBeenCalledTimes(1);
      // Let a rejection settle: it is caught, so vitest sees no unhandled error.
      await Promise.resolve();
      await Promise.resolve();
      expect(host.view()?.detail).toBe("Could not undo: That did not go through");
    });
  }

  it("never touches the network", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const host = createUndoHost();
      host.offerUndo(local());
      host.undo();
      host.offerUndo(local());
      vi.advanceTimersByTime(UNDO_WINDOW_MS);
      host.onPageHide();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("the action button", () => {
  it("ends the window, then runs; Undo is gone afterwards", () => {
    const host = createUndoHost();
    const order: string[] = [];
    const op = local({ action: { label: "Open tips", run: () => order.push(host.hasOpen() ? "open" : "closed") } });
    const { id } = host.offerUndo(op);
    expect(host.view()?.action?.label).toBe("Open tips");
    expect(host.runAction(id)).toBe(true);
    expect(order).toEqual(["closed"]);
    expect(host.runAction(id)).toBe(false);
    expect(host.undo()).toBe(false);
  });
});

const key = (over: Partial<UndoKeyInput> = {}): UndoKeyInput => ({
  key: "z", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, repeat: false, isComposing: false, defaultPrevented: false, inEditable: false, modalOpen: false, hasOpen: true, ...over,
});

describe("undoKeyHandled (F2)", () => {
  const rows: [string, Partial<UndoKeyInput>, boolean][] = [
    ["Cmd+Z", {}, true],
    ["Ctrl+Z", { metaKey: false, ctrlKey: true }, true],
    ["Cmd+Z with caps lock", { key: "Z" }, true],
    ["plain Z", { metaKey: false }, false],
    ["Cmd+Shift+Z (redo)", { shiftKey: true }, false],
    ["Cmd+Alt+Z", { altKey: true }, false],
    ["a held key", { repeat: true }, false],
    ["while composing", { isComposing: true }, false],
    ["already handled", { defaultPrevented: true }, false],
    ["in a field with text", { inEditable: true }, false],
    ["in an empty field", { inEditable: true }, false],
    ["with a dialog open", { modalOpen: true }, false],
    ["with nothing to undo", { hasOpen: false }, false],
    ["another key", { key: "y" }, false],
  ];
  for (const [name, over, handled] of rows) {
    it(`${name}: ${handled ? "handled" : "left alone"}`, () => expect(undoKeyHandled(key(over))).toBe(handled));
  }
});

const esc = (over: Partial<UndoEscInput> = {}): UndoEscInput => ({
  key: "Escape", isComposing: false, defaultPrevented: false, inEditable: false, modalOpen: false, inToast: false, showing: true, ...over,
});

describe("undoEscHandled", () => {
  const rows: [string, Partial<UndoEscInput>, boolean][] = [
    ["Esc on the page", {}, true],
    ["Esc inside the toast", { inToast: true }, true],
    ["Esc inside the toast with a dialog open", { inToast: true, modalOpen: true }, true],
    ["Esc with a dialog open", { modalOpen: true }, false],
    ["Esc in a field", { inEditable: true }, false],
    ["Esc already handled", { defaultPrevented: true }, false],
    ["Esc while composing", { isComposing: true }, false],
    ["Esc with no toast", { showing: false }, false],
    ["another key", { key: "Enter" }, false],
  ];
  for (const [name, over, handled] of rows) {
    it(`${name}: ${handled ? "hides" : "left alone"}`, () => expect(undoEscHandled(esc(over))).toBe(handled));
  }
});

describe("isEditableTarget", () => {
  const el = (tagName: string, isContentEditable = false) => ({ tagName, isContentEditable }) as unknown as Element;
  it("counts inputs, textareas, selects and contenteditable, and nothing else", () => {
    expect(isEditableTarget(el("INPUT"))).toBe(true);
    expect(isEditableTarget(el("TEXTAREA"))).toBe(true);
    expect(isEditableTarget(el("SELECT"))).toBe(true);
    expect(isEditableTarget(el("DIV", true))).toBe(true);
    expect(isEditableTarget(el("BUTTON"))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe("connectUndoHost", () => {
  function fakePage() {
    const win = new EventTarget() as EventTarget & { document: unknown };
    const doc = new EventTarget() as EventTarget & { activeElement: unknown; visibilityState: string; querySelector: (s: string) => unknown };
    doc.activeElement = { tagName: "BODY", isContentEditable: false };
    doc.visibilityState = "visible";
    let modal = false;
    doc.querySelector = () => (modal ? {} : null);
    win.document = doc;
    const keydown = (init: Partial<KeyboardEvent>) => {
      const event = Object.assign(new Event("keydown", { cancelable: true }), { key: "z", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, repeat: false, isComposing: false, ...init });
      win.dispatchEvent(event);
      return event;
    };
    return { win: win as unknown as Window, doc, keydown, setModal: (on: boolean) => (modal = on) };
  }

  it("Cmd+Z off a field runs Undo and prevents the default; in a field it is left to the field", () => {
    const page = fakePage();
    const host = createUndoHost();
    const off = connectUndoHost(page.win, host, () => null);
    const op = local();
    host.offerUndo(op);
    page.doc.activeElement = { tagName: "TEXTAREA", isContentEditable: false };
    expect(page.keydown({}).defaultPrevented).toBe(false);
    expect(op.undo).not.toHaveBeenCalled();
    page.setModal(true);
    page.doc.activeElement = { tagName: "BODY", isContentEditable: false };
    expect(page.keydown({}).defaultPrevented).toBe(false);
    page.setModal(false);
    expect(page.keydown({}).defaultPrevented).toBe(true);
    expect(op.undo).toHaveBeenCalledTimes(1);
    off();
  });

  it("Esc hides the toast without preventing the default", () => {
    const page = fakePage();
    const host = createUndoHost();
    const off = connectUndoHost(page.win, host, () => null);
    host.offerUndo(local());
    expect(page.keydown({ key: "Escape", metaKey: false }).defaultPrevented).toBe(false);
    expect(host.view()).toBeNull();
    expect(host.hasOpen()).toBe(true);
    off();
  });

  it("pagehide ends the offer and a hidden page does not hold it; removing the listeners stops both", () => {
    const page = fakePage();
    const host = createUndoHost();
    const off = connectUndoHost(page.win, host, () => null);
    host.offerUndo(local());
    page.win.dispatchEvent(new Event("pagehide"));
    expect(host.hasOpen()).toBe(false);

    host.offerUndo(local());
    host.setHold("pointer", true);
    page.doc.visibilityState = "hidden";
    page.doc.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(UNDO_WINDOW_MS);
    expect(host.hasOpen()).toBe(false);

    off();
    page.doc.visibilityState = "visible";
    host.offerUndo(local());
    page.win.dispatchEvent(new Event("pagehide"));
    expect(host.hasOpen()).toBe(true);
  });
});
