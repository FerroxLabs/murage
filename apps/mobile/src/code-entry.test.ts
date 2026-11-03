import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { present } from "./screens";
import { TAILSCALE_UNKNOWN } from "./shell-types";
import { codeDigits, computerRow, createCodeEntry, displayName, highlightIndex, hintFor, parseCode } from "./code-entry";

describe("displayName", () => {
  it("prefers a given saved name", () => {
    expect(displayName("mac.tail1.ts.net", "Office Mac")).toBe("Office Mac");
    expect(displayName("mac.tail1.ts.net", "  ")).toBe("mac (tail1)");
  });
  it("shows an IP address in full, IPv6 included", () => {
    expect(displayName("192.168.0.10")).toBe("192.168.0.10");
    expect(displayName("https://100.101.102.103:8443/x")).toBe("100.101.102.103");
    expect(displayName("[fd7a:115c::1]:8443")).toBe("[fd7a:115c::1]");
    expect(displayName("fd7a:115c::1")).toBe("fd7a:115c::1");
    expect(displayName("https://[fd7a:115c::1]/")).toBe("[fd7a:115c::1]");
  });
  it("shortens only MagicDNS names, so two tailnets tell apart", () => {
    expect(displayName("desktop.tailAAAA.ts.net")).toBe("desktop (tailAAAA)");
    expect(displayName("desktop.tailBBBB.ts.net")).toBe("desktop (tailBBBB)");
    expect(displayName("https://example-mac.tailnet123.ts.net:8443/x")).toBe("example-mac (tailnet123)");
  });
  it("shows any other hostname in full", () => {
    expect(displayName("desktop.office.example.com")).toBe("desktop.office.example.com");
    expect(displayName("desktop.office.other.net")).toBe("desktop.office.other.net");
    expect(displayName("  desk  ")).toBe("desk");
    expect(displayName("desk.local")).toBe("desk.local");
  });
});

describe("computerRow", () => {
  const form = { origin: "https://mac.tail1.ts.net", name: "Office Mac" };
  it("uses the saved name only while the address is the saved origin", () => {
    expect(computerRow("mac.tail1.ts.net", form, false)).toBe("Office Mac");
    expect(computerRow("https://MAC.tail1.ts.net/", form, true)).toBe("Office Mac");
    expect(computerRow("https://MAC.tail1.ts.net:443/x", form, false)).toBe("Office Mac");
  });
  it("a different port is a different computer: no saved name, field stays up on a draft", () => {
    expect(computerRow("mac.tail1.ts.net:8443", form, false)).toBe("mac (tail1)");
    expect(computerRow("https://mac.tail1.ts.net:8443/", form, true)).toBeNull();
    expect(computerRow("mac.tail1.ts.net", { origin: "https://mac.tail1.ts.net:8443", name: "Alt" }, true)).toBeNull();
    expect(computerRow("mac.tail1.ts.net:8443", { origin: "https://mac.tail1.ts.net:8443", name: "Alt" }, true)).toBe("Alt");
  });
  it("re-pair A, Change to B, short code, redraw: B is shown, never A's name", () => {
    expect(computerRow("other.tail2.ts.net", form, true)).toBeNull(); // field stays visible with B typed
    expect(computerRow("other.tail2.ts.net", form, false)).toBe("other (tail2)"); // never A's name
  });
  it("no address, no row", () => {
    expect(computerRow("  ", form, false)).toBeNull();
  });
});

describe("type screen passes the saved name", () => {
  const saved = [{ origin: "https://mac.tail1.ts.net", name: "Office Mac", lastConnected: 1 }];
  it("names a saved computer and leaves an unsaved one nameless", () => {
    expect(present({ kind: "type", origin: "https://mac.tail1.ts.net" }, saved, 2, TAILSCALE_UNKNOWN).form).toEqual({ origin: "https://mac.tail1.ts.net", name: "Office Mac" });
    expect(present({ kind: "type", origin: "https://other.tail1.ts.net" }, saved, 2, TAILSCALE_UNKNOWN).form).toEqual({ origin: "https://other.tail1.ts.net" });
    expect(present({ kind: "type" }, saved, 2, TAILSCALE_UNKNOWN).form).toEqual({});
  });
});

