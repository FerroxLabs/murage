import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { present } from "./screens";
import { TAILSCALE_UNKNOWN } from "./shell-types";
import { codeDigits, createCodeEntry, displayName, parseCode } from "./code-entry";

describe("displayName", () => {
  it("prefers the saved computer's name", () => {
    expect(displayName("mac.tail1.ts.net", "Office Mac")).toBe("Office Mac");
    expect(displayName("mac.tail1.ts.net", "  ")).toBe("mac (tail1)");
  });
  it("shows an IP address in full", () => {
    expect(displayName("192.168.0.10")).toBe("192.168.0.10");
    expect(displayName("https://100.101.102.103:8443/x")).toBe("100.101.102.103");
    expect(displayName("[fd7a:115c::1]:8443")).toBe("[fd7a:115c::1]");
  });
  it("tells two tailnets apart", () => {
    expect(displayName("desktop.tailAAAA.ts.net")).not.toBe(displayName("desktop.tailBBBB.ts.net"));
    expect(displayName("desktop.tailAAAA.ts.net")).toBe("desktop (tailAAAA)");
    expect(displayName("https://example-mac.tailnet123.ts.net:8443/x")).toBe("example-mac (tailnet123)");
  });
  it("keeps a bare or two-label host as typed", () => {
    expect(displayName("  desk  ")).toBe("desk");
    expect(displayName("desk.local")).toBe("desk.local");
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
    expect(parseCode("Device 2: 123456")).toEqual({ digits: "123456", auto: true });
    expect(parseCode("Code: 123456")).toEqual({ digits: "123456", auto: true });
    expect(parseCode("123456 is your code, valid 10 min")).toEqual({ digits: "123456", auto: true });
  });
  it("more than six digits and no clean six-run: first six shown, no auto-connect", () => {
    expect(parseCode("1234567890")).toEqual({ digits: "123456", auto: false });
    expect(parseCode("Device 22: 123 456")).toEqual({ digits: "221234", auto: false });
    expect(parseCode("1234567")).toEqual({ digits: "123456", auto: false });
  });
  it("exactly six joined digits may auto-connect", () => {
    expect(parseCode("123 456")).toEqual({ digits: "123456", auto: true });
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
    expect(render).toMatch(/boxes\.addEventListener\("click", \(\) => \{\s*codeInput\.focus\(\);\s*caretToEnd\(\);/);
    expect(css).toMatch(/grid-template-columns: repeat\(6, minmax\(0, 1fr\)\)/);
    expect(css).toMatch(/\.code-box \{[^}]*min-height: 2\.4em/);
    expect(css).toMatch(/\.code-box \{[^}]*overflow: hidden/);
    expect(css).toMatch(/\.code-box \{[^}]*font-size: clamp\(/);
    expect(css).not.toMatch(/\.code-box \{[^}]*[^-]height: \d+px/);
    expect(css).toMatch(/\.code-boxes\.focused/);
  });

  it("keeps the caret at the end and Backspace on the last digit", () => {
    expect(render).toMatch(/const caretToEnd = /);
    expect(render).toContain('document.addEventListener("selectionchange", onSelection)');
    expect(render).toMatch(/codeInput\.addEventListener\("focus", \(\) => \{\s*caretToEnd\(\);/);
    expect(render).toMatch(/codeInput\.addEventListener\("click", caretToEnd\)/);
    expect(render).toMatch(/event\.key !== "Backspace"[\s\S]{0,160}codeInput\.value\.slice\(0, -1\)/);
    expect(render).toContain("Math.min(typed.length, CODE_LENGTH - 1)");
  });
  it("routes the Connect button and address edits through the one-attempt guard", () => {
    expect(render).toMatch(/action\.id === "connect" && submitConnect \? submitConnect\(\)/);
    expect(render).toMatch(/address\.input\.addEventListener\("input", \(\) => entry\.addressChanged\(\)\)/);
    expect(render).toContain("displayName(address.input.value, view.form.name)");
  });
  it("leaves the real input autofillable: not fully transparent, numeric, one-time-code", () => {
    expect(css).toMatch(/\.code-input \{[^}]*opacity: 0\.01/);
    expect(css).not.toMatch(/\.code-input \{[^}]*opacity: 0;/);
    expect(render).toContain('codeInput.inputMode = "numeric"');
    expect(render).toContain('codeInput.autocomplete = "one-time-code"');
  });
  it("does not promise auto-connect when the address is typed by hand", () => {
    expect(render).toContain("If you type the address yourself, press Connect.");
  });
});
