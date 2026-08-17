// The scrubber, against payloads built to contain what it removes.
//
// The proxy test proves nothing leaks through end to end. It cannot prove
// the scrubber does any work, because whether the harness leaks depends on
// which version is checked out. That is what these pin.
import { describe, expect, it } from "vitest";

import { createSseScrubber, isJson, scrub } from "../src/wire.ts";

describe("scrub", () => {
  it("removes resumeCursors wherever it is nested", () => {
    const bot = {
      id: "b1",
      name: "Rio",
      resumeCursors: { ghost: "session-abc" },
      tasks: [
        { threadId: "t1", title: "One", resumeCursors: { ghost: "session-def" } },
        { threadId: "t2", title: "Two" },
      ],
    };
    const cleaned = scrub({ bots: [bot], groups: [] });

    expect(JSON.stringify(cleaned)).not.toContain("resumeCursors");
    expect(JSON.stringify(cleaned)).not.toContain("session-abc");
    expect(JSON.stringify(cleaned)).not.toContain("session-def");
    // and nothing else was disturbed
    expect(cleaned).toEqual({
      bots: [{ id: "b1", name: "Rio", tasks: [{ threadId: "t1", title: "One" }, { threadId: "t2", title: "Two" }] }],
      groups: [],
    });
  });

  it("leaves values it does not own alone", () => {
    expect(scrub(null)).toBe(null);
    expect(scrub(42)).toBe(42);
    expect(scrub("resumeCursors")).toBe("resumeCursors"); // a string, not a key
    expect(scrub([1, [2, [3]]])).toEqual([1, [2, [3]]]);
  });
});

describe("isJson", () => {
  it("matches only real JSON content types", () => {
    expect(isJson("application/json")).toBe(true);
    expect(isJson("application/json; charset=utf-8")).toBe(true);
    expect(isJson("APPLICATION/JSON")).toBe(true);
    expect(isJson("image/png")).toBe(false);
    expect(isJson("text/event-stream")).toBe(false);
    expect(isJson(undefined)).toBe(false);
  });
});

describe("createSseScrubber", () => {
  it("keeps the blank-line terminator that ends an event", () => {
    // The failure this guards against is silent: a stream that never
    // terminates an event parses to nothing while both ends look healthy.
    const out = createSseScrubber()('data: {"kind":"hello"}\n\n');
    expect(out).toBe('data: {"kind":"hello"}\n\n');
    expect(out.endsWith("\n\n")).toBe(true);
  });

  it("scrubs the payload but never the id: line", () => {
    const frame = 'id: abc123:7\ndata: {"kind":"bot","bot":{"id":"b1","resumeCursors":{"g":"s"}}}\n\n';
    const out = createSseScrubber()(frame);

    expect(out).toContain("id: abc123:7\n");
    expect(out).not.toContain("resumeCursors");
    const data = JSON.parse(out.split("\n").find((l) => l.startsWith("data:"))!.slice(5));
    expect(data).toEqual({ kind: "bot", bot: { id: "b1" } });
  });

  it("emits an event as soon as it is complete, not when the chunk ends", () => {
    const scrubStream = createSseScrubber();
    // one event split across three arbitrary chunk boundaries
    expect(scrubStream('id: a:1\nda')).toBe("");
    expect(scrubStream('ta: {"kind":"bot"}')).toBe("");
    expect(scrubStream("\n\nid: a:2\n")).toBe('id: a:1\ndata: {"kind":"bot"}\n\n');
    // the second event is still incomplete and correctly withheld
    expect(scrubStream('data: {"kind":"message"}\n\n')).toBe('id: a:2\ndata: {"kind":"message"}\n\n');
  });

  it("passes keepalive comments and unparseable data through untouched", () => {
    const scrubStream = createSseScrubber();
    expect(scrubStream(": keepalive\n\n")).toBe(": keepalive\n\n");
    expect(scrubStream("data: not json at all\n\n")).toBe("data: not json at all\n\n");
  });

  it("handles several events arriving in one chunk", () => {
    const out = createSseScrubber()(
      'id: a:1\ndata: {"a":1,"resumeCursors":{}}\n\nid: a:2\ndata: {"b":2}\n\n',
    );
    expect(out).toBe('id: a:1\ndata: {"a":1}\n\nid: a:2\ndata: {"b":2}\n\n');
  });

  it("gives up on a frame boundary that never arrives", () => {
    // A CRLF-framed stream contains no "\n\n" at all, so every byte would be
    // buffered forever waiting for a terminator that cannot appear. The two
    // realistic sources are an intermediary that rewrites line endings and a
    // content-type claiming event-stream over something that is not one.
    const scrubStream = createSseScrubber();
    const megabyte = "x".repeat(1024 * 1024);

    expect(scrubStream(`data: ${megabyte}\r\n\r\n`)).toBe("");
    // Whatever it was holding is gone rather than growing: a well-formed
    // event after the drop still comes out whole, which is the property that
    // matters — the stream stays live instead of dying with the buffer.
    expect(scrubStream('data: {"kind":"hello"}\n\n')).toBe('data: {"kind":"hello"}\n\n');
  });

  it("does not drop a large but well-formed event", () => {
    // The cap must sit clear of anything real, or a big-but-legitimate frame
    // would vanish and look exactly like a bug in the harness.
    const big = JSON.stringify({ kind: "bot", blob: "y".repeat(200 * 1024) });
    const out = createSseScrubber()(`data: ${big}\n\n`);
    expect(out).toBe(`data: ${big}\n\n`);
  });
});
