// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { sessionFor } from "../src/d1-session";

function fakeDb(primaryFirst = 0) {
  const calls: string[] = [];
  let primaryLeft = primaryFirst;
  const db = {
    withSession: (c: string) => {
      calls.push(c);
      const onPrimary = primaryLeft-- > 0;
      return { prepare: (s: string) => ({ run: () => ({ meta: { served_by_primary: onPrimary } }), s }), batch: () => [], getBookmark: () => "bm-1" };
    },
    exec: () => "exec",
  } as unknown as D1Database;
  return { db, calls };
}
const req = (path: string, method = "GET", headers: Record<string, string> = {}) => new Request(`https://x.test${path}`, { method, headers });

describe("D1 read replication sessions", () => {
  it("reads the two customer GETs from the nearest replica", () => {
    for (const path of ["/v1/account/cloud", "/v1/homes"]) {
      const { db, calls } = fakeDb();
      const s = sessionFor(db, req(path));
      expect(calls).toEqual(["first-unconstrained"]);
      expect(s.bookmark()).toBe("bm-1");
      expect((s.db as unknown as { exec: () => string }).exec()).toBe("exec");
    }
  });
  it("honours a client bookmark on those GETs, and ignores a malformed one", () => {
    const a = fakeDb(); sessionFor(a.db, req("/v1/homes", "GET", { "x-d1-bookmark": "00000085-0000024c-00004c6d" }));
    expect(a.calls).toEqual(["00000085-0000024c-00004c6d"]);
    const b = fakeDb(); sessionFor(b.db, req("/v1/homes", "GET", { "x-d1-bookmark": "bad value;drop" }));
    expect(b.calls).toEqual(["first-unconstrained"]);
  });
  it("keeps customer writes on the primary, and everything else on the raw binding", () => {
    const w = fakeDb(); sessionFor(w.db, req("/v1/account/cancel", "POST", { "x-d1-bookmark": "00000085-0000024c-00004c6d" }));
    expect(w.calls).toEqual(["first-primary"]);
    for (const [path, method] of [["/v1/me", "GET"], ["/v1/account/other", "GET"], ["/v1/installations", "POST"], ["/api/auth/sign-in", "POST"]] as const) {
      const o = fakeDb(); const s = sessionFor(o.db, req(path, method));
      expect(o.calls).toEqual([]);
      expect(s.db).toBe(o.db);
      expect(s.bookmark()).toBeNull();
    }
  });
});

describe("the session facade", () => {
  it("exposes the raw binding as .primary for the one write a read-only GET makes", () => {
    const { db } = fakeDb();
    const s = sessionFor(db, new Request("https://x.test/v1/account/cloud"));
    expect((s.db as unknown as { primary: D1Database }).primary).toBe(db);
  });
});
