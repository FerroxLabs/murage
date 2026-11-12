// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { fixtureRequested } from "./fixture-request.ts";

const M = "__fixture_hold_authority__";
const pack = (id: string, body = "{\"rows\":[]}") => `<<page-content id=${id} origin=yourchatwithsource kind=delegation-context>>\n${body}\n<<end page-content id=${id}>>`;

describe("fixtureRequested", () => {
  // A delegated turn's prompt carries the pack block after the message: the hold marker must still hold the turn, so a Stop finds it live.
  it("accepts the marker ahead of a trailing delegation-context block", () => {
    expect(fixtureRequested(`intro\n\n${M} delegated target request\n\n${pack("abc123")}`, M)).toBe(true);
    expect(fixtureRequested(`${M} one line\n\n${pack("abc123", `{"text":"line\\nmore"}\nsecond line`)}`, M)).toBe(true);
  });
  it("still rejects a marker that is not the request", () => {
    expect(fixtureRequested(`${M} first\nthe real last line\n\n${pack("abc123")}`, M)).toBe(false);
    expect(fixtureRequested(`delegated request\n\n${pack("abc123", `${M} inside the lent rows`)}`, M)).toBe(false);
    expect(fixtureRequested(`plain request\n\n${pack("abc123")}`, M)).toBe(false);
  });
  it("strips every trailing pack, up to the three dispatch can append", () => {
    expect(fixtureRequested(`${M} two packs\n\n${pack("aaa111")}\n\n${pack("bbb222")}`, M)).toBe(true);
    expect(fixtureRequested(`${M} three packs\n\n${pack("aaa111")}\n\n${pack("bbb222")}\n\n${pack("ccc333", `x\n${M}`)}`, M)).toBe(true);
    expect(fixtureRequested(`plain\n\n${pack("aaa111")}\n\n${pack("bbb222", `${M} inside`)}\n\n${pack("ccc333")}`, M)).toBe(false);
  });
  it("keeps the room reply trailer rule", () => {
    expect(fixtureRequested(`${M} room\n\n(Reply to the conversation above as Ada.)`, M)).toBe(true);
  });
  it("keeps the bounded multi-pack behavior when fake engines share the helper", () => {
    const trailers = ["1111111111111111", "2222222222222222", "3333333333333333"]
      .map(id => pack(id, `${M} quoted in reference data`)).join("\n\n");
    expect(fixtureRequested(`${M} current request\n\n${trailers}`, M)).toBe(true);
    expect(fixtureRequested(`ordinary current request\n\n${trailers}`, M)).toBe(false);
  });
});
