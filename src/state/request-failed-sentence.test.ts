// 0.1.60 audit C3: api() fell back to `${status} ${statusText}` ("502 Bad
// Gateway") when the harness answered without a sentence of its own.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { requestFailedSentence } from "./store";

describe("a failed request without a sentence of its own", () => {
  it.each([400, 401, 403, 404, 408, 409, 429, 500, 502, 503, 504])("%i is a plain sentence", status => {
    const text = requestFailedSentence(status);
    expect(text).toMatch(/^[A-Z].*\.$/);
    expect(text).not.toMatch(/\b\d{3}\b|Bad Gateway|Internal Server Error|Not Found/);
  });
  it("api() uses it, not the status line", () => {
    const source = readFileSync(new URL("./store.tsx", import.meta.url), "utf8");
    const call = source.slice(source.indexOf("export async function api("), source.indexOf("export { requestFailedSentence }"));
    expect(call).toContain("body.error ?? requestFailedSentence(res.status)");
    expect(call).not.toMatch(/statusText/);
    // …and so does the workspace pane's own fetch.
    expect(readFileSync(new URL("../lib/workspace-pane.ts", import.meta.url), "utf8")).not.toMatch(/statusText\}/);
  });
});
