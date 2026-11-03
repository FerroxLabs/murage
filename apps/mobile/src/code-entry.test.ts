import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { codeDigits, createCodeEntry, shortName } from "./code-entry";

describe("shortName", () => {
  it("takes the first DNS label of the host", () => {
    expect(shortName("example-mac.tailnet123.ts.net")).toBe("example-mac");
    expect(shortName("https://example-mac.tailnet123.ts.net:8443/x")).toBe("example-mac");
    expect(shortName("  desk  ")).toBe("desk");
  });
});

describe("codeDigits", () => {
  it("strips non-digits and caps at six", () => {
    expect(codeDigits("12a3-4")).toBe("1234");
    expect(codeDigits("1234567890")).toBe("123456");
  });
  it("fills all six from a pasted '123 456' or '123456'", () => {
    expect(codeDigits("123 456")).toBe("123456");
    expect(codeDigits("123456")).toBe("123456");
  });
});

describe("createCodeEntry", () => {
  it("connects exactly once when the sixth digit lands", () => {
    const connect = vi.fn();
    const entry = createCodeEntry(() => true, connect);
    for (const typed of ["1", "12", "123", "1234", "12345"]) entry.input(typed);
    expect(connect).not.toHaveBeenCalled();
    entry.input("123456");
    entry.input("123456789"); // more typing past six changes nothing
    expect(connect).toHaveBeenCalledTimes(1);
  });
  it("connects once for a paste of '123 456'", () => {
    const connect = vi.fn();
    const entry = createCodeEntry(() => true, connect);
    expect(entry.input("123 456")).toBe("123456");
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
  it("Return on the code still connects", () => {
    const connect = vi.fn();
    const entry = createCodeEntry(() => true, connect);
    entry.input("123");
    entry.enter();
    expect(connect).toHaveBeenCalledTimes(1);
  });
  it("does not auto-connect with an empty address, and does once one is filled in", () => {
    const connect = vi.fn();
    let address = "";
    const entry = createCodeEntry(() => address.trim() !== "", connect);
    entry.input("123456");
    expect(connect).not.toHaveBeenCalled();
    address = "desk.tail1.ts.net";
    entry.input("1234567");
    expect(connect).toHaveBeenCalledTimes(1);
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
    expect(css).toMatch(/\.code-box \{[^}]*height: 64px/);
    expect(css).toMatch(/\.code-boxes\.focused/);
  });
});
