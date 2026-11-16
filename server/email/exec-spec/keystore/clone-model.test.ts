// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { cloneModel } from "./clone-model.ts";
import { TINY_DOMAIN } from "./domain.ts";
import { allSeeds } from "./seeds.ts";

it("copies every model seed exactly like structuredClone and isolates later mutations", () => {
  for (const seed of allSeeds(TINY_DOMAIN)) {
    const expected = structuredClone(seed.world), copied = cloneModel(seed.world);
    expect(copied).toStrictEqual(expected);
    copied.trace.push({ t: "boot", home: "h1" });
    copied.homes.h1.durable.disk.bots.extra = "fixture";
    expect(seed.world).toStrictEqual(expected);
  }
});

it("preserves shared references, cycles, undefined, sparse arrays and own prototype-named keys", () => {
  const shared = { value: 1 }, input = { a: shared, b: shared, missing: undefined, sparse: new Array(3), self: null as unknown };
  input.self = input;
  Object.defineProperty(input, "__proto__", { value: shared, enumerable: true });
  const copied = cloneModel(input);
  expect(copied).toStrictEqual(structuredClone(input));
  expect(copied.a).toBe(copied.b);
  expect(copied.self).toBe(copied);
  expect(copied.a).not.toBe(shared);
  expect(0 in copied.sparse).toBe(false);
});
