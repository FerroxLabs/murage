import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical-json.ts";

describe("canonical JSON authorization equality", () => {
  it("J1 preserves Unicode, whitespace and case exactly", () => {
    expect(canonicalJson({ p: "/tmp/café" })).not.toBe(canonicalJson({ p: "/tmp/cafe\u0301" }));
    expect(canonicalJson(" A ")).not.toBe(canonicalJson("a"));
  });
  it("J2 sorts keys recursively by Unicode code point, including integer-like keys", () => {
    expect(canonicalJson({ b: 1, a: [2, 1] })).toBe(canonicalJson({ a: [2, 1], b: 1 }));
    expect(canonicalJson({ "2": 2, "10": 10, z: { b: 2, a: 1 } })).toBe('{"10":10,"2":2,"z":{"a":1,"b":2}}');
    expect(canonicalJson({ "\ue000": 1, "😀": 2 })).toBe('{"":1,"😀":2}');
  });
  it("J3 keeps arrays ordered", () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });
  it("J4 drops undefined object members, preserves array positions, and writes -0 as 0", () => {
    expect(canonicalJson({ a: undefined, b: -0 })).toBe('{"b":0}');
    expect(canonicalJson([undefined, , 1])).toBe('[null,null,1]');
    expect(canonicalJson(undefined)).toBeUndefined();
  });
  it("J5 rejects unsupported values at any depth, cycles and non-JSON objects", () => {
    const cycle: unknown[] = []; cycle.push(cycle);
    for (const bad of [NaN, Infinity, -Infinity, 1n, Symbol("x"), () => 1, cycle, new Date(), new Map()]) {
      expect(canonicalJson(bad)).toBeUndefined();
      expect(canonicalJson({ nested: [bad] })).toBeUndefined();
    }
    const shared = { x: 1 };
    expect(canonicalJson([shared, shared])).toBe('[{"x":1},{"x":1}]');
  });
  it("J6 never invokes getters or toJSON and keeps __proto__ as data", () => {
    const getter = Object.defineProperty({}, "x", { enumerable: true, get() { throw new Error("not JSON"); } });
    expect(canonicalJson(getter)).toBeUndefined();
    expect(canonicalJson({ toJSON() { return "spoof"; } })).toBeUndefined();
    expect(canonicalJson(JSON.parse('{"__proto__":{"x":1}}'))).toBe('{"__proto__":{"x":1}}');
  });
});
