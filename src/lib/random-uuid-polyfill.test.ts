// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { installRandomUUID, uuidV4From } from "./random-uuid-polyfill";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const realRandom = { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) } as unknown as Pick<Crypto, "getRandomValues">;

describe("crypto.randomUUID polyfill", () => {
  it.each([0, 255])("sets only the version and variant bits for random byte %i", (value) => {
    const source = { getRandomValues: (bytes: Uint8Array) => bytes.fill(value) } as unknown as Pick<Crypto, "getRandomValues">;
    expect(uuidV4From(source)).toBe(value === 0
      ? "00000000-0000-4000-8000-000000000000"
      : "ffffffff-ffff-4fff-bfff-ffffffffffff");
  });

  it("builds well-formed, distinct v4 IDs from getRandomValues", () => {
    const ids = Array.from({ length: 1000 }, () => uuidV4From(realRandom));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(UUID_V4);
  });

  it("installs on an insecure-context crypto that has only getRandomValues", () => {
    const insecure = { ...realRandom } as unknown as Crypto;
    expect(installRandomUUID(insecure)).toBe(true);
    expect(typeof insecure.randomUUID).toBe("function");
    expect(insecure.randomUUID()).toMatch(UUID_V4);
    // Detached, as a component might hold it, it still works.
    const detached = insecure.randomUUID;
    expect(detached()).toMatch(UUID_V4);
  });

  it("leaves a native randomUUID untouched", () => {
    const native = () => "11111111-1111-4111-8111-111111111111" as const;
    const secure = { ...realRandom, randomUUID: native } as unknown as Crypto;
    expect(installRandomUUID(secure)).toBe(false);
    expect(secure.randomUUID).toBe(native);
    expect(installRandomUUID(globalThis.crypto)).toBe(false);
  });

  it("never falls back to Math.random when getRandomValues is missing", () => {
    const bare = {} as unknown as Crypto;
    expect(installRandomUUID(bare)).toBe(false);
    expect("randomUUID" in bare).toBe(false);
    expect(installRandomUUID(undefined)).toBe(false);
    const source = readFileSync(new URL("./random-uuid-polyfill.ts", import.meta.url), "utf8");
    expect(source.replace(/^\s*\/\/.*$/gm, "")).not.toContain("Math.random");
  });

  it("is the client entry's first import, ahead of every module that might call randomUUID", () => {
    const main = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
    const firstImport = main.split("\n").find((line) => line.startsWith("import "));
    expect(firstImport).toBe('import "./lib/random-uuid-polyfill";');
  });
});
