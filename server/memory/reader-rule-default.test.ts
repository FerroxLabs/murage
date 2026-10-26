// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.4 U28: a reader whose audience is not the owner is judged by its own transcript rule (disclosures.ts readerWithheldMessage) on every
// recall path even when the caller passes no rule, so a new caller cannot read past it by leaving the option out. The owner is unchanged.
import { afterEach, describe, expect, it } from "vitest";
import { database } from "../database.ts";
import { buildMemoryBundle, hydrateMemoryRecord } from "./bundle.ts";
import { searchMemory, setAuthorizeSliceMsForTest } from "./search.ts";
import { readableMemoryRecord, withReaderRule } from "./readable.ts";
import { setIntegrityFlags } from "./integrity-flags.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { access, hits, QUERY, world } from "./testing/xthread-world.ts";

const big = () => LineageAllowance.tool(1_000_000_000);
const ids = (list: ReadonlyArray<{ id: string }>) => list.map(hit => hit.id);

afterEach(() => { try { setIntegrityFlags(database(), { hold: null, pending: false }); } catch { /* closed */ } setAuthorizeSliceMsForTest(8); });

describe("U28: the reader's rule is the default for a reader that is not the owner", () => {
  it("bundle, search, memory_get hydration and a direct read leave X' out with no rule passed", async () => {
    const { person: who, x } = world({ flipFirst: true });
    const reader = access("finch", "t2", { human: who, notOwnerAudience: true });
    // control: scope and content alone show X' to this reader
    expect(typeof readableMemoryRecord(x.id, x.version, reader, { allowance: big(), mode: "current", withheldMessage: null })).toBe("object");
    expect(readableMemoryRecord(x.id, x.version, reader, { allowance: big(), mode: "current" })).toBe("MEMORY_EVIDENCE_UNAVAILABLE");
    expect(() => hydrateMemoryRecord(x.id, x.version, reader, { allowance: big() })).toThrow("MEMORY_EVIDENCE_UNAVAILABLE");
    expect(ids((await searchMemory(QUERY, reader, hits([x]), { allowance: LineageAllowance.tool() })).hits)).not.toContain(x.id);
    expect((await buildMemoryBundle(QUERY, reader, hits([x]), { allowance: LineageAllowance.tool() })).text).not.toContain("GATE-7731");
  });

  it("the owner keeps X' on every path, and its options are not changed", async () => {
    const { x } = world({ flipFirst: true });
    const owner = access("finch", "finch-direct");
    const options = { allowance: big() };
    expect(withReaderRule(owner, options)).toBe(options);
    expect(typeof readableMemoryRecord(x.id, x.version, owner, { allowance: big(), mode: "current" })).toBe("object");
    expect(hydrateMemoryRecord(x.id, x.version, owner, { allowance: big() }).id).toBe(x.id);
    // (the owner's search and bundle are T2 of xthread-audience-recall.test.ts)
  });

  it("a rule the caller passes is kept as passed", () => {
    const { person: who } = world({ flipFirst: true });
    const reader = access("finch", "t2", { human: who, notOwnerAudience: true });
    const rule = () => false;
    expect(withReaderRule(reader, { allowance: big(), withheldMessage: rule }).withheldMessage).toBe(rule);
    expect(withReaderRule(reader, { allowance: big(), withheldMessage: null }).withheldMessage).toBeNull();
    const unset: { allowance: LineageAllowance; withheldMessage?: (threadId: string, messageId: string, allowance: LineageAllowance) => boolean } = { allowance: big() };
    expect(typeof withReaderRule(reader, unset).withheldMessage).toBe("function");
  });
});
