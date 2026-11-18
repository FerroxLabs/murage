import { isDeepStrictEqual } from "node:util";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Exercise the actual mutator expressions without launching their server suites.
const script = readFileSync(new URL("../../scripts/verify-no-limits-merge-mutants.mjs", import.meta.url), "utf8");
const expression = script.match(/const specs=(\[[\s\S]*?\n\]);/)![1]!;
type Spec = [string, string, (text: string) => string];
const specs: Spec[] = Function("core", "ui", "outside", "upgrade", `return ${expression}`)("", "", "", "");

describe("No limits copy mutant anchors", () => {
  it.each(["H8-native-wipe", "H8-fr-address"])("%s changes the shipped value, not only JSON formatting", (id) => {
    const [, file, mutate] = specs.find(spec => spec[0] === id)!;
    const original = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
    const before = JSON.parse(original);
    const after = JSON.parse(mutate(original));
    expect(after).not.toEqual(before);
    expect(Object.keys(before).filter(key => before[key] !== after[key])).toHaveLength(1);
  });

  it("the runner rejects a formatting-only JSON mutation before running tests", () => {
    const guard = script.match(/function assertSemanticMutation\([^]*?\n}/)?.[0];
    expect(guard).toBeDefined();
    const check = Function("isDeepStrictEqual", `${guard}; return assertSemanticMutation`)(isDeepStrictEqual);
    expect(() => check("format-only", "pack.json", '{ "k": "v" }', '{"k":"v"}')).toThrow(/semantic/i);
    expect(() => check("changed", "pack.json", '{"k":"v"}', '{"k":"changed"}')).not.toThrow();
    expect(() => check("missing", "file.ts", "same", "same")).toThrow();
    expect(script).toContain("assertSemanticMutation(id,file,original,changed);");
  });
});