describe("parseCode / codeDigits", () => {
  it("strips non-digits and caps at six", () => {
    expect(codeDigits("12a3-4")).toBe("1234");
    expect(codeDigits("123 456")).toBe("123456");
    expect(codeDigits("123-456")).toBe("123456");
  });
  it("prefers a run of exactly six digits over digits before it", () => {
    expect(parseCode("Device 2: 123456")).toEqual({ digits: "123456", auto: true, ambiguous: false });
    expect(parseCode("Code: 123456")).toEqual({ digits: "123456", auto: true, ambiguous: false });
    expect(parseCode("123456 is your code, valid 10 min")).toEqual({ digits: "123456", auto: true, ambiguous: false });
  });
  it("more than six digits and no clean six-run: first six shown, no auto-connect", () => {
    expect(parseCode("1234567890")).toEqual({ digits: "123456", auto: false, ambiguous: true });
    expect(parseCode("Device 22: 123 456")).toEqual({ digits: "221234", auto: false, ambiguous: true });
    expect(parseCode("1234567")).toEqual({ digits: "123456", auto: false, ambiguous: true });
  });
  it("several six-digit candidates are ambiguous", () => {
    expect(parseCode("Device 987654: code 123456")).toEqual({ digits: "987654", auto: false, ambiguous: true });
  });
  it("exactly six joined digits may auto-connect", () => {
    expect(parseCode("123 456")).toEqual({ digits: "123456", auto: true, ambiguous: false });
  });
});

describe("highlightIndex", () => {
  it("follows the real caret, clamped to the six boxes", () => {
    expect(highlightIndex(0, 6)).toBe(0);
    expect(highlightIndex(3, 6)).toBe(3);
    expect(highlightIndex(6, 6)).toBe(5);
    expect(highlightIndex(null, 2)).toBe(2);
    expect(highlightIndex(null, 9)).toBe(5);
  });
});

