// On a phone the Return key is how you start a new line; the arrow button is
// how you send (spec §3.6). Sending on Return meant every attempt at a
// two-line message went out as one line and a stray second message.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { enterSends, imeComposing } from "./composer-enter";
import { SEND_KEY_SETTLED_STORAGE, SEND_KEY_STORAGE, defaultSendKey, resolveSendKey, sendKeyName, settleSendKeyForUpgrade } from "./send-key";

const key = (over: Partial<Parameters<typeof enterSends>[0]> = {}) => ({
  key: "Enter", shiftKey: false, metaKey: false, ctrlKey: false, isComposing: false, ...over,
});

describe("what Enter does", () => {
  it("sends with a mouse and keyboard, and Shift+Enter is a newline — unchanged", () => {
    expect(enterSends(key(), false)).toBe(true);
    expect(enterSends(key({ shiftKey: true }), false)).toBe(false);
    expect(enterSends(key({ metaKey: true }), false)).toBe(true);
  });

  it("is a newline on a touch screen", () => {
    expect(enterSends(key(), true)).toBe(false);
    expect(enterSends(key({ shiftKey: true }), true)).toBe(false);
  });

  it("still sends on ⌘/Ctrl+Enter from a keyboard attached to a tablet", () => {
    expect(enterSends(key({ metaKey: true }), true)).toBe(true);
    expect(enterSends(key({ ctrlKey: true }), true)).toBe(true);
  });

  it("never sends mid-composition (Japanese, Chinese, Korean input)", () => {
    expect(enterSends(key({ isComposing: true }), false)).toBe(false);
    expect(enterSends(key({ isComposing: true, metaKey: true }), true)).toBe(false);
  });

  it("never sends on WebKit's late confirm keydown (isComposing already false, keyCode 229)", () => {
    expect(enterSends(key({ keyCode: 229 }), false)).toBe(false);
    expect(enterSends(key({ keyCode: 229, metaKey: true }), true)).toBe(false);
    expect(enterSends(key({ keyCode: 13 }), false)).toBe(true);
  });

  it("imeComposing reads either signal", () => {
    expect(imeComposing({ isComposing: true })).toBe(true);
    expect(imeComposing({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(imeComposing({ isComposing: false, keyCode: 13 })).toBe(false);
  });

  it("ignores every other key", () => {
    expect(enterSends(key({ key: "a" }), false)).toBe(false);
  });
});

it("the composer asks enterSends, and tells the keyboard what Return does", () => {
  const composer = readFileSync(new URL("../components/Composer.tsx", import.meta.url), "utf8");
  expect(composer).toContain("const coarsePointer = useCoarsePointer();");
  expect(composer).toContain("if (enterSends(");
  expect(composer).toContain("}, coarsePointer, sendKey)) {");
  expect(composer).not.toContain('e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing');
  expect(composer).toContain('enterKeyHint={coarsePointer ? "enter" : "send"}');
});

// D14: editing a sent message is the same keyboard, so the same rule.
it("the message-edit box asks enterSends too, so Return is a newline on touch", () => {
  const chat = readFileSync(new URL("../components/ChatView.tsx", import.meta.url), "utf8");
  const editor = chat.slice(chat.indexOf("function BubbleEditor("), chat.indexOf("function Bubble("));
  expect(editor).toContain("const coarsePointer = useCoarsePointer();");
  expect(editor).toContain("if (enterSends(");
  expect(editor).toContain("}, coarsePointer, sendKey)) {");
  expect(editor).not.toContain('e.key === "Enter" && !e.shiftKey');
  expect(editor).toContain('enterKeyHint={coarsePointer ? "enter" : "send"}');
});

it("the composer returns before its @mention and slash menus when an IME is composing", () => {
  const composer = readFileSync(new URL("../components/Composer.tsx", import.meta.url), "utf8");
  const handler = composer.slice(composer.indexOf("onKeyDown={(e) => {\n            // An input method"));
  expect(handler.indexOf("if (imeComposing(")).toBeGreaterThan(-1);
  expect(handler.indexOf("if (imeComposing(")).toBeLessThan(handler.indexOf("if (commandPickerOpen)"));
  expect(handler.indexOf("if (imeComposing(")).toBeLessThan(handler.indexOf("if (mentionPickerOpen)"));
});

describe("the send key choice", () => {
  const press = (over: Partial<Parameters<typeof enterSends>[0]>) => key(over);
  it("shift-enter sends on Shift+Enter only; plain Enter is a newline", () => {
    expect(enterSends(press({ shiftKey: true }), false, "shift-enter")).toBe(true);
    expect(enterSends(press({}), false, "shift-enter")).toBe(false);
    expect(enterSends(press({ metaKey: true }), false, "shift-enter")).toBe(false);
  });
  it("mod-enter sends on Ctrl or Cmd+Enter only", () => {
    expect(enterSends(press({}), false, "mod-enter")).toBe(false);
    expect(enterSends(press({ shiftKey: true }), false, "mod-enter")).toBe(false);
    expect(enterSends(press({ metaKey: true }), false, "mod-enter")).toBe(true);
    expect(enterSends(press({ ctrlKey: true }), false, "mod-enter")).toBe(true);
  });
  it("touch keeps its own rule whatever the mode", () => {
    expect(enterSends(press({}), true, "enter")).toBe(false);
    expect(enterSends(press({ shiftKey: true }), true, "shift-enter")).toBe(false);
    expect(enterSends(press({ metaKey: true }), true, "shift-enter")).toBe(true);
  });
  it("no mode sends mid-composition", () => {
    for (const mode of ["enter", "shift-enter", "mod-enter"] as const) {
      expect(enterSends(press({ isComposing: true, shiftKey: true, metaKey: true }), false, mode)).toBe(false);
      expect(enterSends(press({ keyCode: 229, shiftKey: true, metaKey: true }), false, mode)).toBe(false);
    }
  });
  it("Japanese defaults to Ctrl/Cmd+Enter, everyone else to Enter, and a saved choice wins", () => {
    expect(defaultSendKey("ja")).toBe("mod-enter");
    expect(defaultSendKey("ja-JP")).toBe("mod-enter");
    expect(defaultSendKey("de")).toBe("enter");
    expect(defaultSendKey("pt-br")).toBe("enter");
    const store = (v: string | null) => ({ getItem: () => v });
    expect(resolveSendKey(store(null), "ja")).toBe("mod-enter");
    expect(resolveSendKey(store("enter"), "ja")).toBe("enter");
    expect(resolveSendKey(store("junk"), "ja")).toBe("mod-enter");
    expect(resolveSendKey({ getItem: () => { throw new Error("blocked"); } }, "en")).toBe("enter");
  });
  it("names the keys for the tooltips", () => {
    expect(sendKeyName("mod-enter", true)).toBe("Cmd+Enter");
    expect(sendKeyName("mod-enter", false)).toBe("Ctrl+Enter");
    expect(sendKeyName("enter", true)).toBe("Enter");
  });
  it("M2: an install set up before 1.0.4 keeps Enter; a fresh install keeps the language default; a saved choice is never touched", () => {
    const mem = (seed: Record<string, string> = {}) => {
      const data = new Map(Object.entries(seed));
      return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, data };
    };
    const existing = mem();
    settleSendKeyForUpgrade(false, existing);
    expect(resolveSendKey(existing, "ja")).toBe("enter");
    const fresh = mem();
    settleSendKeyForUpgrade(true, fresh);
    expect(resolveSendKey(fresh, "ja")).toBe("mod-enter");
    settleSendKeyForUpgrade(false, fresh);
    expect(resolveSendKey(fresh, "ja")).toBe("mod-enter");
    const chosen = mem({ [SEND_KEY_STORAGE]: "shift-enter" });
    settleSendKeyForUpgrade(false, chosen);
    expect(chosen.data.get(SEND_KEY_STORAGE)).toBe("shift-enter");
    const unknown = mem();
    settleSendKeyForUpgrade(undefined, unknown);
    expect(unknown.data.has(SEND_KEY_SETTLED_STORAGE)).toBe(false);
    expect(() => settleSendKeyForUpgrade(false, { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } })).not.toThrow();
  });
});
