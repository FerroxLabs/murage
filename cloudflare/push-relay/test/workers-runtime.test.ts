import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Node's fetch accepts redirect: "error"; the Workers runtime throws on it
// ("won't be implemented ... at the edge"), which turned every APNs send into
// a silent network retry on the first device push (2026-09-27). "manual"
// never follows either: a 3xx comes back as a response, and every caller
// treats a non-OK answer as a refusal.
describe("code the Workers runtime accepts", () => {
  const dir = `${import.meta.dirname}/../src/`;
  const sources = readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => [f, readFileSync(dir + f, "utf8")] as const);
  it("never asks fetch for redirect: \"error\"", () => {
    for (const [file, text] of sources) expect(text, file).not.toMatch(/redirect:\s*"error"/);
  });
  it("every outbound fetch refuses to follow a redirect", () => {
    for (const [file, text] of sources) {
      for (const call of text.match(/fetch\w*\((?:url|OAUTH_URL|`https:[^`]*`)[^;]*?\{[^}]*/g) ?? []) expect(call, file).toContain('redirect: "manual"');
    }
  });
});
