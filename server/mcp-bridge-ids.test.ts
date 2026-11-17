// C11 note 3.1 section 6: the bridge id namespace as a pure module (U-1, B-8 unit, B-8h, B-9b, B-3h identity).
import { describe, expect, it, vi } from "vitest";

import { bridgeBusyFrame, createBridgeIds, MAX_BRIDGE_IN_FLIGHT, spliceTopLevelId, topLevelIdText, type BridgeEntry } from "./mcp-bridge-ids.ts";
import type { McpRequest } from "./mcp-listed.ts";

const NONCE = "abcdefabcdef";
const fakeReq = () => ({ published: Promise.resolve(true), respond: vi.fn(async () => {}), cancel: vi.fn() }) satisfies McpRequest;
const keyOf = (id: number | string) => `${typeof id}:${id}`;
const admit = (ids: ReturnType<typeof createBridgeIds>, id: number | string, req: McpRequest = fakeReq()) => {
  const issued = ids.issue(keyOf(id), JSON.stringify(id), req);
  if (!issued.admitted) throw new Error("expected the request to be admitted");
  return { ...issued, req };
};

describe("createBridgeIds (U-1)", () => {
  it("issues ids in the mb.<nonce>.<seq> namespace, strictly increasing, and 10,000 issue/take/settle cycles leave nothing behind", () => {
    const ids = createBridgeIds({ nonce: NONCE });
    const seen: string[] = [];
    for (let i = 0; i < 10_000; i++) {
      const { bridgeId, entry } = admit(ids, i % 7);
      seen.push(bridgeId);
      const taken = ids.take(bridgeId);
      expect(taken).toEqual({ kind: "live", entry });
      expect(entry.state).toBe("claimed");
      ids.settle(entry);
    }
    expect(ids.liveCount()).toBe(0);
    expect(seen[0]).toBe(`mb.${NONCE}.1`);
    expect(seen.at(-1)).toBe(`mb.${NONCE}.10000`);
    for (const id of seen.slice(0, 50)) expect(ids.take(id)).toEqual({ kind: "retired" });
  });

  it("random nonce is 12 hex characters and differs between factories", () => {
    const a = admit(createBridgeIds(), 1).bridgeId, b = admit(createBridgeIds(), 1).bridgeId;
    expect(a).toMatch(/^mb\.[0-9a-f]{12}\.1$/);
    expect(a).not.toBe(b);
  });

  it("a second take of any id is retired, a claimed id stays out of reach, and a seq at or past the counter is retired", () => {
    const ids = createBridgeIds({ nonce: NONCE });
    const { bridgeId, entry } = admit(ids, 5);
    expect(ids.take(bridgeId).kind).toBe("live");
    expect(ids.take(bridgeId)).toEqual({ kind: "retired" }); // claimed, not yet settled
    ids.settle(entry);
    expect(ids.take(bridgeId)).toEqual({ kind: "retired" }); // done
    expect(ids.take(`mb.${NONCE}.2`)).toEqual({ kind: "retired" }); // never issued (seq == next)
    expect(ids.take(`mb.${NONCE}.99999`)).toEqual({ kind: "retired" });
    expect(ids.take(`mb.${NONCE}.0`)).toEqual({ kind: "retired" }); // malformed seq
    expect(ids.take(`mb.${NONCE}.01`)).toEqual({ kind: "retired" });
    expect(ids.take(`mb.${NONCE}.abc`)).toEqual({ kind: "retired" });
    expect(ids.take(`mb.${NONCE}.`)).toEqual({ kind: "retired" });
  });

  it("a foreign id passes unless its key equals a live engine id", () => {
    const ids = createBridgeIds({ nonce: NONCE });
    const { entry } = admit(ids, 4);
    expect(ids.take(4)).toEqual({ kind: "foreign", collides: true });
    expect(ids.take(9)).toEqual({ kind: "foreign", collides: false });
    expect(ids.take("4")).toEqual({ kind: "foreign", collides: false }); // 4 is not "4"
    expect(ids.take("mb.0123456789ab.1")).toEqual({ kind: "foreign", collides: false }); // another bridge's namespace
    admit(ids, "s");
    expect(ids.take("s")).toEqual({ kind: "foreign", collides: true });
    ids.settle(entry);
    expect(ids.take(4)).toEqual({ kind: "foreign", collides: false });
  });

  it("an open entry is cancelled by the engine (its handle too); a claimed one is revoked and says nothing to send", () => {
    const retired: Array<[string, string]> = [];
    const ids = createBridgeIds({ nonce: NONCE, onRetire: (e, how) => retired.push([e.bridgeId, how]) });
    const open = admit(ids, 7);
    expect(ids.cancelByEngine(keyOf(7))).toBe(open.bridgeId);
    expect(open.req.cancel).toHaveBeenCalledTimes(1);
    expect(ids.liveCount()).toBe(0);
    expect(ids.take(open.bridgeId)).toEqual({ kind: "retired" });
    expect(ids.cancelByEngine(keyOf(7))).toBeUndefined(); // nothing live
    const claimed = admit(ids, 8);
    ids.take(claimed.bridgeId);
    expect(ids.cancelByEngine(keyOf(8))).toBeUndefined();
    expect(claimed.entry.state).toBe("revoked");
    expect(claimed.req.cancel).not.toHaveBeenCalled();
    expect(ids.liveCount()).toBe(1); // stays until settle
    ids.settle(claimed.entry);
    expect(ids.liveCount()).toBe(0);
    expect(retired).toEqual([[open.bridgeId, "cancelled"], [claimed.bridgeId, "revoked"]]);
  });

  it("retire(bridgeId) (EPIPE) cancels exactly that request's handle", () => {
    const ids = createBridgeIds({ nonce: NONCE });
    const a = admit(ids, 1), b = admit(ids, 2);
    ids.retire(b.bridgeId);
    expect(b.req.cancel).toHaveBeenCalledTimes(1);
    expect(a.req.cancel).not.toHaveBeenCalled();
    expect(ids.liveCount()).toBe(1);
    ids.retire(`mb.${NONCE}.77`); ids.retire("raw"); // unknown: nothing happens
    expect(ids.liveCount()).toBe(1);
  });

  it("an in-flight reuse of an engine id retires the older entry before the new one is issued (I4)", () => {
    const ids = createBridgeIds({ nonce: NONCE });
    const a = admit(ids, 7), b = admit(ids, 7);
    expect(a.req.cancel).toHaveBeenCalledTimes(1);
    expect(ids.take(a.bridgeId)).toEqual({ kind: "retired" });
    expect(ids.take(b.bridgeId).kind).toBe("live");
  });
});

