// B5 (U36 code review round 1): every status GET /api/sends/:threadId/:sendId can answer, and how a draft record reads it
// (design section 5). `failed` may be retried under the same id, so it keeps the pin ("none"); so does anything unknown.
import { describe, expect, it } from "vitest";
import { sendLookupResult } from "./store";

describe("sendLookupResult", () => {
  it.each([
    ["sending", "ack"],
    ["queued", "ack"],
    ["dispatched", "ack"],
    ["started", "ack"],
    ["delivered", "ack"],
    ["unconfirmed", "ack"],
    ["refused", "refused"],
    ["cancelled", "cancelled"],
    ["failed", "none"],
    [undefined, "none"],
    [null, "none"],
    ["", "none"],
    ["Delivered", "none"],
    [42, "none"],
  ] as const)("%s -> %s", (status, expected) => {
    expect(sendLookupResult(status)).toBe(expected);
  });
});
