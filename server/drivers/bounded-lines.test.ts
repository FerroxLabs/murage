// Unit contract for the byte-bounded engine stdout splitter (audit A4).
import { describe, expect, it } from "vitest";

import { createBoundedLineSplitter, ENGINE_FRAME_MAX_BYTES, frameOverflowMessage, type FrameOverflow } from "./bounded-lines.ts";

const collect = (maxBytes?: number) => {
  const lines: string[] = [];
  const overflows: FrameOverflow[] = [];
  const splitter = createBoundedLineSplitter({
    onLine: (line) => lines.push(line),
    onOverflow: (overflow) => overflows.push(overflow),
    maxBytes,
  });
  return { splitter, lines, overflows };
};

describe("createBoundedLineSplitter", () => {
  it("frames newline-terminated lines across arbitrary chunk boundaries", () => {
    const { splitter, lines, overflows } = collect();
    splitter.push('{"a":1}\n{"b"');
    splitter.push(":2}\n\n");
    splitter.push(Buffer.from('{"c":3}'));
    expect(lines).toEqual(['{"a":1}', '{"b":2}', ""]);
    expect(splitter.bufferedBytes).toBe(7);
    splitter.push("\n");
    expect(lines).toEqual(['{"a":1}', '{"b":2}', "", '{"c":3}']);
    expect(overflows).toEqual([]);
    expect(splitter.bufferedBytes).toBe(0);
  });

  it("decodes a multibyte character split between two reads", () => {
    const { splitter, lines } = collect();
    const bytes = Buffer.from('{"t":"héllo — 世界 🎉"}\n', "utf8");
    // split inside the 4-byte emoji and inside the 3-byte CJK character
    const emoji = bytes.indexOf(Buffer.from("🎉", "utf8"));
    const cjk = bytes.indexOf(Buffer.from("世", "utf8"));
    splitter.push(bytes.subarray(0, cjk + 1));
    splitter.push(bytes.subarray(cjk + 1, emoji + 2));
    splitter.push(bytes.subarray(emoji + 2));
    expect(lines).toEqual(['{"t":"héllo — 世界 🎉"}']);
    expect(JSON.parse(lines[0]!)).toEqual({ t: "héllo — 世界 🎉" });
  });

  it("accepts a frame of exactly the limit in bytes, counting UTF-8 bytes not characters", () => {
    const { splitter, lines, overflows } = collect(10);
    splitter.push(Buffer.from("ééééé\n", "utf8")); // 5 characters, 10 bytes
    expect(lines).toEqual(["ééééé"]);
    expect(overflows).toEqual([]);
    expect(splitter.closed).toBe(false);
  });

  it("reports a newline-terminated frame one byte over the limit and never delivers it", () => {
    const { splitter, lines, overflows } = collect(10);
    splitter.push(Buffer.from("ok\néééééx\n{\"after\":true}\n", "utf8"));
    expect(lines).toEqual(["ok"]);
    expect(overflows).toEqual([{ bytes: 11, limit: 10, terminated: true }]);
    expect(splitter.closed).toBe(true);
  });

  it("reports an unterminated frame as soon as it passes the limit, without waiting for a newline", () => {
    const { splitter, lines, overflows } = collect(16);
    splitter.push("0123456789");
    expect(overflows).toEqual([]);
    splitter.push("0123456"); // 17 bytes, no newline yet
    expect(overflows).toEqual([{ bytes: 17, limit: 16, terminated: false }]);
    expect(splitter.bufferedBytes).toBe(0);
    expect(lines).toEqual([]);
  });

  it("never truncates into apparent success: nothing after an overflow is delivered", () => {
    const { splitter, lines, overflows } = collect(16);
    splitter.push("x".repeat(20));
    splitter.push('\n{"type":"result","is_error":false}\n');
    splitter.push('{"type":"result","is_error":false}\n');
    expect(lines).toEqual([]);
    expect(overflows).toHaveLength(1);
  });

  it("holds at most the limit while an oversized frame streams in", () => {
    const { splitter, overflows } = collect(1024);
    const chunk = Buffer.alloc(100, 0x61);
    let pushed = 0;
    while (!splitter.closed) {
      splitter.push(chunk);
      pushed += chunk.length;
      expect(splitter.bufferedBytes).toBeLessThanOrEqual(1024);
      expect(pushed).toBeLessThanOrEqual(1100);
    }
    expect(overflows).toEqual([{ bytes: 1100, limit: 1024, terminated: false }]);
  });

  it("delivers lines framed before a handler throws and keeps framing consistent", () => {
    const seen: string[] = [];
    const splitter = createBoundedLineSplitter({
      onLine: (line) => {
        seen.push(line);
        if (line === "boom") throw new Error("handler failed");
      },
      onOverflow: () => {},
    });
    expect(() => splitter.push("a\nboom\npartial")).toThrow("handler failed");
    splitter.push("-rest\n");
    expect(seen).toEqual(["a", "boom", "partial-rest"]);
  });

  it("close() drops buffered bytes and ignores later input", () => {
    const { splitter, lines } = collect();
    splitter.push("half a frame");
    splitter.close();
    splitter.push(" and the rest\n");
    expect(lines).toEqual([]);
    expect(splitter.bufferedBytes).toBe(0);
  });

  it("admits a 10 MiB image as a base64 frame at the default limit", () => {
    const { splitter, lines, overflows } = collect();
    const base64 = Buffer.alloc(10 * 1024 * 1024, 7).toString("base64");
    const frame = JSON.stringify({ type: "image", data: base64 });
    expect(Buffer.byteLength(frame)).toBeLessThan(ENGINE_FRAME_MAX_BYTES);
    for (let i = 0; i < frame.length; i += 65_536) splitter.push(frame.slice(i, i + 65_536));
    splitter.push("\n");
    expect(overflows).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.length).toBe(frame.length);
  });

  it("rejects a non-positive limit", () => {
    expect(() => createBoundedLineSplitter({ onLine: () => {}, onOverflow: () => {}, maxBytes: 0 })).toThrow(RangeError);
  });

  it("describes the stop without echoing frame content", () => {
    expect(frameOverflowMessage("Codex", { bytes: ENGINE_FRAME_MAX_BYTES + 1, limit: ENGINE_FRAME_MAX_BYTES, terminated: false }))
      .toBe("Codex sent a protocol message larger than 32 MiB, so Murage stopped this turn instead of reading it. Other conversations were not affected.");
  });
});