describe("createCodeEntry", () => {
  it("connects exactly once when the sixth digit lands, with the six digits", () => {
    const connect = vi.fn();
    const entry = createCodeEntry(() => true, connect);
    for (const typed of ["1", "12", "123", "1234", "12345"]) entry.input(typed);
    expect(connect).not.toHaveBeenCalled();
    entry.input("123456");
    entry.input("1234567"); // more typing past six changes nothing
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith("123456");
  });
  it("hands connect the normalized digits for every paste shape", () => {
    for (const [pasted, expected] of [["123 456", "123456"], ["Code: 123456", "123456"], ["Device 2: 123456", "123456"]] as const) {
      const connect = vi.fn();
      const entry = createCodeEntry(() => true, connect);
      expect(entry.input(pasted)).toBe(expected);
      expect(connect).toHaveBeenCalledTimes(1);
      expect(connect).toHaveBeenCalledWith(expected);
    }
  });
  it("a paste of 1234567890 waits for Go, then sends the first six", () => {
    const connect = vi.fn();
    const entry = createCodeEntry(() => true, connect);
    expect(entry.input("1234567890")).toBe("123456");
    expect(connect).not.toHaveBeenCalled();
    entry.enter();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith("123456");
  });
  it("Go or Connect after the auto-connect does not make a second attempt", () => {
    const connect = vi.fn();
    const entry = createCodeEntry(() => true, connect);
    entry.input("123456");
    entry.enter();
    entry.enter();
    expect(connect).toHaveBeenCalledTimes(1);
  });
  it("connects again after a digit is deleted and retyped", () => {
    const connect = vi.fn();
    const entry = createCodeEntry(() => true, connect);
    entry.input("123456");
    entry.input("12345");
    entry.input("123456");
    expect(connect).toHaveBeenCalledTimes(2);
  });
  it("Return on a short code still connects, once", () => {
    const connect = vi.fn();
    const entry = createCodeEntry(() => true, connect);
    entry.input("123");
    entry.enter();
    entry.enter();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith("123");
  });
  it("select all then paste replaces the code (the field hands over the replaced text)", () => {
    const connect = vi.fn();
    const entry = createCodeEntry(() => false, connect);
    expect(entry.input("123456")).toBe("123456");
    expect(entry.input("654321")).toBe("654321");
    expect(entry.digits).toBe("654321");
  });
  it("two candidates wait for Go, and appending whitespace does not clear that", () => {
    const connect = vi.fn();
    const entry = createCodeEntry(() => true, connect);
    expect(entry.input("Device 987654: code 123456")).toBe("987654");
    expect(connect).not.toHaveBeenCalled();
    entry.input("987654 ");
    entry.input("987654  ");
    expect(connect).not.toHaveBeenCalled();
    entry.enter();
    expect(connect).toHaveBeenCalledWith("987654");
  });
  it("more than six digits wait for Go through trailing whitespace; a real edit clears it", () => {
    const connect = vi.fn();
    const entry = createCodeEntry(() => true, connect);
    entry.input("Device 22: 123 456");
    entry.input("221234 ");
    expect(connect).not.toHaveBeenCalled();
    entry.input("22123"); // substantive edit
    entry.input("221234");
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith("221234");
  });
  it("an address edit re-arms but never connects by itself", () => {
    const connect = vi.fn();
    const entry = createCodeEntry(() => true, connect);
    entry.input("123456");
    entry.addressChanged();
    expect(connect).toHaveBeenCalledTimes(1); // no second attempt to the new address on its own
    entry.enter(); // an explicit Connect does
    expect(connect).toHaveBeenCalledTimes(2);
    entry.enter();
    expect(connect).toHaveBeenCalledTimes(2);
  });
  it("does not auto-connect with an empty address; the typed address never triggers it either; Connect does", () => {
    const connect = vi.fn();
    let address = "";
    const entry = createCodeEntry(() => address.trim() !== "", connect);
    entry.input("123456");
    expect(connect).not.toHaveBeenCalled();
    address = "desk.tail1.ts.net";
    entry.addressChanged();
    expect(connect).not.toHaveBeenCalled();
    entry.enter();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith("123456");
  });
});

