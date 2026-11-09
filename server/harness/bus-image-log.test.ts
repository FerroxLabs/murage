// Generated-image bytes must not reach the log people paste into bug reports.
//
// The ACP driver's `nativeLogMessage` carefully redacts image base64 out of
// native/<thread>.ndjson. The SAME payload went verbatim into
// events/<thread>.ndjson through EventBus.publish, because `redactSecrets`
// only knows about credential shapes. Two external audits called that lane
// clean; the sweep's own adversarial verifier caught it.
import { describe, expect, it } from "vitest";

import { EventBus } from "./bus.ts";

describe("the canonical event log", () => {
  const bigImage = "A".repeat(50_000);

  const captureAppend = () => {
    const writes: string[] = [];
    const bus = new EventBus(((_file: string, data: string) => {
      writes.push(data);
    }) as never);
    return { bus, writes };
  };

  it("keeps generated-image bytes out of events/*.ndjson", () => {
    const { bus, writes } = captureAppend();

    bus.publish({
      kind: "runtime",
      threadId: "thread-a",
      type: "item.completed",
      itemType: "assistant_image",
      data: bigImage,
    } as never);

    const written = writes.join("");
    expect(written).not.toContain(bigImage);
    // the shape survives, so the log still shows an image happened
    expect(written).toContain("assistant_image");
    // ql2 sink fold (was a "50000 base64 chars" stand-in): an image's data is not a logged field, so nothing of it is written
    expect(written).not.toContain("AAAA");
    expect(Object.hasOwn(JSON.parse(written.trim()), "data")).toBe(false);
  });

  // ql2 sink fold (was "leaves ordinary events untouched", the text on disk): an ordinary reply keeps its envelope and the fixed
  // reply label (runtime-event-out.ts REPLY_LOGGED_TEXT), never its words
  it("writes an ordinary reply as its envelope, never its words", () => {
    const { bus, writes } = captureAppend();

    bus.publish({
      kind: "runtime",
      threadId: "thread-b",
      type: "item.completed",
      itemType: "assistant_text",
      data: "an ordinary reply",
    } as never);

    expect(writes.join("")).toContain("assistant_text");
    expect(writes.join("")).not.toContain("an ordinary reply");
  });
});
