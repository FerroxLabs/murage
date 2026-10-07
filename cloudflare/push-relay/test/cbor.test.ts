import { describe, expect, it } from "vitest";
import { decodeCbor } from "../src/cbor";
import { encodeCbor } from "./cbor-encode";

describe("decodeCbor", () => {
  it("reads what an App Attest object uses", () => {
    const value = { fmt: "apple-appattest", attStmt: { x5c: [new Uint8Array([1, 2]), new Uint8Array(300)], receipt: new Uint8Array([9]) }, authData: new Uint8Array(70), n: -5, big: 70000, ok: true, none: null };
    expect(decodeCbor(encodeCbor(value))).toEqual(value);
  });
  it("refuses trailing bytes, indefinite lengths and depth over 16", () => {
    expect(() => decodeCbor(new Uint8Array([0x01, 0x02]))).toThrow();
    expect(() => decodeCbor(new Uint8Array([0x9f, 0xff]))).toThrow();
    expect(() => decodeCbor(new Uint8Array(Array(20).fill(0x81).concat([0x01])))).toThrow();
  });
  it("keeps a leading byte order mark, so \"\\uFEFFfmt\" is not \"fmt\"", () => {
    const decoded = decodeCbor(encodeCbor({ "\uFEFFfmt": 1, fmt: "apple-appattest" })) as Record<string, unknown>;
    expect(Object.keys(decoded)).toEqual(["\uFEFFfmt", "fmt"]);
    expect(decoded.fmt).toBe("apple-appattest");
    expect(decodeCbor(encodeCbor("\uFEFFfmt"))).not.toBe("fmt");
  });
  it("refuses truncation, duplicate keys, a __proto__ key, tags and floats", () => {
    expect(() => decodeCbor(new Uint8Array([0x42, 0x01]))).toThrow();
    expect(() => decodeCbor(new Uint8Array([]))).toThrow();
    expect(() => decodeCbor(new Uint8Array([0xa2, 0x61, 0x61, 0x01, 0x61, 0x61, 0x02]))).toThrow();
    expect(() => decodeCbor(encodeCbor({ ["__proto__"]: 1 }))).toThrow();
    expect(() => decodeCbor(new Uint8Array([0xc0, 0x01]))).toThrow();
    expect(() => decodeCbor(new Uint8Array([0xf9, 0x3c, 0x00]))).toThrow();
  });
});
