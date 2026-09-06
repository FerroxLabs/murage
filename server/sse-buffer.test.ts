import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { oversizedScreenNotice, SSE_MAX_PENDING_BYTES, SseReplay, SseWriter } from "./sse-buffer.ts";

class Sink extends EventEmitter {
  writableLength = 0;
  destroyed = false;
  accepting = true;
  writes: string[] = [];
  write(frame: string): boolean {
    this.writes.push(frame);
    if (!this.accepting) this.writableLength += Buffer.byteLength(frame);
    return this.accepting;
  }
  destroy() { this.destroyed = true; this.emit("close"); }
  drain() { this.writableLength = 0; this.accepting = true; this.emit("drain"); }
}

describe("SSE writer", () => {
  it.each([1, 5, 10])("keeps the default 4 MiB budget independent across %i delayed consumers", count => {
    const clients = Array.from({ length: count }, () => {
      const sink = new Sink(); sink.accepting = false;
      const reasons: string[] = [];
      return { sink, reasons, writer: new SseWriter(sink, reason => reasons.push(reason)) };
    });
    const frame = "x".repeat(1024 * 1024);
    for (let n = 0; n < 3; n++) for (const client of clients) expect(client.writer.send(frame)).toBe(true);
    expect(clients.reduce((total, client) => total + client.writer.pendingBytes, 0)).toBeLessThanOrEqual(count * SSE_MAX_PENDING_BYTES);
    // One delayed consumer catches up. Overflowing its peers must not close it
    // or duplicate its write(false)-accepted frame when drain arrives later.
    clients[0].sink.drain();
    expect(clients[0].sink.writes).toHaveLength(3);
    for (const client of clients) expect(client.writer.send(frame)).toBe(client === clients[0]);
    for (const [index, client] of clients.entries()) {
      expect(client.writer.peakPendingBytes).toBeLessThanOrEqual(SSE_MAX_PENDING_BYTES);
      if (index === 0) {
        expect(client.reasons).toEqual([]);
        expect(client.sink.writes).toHaveLength(4);
      } else {
        expect(client.reasons).toEqual(["backpressure"]);
        expect(client.writer.closed).toBe(true);
        expect(client.writer.pendingBytes).toBe(0);
        client.sink.drain();
        expect(client.sink.writes).toHaveLength(1);
      }
      client.writer.close();
      expect(client.writer.queuedFrames).toBe(0);
      for (const event of ["drain", "close", "error"]) expect(client.sink.listenerCount(event)).toBe(0);
    }
  });

  it("queues after backpressure and drains in order without duplicating the accepted frame", () => {
    const sink = new Sink();
    sink.accepting = false;
    const reasons: string[] = [];
    const writer = new SseWriter(sink, (reason) => reasons.push(reason));
    writer.send("hello");
    writer.send("replay");
    writer.send("ping");
    writer.send("live");
    expect(sink.writes).toEqual(["hello"]);
    expect(writer.queuedFrames).toBe(3);
    sink.drain();
    expect(sink.writes).toEqual(["hello", "replay", "ping", "live"]);
    expect(writer.pendingBytes).toBe(0);
    expect(reasons).toEqual([]);
    writer.close();
  });

  it("counts UTF-8 bytes and closes only the overflowing consumer", () => {
    const slow = new Sink();
    const healthy = new Sink();
    slow.accepting = false;
    const reasons: string[] = [];
    const writer = new SseWriter(slow, (reason) => reasons.push(reason), { maxBytes: 128 });
    const other = new SseWriter(healthy, () => {});
    for (let n = 0; n < 8; n++) {
      writer.send("😀".repeat(8));
      other.send(String(n));
    }
    expect(reasons).toEqual(["backpressure"]);
    expect(writer.closed).toBe(true);
    expect(writer.pendingBytes).toBe(0);
    expect(writer.peakPendingBytes).toBeLessThanOrEqual(128);
    expect(healthy.writes).toHaveLength(8);
    expect(other.closed).toBe(false);
    other.close();
  });

  it("bounds tiny queued frames by count and removes drain/close/error listeners", () => {
    const sink = new Sink();
    sink.accepting = false;
    const reasons: string[] = [];
    const writer = new SseWriter(sink, (reason) => reasons.push(reason), { maxFrames: 2 });
    writer.send("a");
    writer.send("b");
    writer.send("c");
    writer.send("d");
    expect(reasons).toEqual(["backpressure"]);
    expect(writer.peakQueuedFrames).toBe(2);
    expect(writer.queuedFrames).toBe(0);
    expect(sink.listenerCount("drain")).toBe(0);
    expect(sink.listenerCount("close")).toBe(0);
    expect(sink.listenerCount("error")).toBe(0);
    sink.drain();
    expect(sink.writes).toEqual(["a"]);
  });

  it("refuses an oversized required frame before passing it to Node", () => {
    const sink = new Sink();
    const reasons: string[] = [];
    const writer = new SseWriter(sink, (reason) => reasons.push(reason), { maxFrameBytes: 10 });
    expect(writer.send("x".repeat(11))).toBe(false);
    expect(sink.writes).toEqual([]);
    expect(reasons).toEqual(["oversized"]);
  });

  it("accepts a large preview that remains inside the two-MiB frame budget", () => {
    const sink = new Sink();
    const writer = new SseWriter(sink, () => {});
    const frame = "x".repeat(1_500_000);
    expect(writer.send(frame)).toBe(true);
    expect(sink.writes[0].length).toBe(1_500_000);
    expect(writer.closed).toBe(false);
    writer.close();
  });

  it("cleans up a transport error while frames are pending", () => {
    const sink = new Sink();
    sink.accepting = false;
    const reasons: string[] = [];
    const writer = new SseWriter(sink, (reason) => reasons.push(reason));
    writer.send("accepted");
    writer.send("queued");
    sink.emit("error", new Error("connection failed"));
    expect(reasons).toEqual(["error"]);
    expect(writer.queuedFrames).toBe(0);
    expect(sink.destroyed).toBe(true);
  });

  it("accounts for bytes already retained by the HTTP response", () => {
    const sink = new Sink();
    sink.writableLength = 120;
    const writer = new SseWriter(sink, () => {}, { maxBytes: 128 });
    expect(writer.send("a")).toBe(false);
    expect(sink.writes).toEqual([]);
  });

  it("cleans a pending queue when its peer closes", () => {
    const sink = new Sink();
    sink.accepting = false;
    const writer = new SseWriter(sink, () => {});
    writer.send("hello");
    writer.send("pending");
    sink.destroy();
    expect(writer.closed).toBe(true);
    expect(writer.pendingBytes).toBe(0);
    expect(sink.listenerCount("drain")).toBe(0);
  });
});