describe("spliceTopLevelId (U-1, I7)", () => {
  it("replaces only the top-level id, never params.id or result.id", () => {
    const line = '{"jsonrpc":"2.0","id":5,"method":"x","params":{"id":5,"nested":{"id":5}},"result":{"id":5}}';
    expect(spliceTopLevelId(line, '"mb.a.1"')).toBe('{"jsonrpc":"2.0","id":"mb.a.1","method":"x","params":{"id":5,"nested":{"id":5}},"result":{"id":5}}');
  });
  it("replaces EVERY duplicate top-level id member (JSON.parse keeps the last)", () => {
    const out = spliceTopLevelId('{"id":1,"method":"x","id":2}', '"b"')!;
    expect(out).toBe('{"id":"b","method":"x","id":"b"}');
    expect(JSON.parse(out).id).toBe("b");
  });
  it("finds an id whose key is written with an escape, and keeps every other byte", () => {
    const line = '{ "\\u0069d" : 12345678901234567890 , "params":{"n":98765432109876543210,"s":"a\\"}{,\\\\"} }';
    expect(spliceTopLevelId(line, '"b"')).toBe('{ "\\u0069d" : "b" , "params":{"n":98765432109876543210,"s":"a\\"}{,\\\\"} }');
  });
  it("handles string, object and array id values, and nothing else is a number-looking member", () => {
    expect(spliceTopLevelId('{"id":"a\\"b","x":1}', "7")).toBe('{"id":7,"x":1}');
    expect(spliceTopLevelId('{"x":{"id":1},"id":null}', "7")).toBe('{"x":{"id":1},"id":7}');
    expect(spliceTopLevelId('{"idx":1,"xid":2}', "7")).toBeUndefined();
  });
  it("returns undefined for anything that is not an object with a top-level id", () => {
    for (const bad of ["", "[1]", "5", '{"id":', '{"id" 1}', '{"id":1', "not json", '{"method":"x"}', "{}"]) expect(spliceTopLevelId(bad, "1")).toBeUndefined();
  });
  it("topLevelIdText gives the raw text of the id, unchanged by number formatting", () => {
    expect(topLevelIdText('{"id":12345678901234567890,"method":"x"}')).toBe("12345678901234567890");
    expect(topLevelIdText('{"id":1.0,"params":{"id":2}}')).toBe("1.0");
    expect(topLevelIdText('{"id":"a","id":"b"}')).toBe('"b"');
    expect(topLevelIdText('{"method":"x"}')).toBeUndefined();
  });
});

