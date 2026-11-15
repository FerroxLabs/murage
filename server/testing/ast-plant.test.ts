// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

type MutationApi = typeof import("./ast-plant.ts");
let mutations: MutationApi | undefined;
beforeAll(async () => {
  const url = new URL("./ast-plant.ts", import.meta.url);
  if (existsSync(url)) mutations = await import(/* @vite-ignore */ url.href) as MutationApi;
});
function boundary(): MutationApi {
  expect(mutations, "AST mutation activation boundary is missing").toBeDefined();
  return mutations!;
}

describe("AST mutation activation", () => {
  it("H-PLANT-1 a locator that does not match throws", () => {
    const { plant, call } = boundary();
    expect(() => plant("fixture.ts", call("noSuchFn"), "bypass()", "export function send() { submit(); }")).toThrow(/MUTANT_NOT_ACTIVATED/);
  });
  it("refuses an ambiguous locator and an unchanged selected node", () => {
    const { plant, call } = boundary();
    const source = "function send() { submit(); submit(); }";
    expect(() => plant("fixture.ts", call("submit"), "bypass()", source)).toThrow(/MUTANT_NOT_ACTIVATED/);
    expect(() => plant("fixture.ts", call("submit", { nth: 0 }), "submit()", source)).toThrow(/MUTANT_NOT_ACTIVATED/);
  });
  it("records exactly one changed node and limits edits to its AST range", () => {
    const { plantWithProof, call } = boundary();
    const source = "function send() { submit(); submit(); }";
    const result = plantWithProof("fixture.ts", call("submit", { in: "send", nth: 1 }), "bypass()", source);
    expect(result.text).toBe("function send() { submit(); bypass(); }");
    expect(result.proof.matches).toBe(1);
    expect(result.proof.after).not.toBe(result.proof.before);
    expect(result.text.slice(0, result.proof.start)).toBe(source.slice(0, result.proof.start));
  });
  it("supports declaration, property and statement locators", () => {
    const { plant, prop, stmt, decl } = boundary();
    const source = "const adapter = { fencedLearningWrite: true }; function send() { awaitingTurnStart = true; submit(); }";
    expect(plant("fixture.ts", prop("fencedLearningWrite"), "fencedLearningWrite: false", source)).toContain("fencedLearningWrite: false");
    expect(plant("fixture.ts", stmt(/^awaitingTurnStart = true;$/), { kind: "before", text: "await null;" }, source)).toContain("await null;awaitingTurnStart = true;");
    expect(plant("fixture.ts", decl("send"), { kind: "body", text: "{ bypass(); }" }, source)).toContain("function send() { bypass(); }");
  });
});
