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
    expect(written).toContain("50000 base64 chars");
  });

  it("leaves ordinary events untouched", () => {
    const { bus, writes } = captureAppend();

    bus.publish({
      kind: "runtime",
      threadId: "thread-b",
      type: "item.completed",
      itemType: "assistant_text",
      data: "an ordinary reply",
    } as never);

    expect(writes.join("")).toContain("an ordinary reply");
  });
});