describe("the cap (B-8 unit, B-8h, B-9b, B-3h identity)", () => {
  const capped = () => createBridgeIds({ nonce: NONCE, cap: 3 });
  const fill = (ids: ReturnType<typeof createBridgeIds>) => [1, 2, 3].map((n) => admit(ids, n));

  it("B-8 the 4th live request is refused with a tracked busy entry, and bridgeBusyFrame says what to do", () => {
    const ids = capped();
    fill(ids);
    const refused = ids.issue(keyOf(4), "4", fakeReq());
    expect(refused.admitted).toBe(false);
    expect(refused.entry.state).toBe("claimed");
    expect(ids.liveCount()).toBe(4);
    expect(bridgeBusyFrame(4, 3)).toEqual({ jsonrpc: "2.0", id: 4, error: { code: -32000, message: "This server already has 3 requests waiting. Try again in a moment." } });
    expect(bridgeBusyFrame(4).error.message).toBe(`This server already has ${MAX_BRIDGE_IN_FLIGHT.toLocaleString("en-US")} requests waiting. Try again in a moment.`);
    expect(MAX_BRIDGE_IN_FLIGHT).toBe(4096);
  });

  it("B-9b refusal repeats and live never exceeds cap + 1; settling the claimed entries re-admits", () => {
    const ids = capped();
    const claimed = fill(ids).map((c) => { expect(ids.take(c.bridgeId).kind).toBe("live"); return c.entry; });
    expect(ids.liveCount()).toBe(3);
    for (let i = 0; i < 5; i++) {
      const refused = ids.issue(keyOf(100 + i), String(100 + i), fakeReq());
      expect(refused.admitted).toBe(false);
      expect(ids.liveCount()).toBe(4);
      ids.settle(refused.entry);
      expect(ids.liveCount()).toBe(3);
    }
    for (const entry of claimed) ids.settle(entry);
    expect(ids.liveCount()).toBe(0);
    expect(ids.issue(keyOf(200), "200", fakeReq()).admitted).toBe(true);
  });

  it("an answer moves an entry open -> claimed and never adds one: admitted entries stay at or under the cap", () => {
    const ids = capped();
    const three = fill(ids);
    for (const c of three) ids.take(c.bridgeId);
    expect(ids.liveCount()).toBe(3);
    expect(ids.issue(keyOf(9), "9", fakeReq()).admitted).toBe(false); // claimed-but-unsettled still counts
  });

  it("B-8h a busy answer is revocable: a reuse of its id, or a cancel of it, revokes it before it is written", () => {
    for (const how of ["reuse", "cancel"] as const) {
      const ids = capped();
      fill(ids);
      const busy = ids.issue(keyOf(7), "7", fakeReq());
      expect(busy.admitted).toBe(false);
      const stillWanted = () => busy.entry.state === "claimed";
      expect(stillWanted()).toBe(true);
      if (how === "reuse") ids.issue(keyOf(7), "7", fakeReq());
      else expect(ids.cancelByEngine(keyOf(7))).toBeUndefined();
      expect(busy.entry.state).toBe("revoked");
      expect(stillWanted()).toBe(false);
    }
  });

  it("B-3h identity: a revoked A that settles after B took the key leaves B's mapping alone", () => {
    const ids = createBridgeIds({ nonce: NONCE });
    const a = admit(ids, 7);
    expect(ids.take(a.bridgeId).kind).toBe("live"); // A claimed (its frame is waiting on a publication)
    const b = admit(ids, 7); // the engine reuses 7: A is revoked
    expect(a.entry.state).toBe("revoked");
    ids.settle(a.entry as BridgeEntry); // A's respond promise settles
    expect(ids.liveCount()).toBe(1);
    expect(ids.cancelByEngine(keyOf(7))).toBe(b.bridgeId); // the engine cancels B: its own bridge id comes back
    expect(b.req.cancel).toHaveBeenCalledTimes(1);
    expect(ids.liveCount()).toBe(0);
  });
});