describe("code screen wiring", () => {
  const render = readFileSync(new URL("./render.ts", import.meta.url), "utf8");
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  it("shows the computer row with a Change button when the address is known", () => {
    expect(render).toContain('"Computer"');
    expect(render).toContain('"Change"');
    expect(render).toMatch(/change\.addEventListener\("click"[\s\S]{0,160}address\.wrap\.hidden = false;[\s\S]{0,60}address\.input\.focus\(\)/);
    expect(render).toMatch(/address\.wrap\.hidden = true/);
  });
  it("uses one real input behind six aria-hidden boxes, with no maxlength attribute that would truncate a paste", () => {
    expect(render).toMatch(/cell\.setAttribute\("aria-hidden", "true"\)/);
    expect(render).not.toMatch(/maxLength/);
    expect(render).toMatch(/boxes\.addEventListener\("click", \(\) => codeInput\.focus\(\)\)/);
    expect(css).toMatch(/grid-template-columns: repeat\(6, minmax\(0, 1fr\)\)/);
    expect(css).toMatch(/\.code-box \{[^}]*min-height: 2\.4em/);
    expect(css).toMatch(/\.code-box \{[^}]*overflow: hidden/);
    expect(css).toMatch(/\.code-box \{[^}]*font-size: clamp\(/);
    expect(css).not.toMatch(/\.code-box \{[^}]*[^-]height: \d+px/);
    expect(css).toMatch(/\.code-boxes\.focused/);
  });

  it("moves a later tap's caret to the end unless there is a real selection; selectionchange only repaints", () => {
    expect(render).toMatch(/const caretToEnd = \(\) => \{\s*if \(codeInput\.selectionStart !== codeInput\.selectionEnd\) return;/);
    expect(render).toContain('codeInput.addEventListener("click", caretToEnd)');
    expect(render).toContain('codeInput.addEventListener("pointerup", caretToEnd)');
    expect(render).toMatch(/selectionchange", function onSelection\(\) \{[^}]*?paint\(\)/);
    expect(render).not.toMatch(/onSelection[\s\S]{0,200}setSelectionRange/);
    expect(render).not.toContain('"Backspace"');
    expect(render).toContain("highlightIndex(codeInput.selectionStart, typed.length)");
  });
  it("recovers from a composition that never ends: no sticky flag, blur and non-composing input settle", () => {
    expect(render).not.toContain("composing =");
    expect(render).toContain('codeInput.addEventListener("compositionend", settle)');
    expect(render).toMatch(/if \(\(event as InputEvent\)\.isComposing\) return;\s*settle\(\);/);
    expect(render).toMatch(/addEventListener\("blur", \(\) => \{\s*settle\(\);/);
  });
  it("reconciles the field before Connect and before Go/Return", () => {
    expect(render).toContain("const reconcile = () => settle();");
    expect(render).toMatch(/submitConnect = \(\) => \{\s*reconcile\(\);\s*entry\.enter\(\);/);
    expect(render).toMatch(/event\.preventDefault\(\);\s*reconcile\(\);\s*entry\.enter\(\);/);
  });
  it("routes the Connect button and address edits through the one-attempt guard", () => {
    expect(render).toMatch(/action\.id === "connect" && submitConnect \? submitConnect\(\)/);
        expect(render).toContain("computerRow(address.input.value, view.form, draft !== undefined)");
  });
  it("leaves the real input autofillable: not fully transparent, numeric, one-time-code", () => {
    expect(css).toMatch(/\.code-input \{[^}]*opacity: 0\.01/);
    expect(css).not.toMatch(/\.code-input \{[^}]*opacity: 0;/);
    expect(render).toContain('codeInput.inputMode = "numeric"');
    expect(render).toContain('codeInput.autocomplete = "one-time-code"');
  });
  it("the hint has three states and never promises auto-connect when it cannot happen", () => {
    expect(hintFor(false, false, false)).toBe("Type the address above, then the code, and press Connect. Paste works too.");
    expect(hintFor(true, true, true)).toBe("Check the code, then press Connect.");
    expect(hintFor(true, false, false)).toBe("Connects as soon as the sixth digit is in. Paste works too.");
    expect(hintFor(true, false, true)).toBe("Press Connect."); // address typed after six digits: no auto-fire
    for (const t of [hintFor(false, false, false), hintFor(true, true, true), hintFor(true, false, false), hintFor(true, false, true)]) expect(t).not.toMatch(/[\u2013\u2014]/);
  });
  it("the hint is refreshed on address input and after every settle", () => {
    expect(render).toMatch(/address\.input\.addEventListener\("input", \(\) => \{\s*entry\.addressChanged\(\);\s*syncHint\(\);/);
    expect(render).toMatch(/paint\(\);\s*syncHint\(\);\s*\};/);
    expect(render).toContain("hintFor(address.input.value.trim() !== \"\", entry.needsConfirm, entry.digits.length === CODE_LENGTH)");
  });
  it("needsConfirm reports an ambiguous paste", () => {
    const e = createCodeEntry(() => true, () => {});
    e.input("123456 654321");
    expect(e.needsConfirm).toBe(true);
    e.input("12");
    expect(e.needsConfirm).toBe(false);
  });
});