const meta = (seq: number, botId = "visible", kind = "message") => ({ seq, kind, subject: { scope: "bot" as const, botId } });

describe("SSE replay", () => {
  it("evicts on bytes as well as count and marks the old cursor as a gap", () => {
    const replay = new SseReplay({ maxBytes: 20, maxEntries: 3, maxFrameBytes: 20 });
    replay.append(meta(1), "a".repeat(12));
    replay.append(meta(2), "b".repeat(12));
    expect(replay.bytes).toBe(12);
    expect(replay.count).toBe(1);
    expect(replay.prepare(0, 2, () => true).resumed).toBe(false);
    expect(replay.prepare(1, 2, () => true)).toEqual({ resumed: true, frames: ["b".repeat(12)] });
    for (let seq = 3; seq < 10; seq++) replay.append(meta(seq, "visible", "screen"), "huge image".repeat(50));
    expect(replay.bytes).toBe(0);
    expect(replay.count).toBe(3);
  });

  it("requires one snapshot for an oversized durable gap, then honors its new cursor", () => {
    const replay = new SseReplay({ maxBytes: 100, maxEntries: 5, maxFrameBytes: 20 });
    replay.append(meta(1), "large".repeat(10));
    expect(replay.bytes).toBe(0);
    expect(replay.prepare(0, 1, () => true).resumed).toBe(false);
    replay.append(meta(2), "terminal marker");
    expect(replay.prepare(1, 2, () => true)).toEqual({ resumed: true, frames: ["terminal marker"] });
  });

  it("applies visibility to gaps and payloads before deciding whether replay is possible", () => {
    const replay = new SseReplay({ maxBytes: 100, maxEntries: 5, maxFrameBytes: 20 });
    replay.append(meta(1, "hidden"), "private".repeat(10));
    replay.append(meta(2), "ordinary");
    expect(replay.prepare(0, 2, (entry) => entry.subject.scope === "bot" && entry.subject.botId === "visible"))
      .toEqual({ resumed: true, frames: ["ordinary"] });
    expect(replay.prepare(0, 2, () => true).resumed).toBe(false);
  });

  it("falls back to a snapshot before overflowing a replaying consumer", () => {
    const replay = new SseReplay();
    replay.append(meta(1), "a");
    replay.append(meta(2), "b");
    expect(replay.prepare(0, 2, () => true, { maxBytes: 1000, maxFrames: 1 }).resumed).toBe(false);
    expect(replay.prepare(0, 2, () => true, { maxBytes: 1, maxFrames: 20 }).resumed).toBe(false);
  });

  it("keeps screen sequence slots without pixels or a required replay gap", () => {
    const replay = new SseReplay();
    replay.append(meta(1, "visible", "screen"), "x".repeat(3 * 1024 * 1024));
    expect(replay.bytes).toBe(0);
    expect(replay.prepare(0, 1, () => true)).toEqual({ resumed: true, frames: [] });
    const notice = oversizedScreenNotice("stream", 1, "visible");
    expect(Buffer.byteLength(notice)).toBeLessThan(512);
    expect(notice).toContain("screen.unavailable");
    expect(notice).toContain("last preview is unchanged");
    const sink = new Sink();
    const writer = new SseWriter(sink, () => {});
    writer.send(notice);
    writer.send("next ordinary preview");
    expect(writer.closed).toBe(false);
    expect(sink.writes).toEqual([notice, "next ordinary preview"]);
    writer.close();
  });
});
