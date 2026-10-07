// SPDX-License-Identifier: AGPL-3.0-or-later
// F2 of the wave 1 security review: one rule for "this link holds a token".
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { MASK, displayUrl, isOpaqueSegment, maskPathname, urlHasSecret } from "./mcp-secret-url.mjs";

describe("isOpaqueSegment", () => {
  it.each([
    ["abcdefghijklmnopqrstuvwx", "24 plain characters"],
    ["Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA==", "padded base64"],
    ["Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA", "unpadded base64"],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF123", "JWT with dots"],
    ["eyJhbGciOiJIUzI1NiJ9.e", "short JWT shape"],
    ["abcDEF123456789012", "18 characters mixing letters and digits"],
    ["sk~live.0123456789abcdefghij", "token with ~ and ."],
    ["AbCdEfGhIjKlMnOp", "16 upper and lower case"],
    ["some-very-long-descriptive-slug-name", "36 characters of anything"],
    ["%E2%80%A2%E2%80%A2%E2%80%A2x", "percent-encoded run"],
    ["1234567890123456", "16 digits (MCP-LINK L3)"],
    ["12345678901234567890", "20 digits"],
    ["12345678901234567890123", "23 digits"],
  ])("%s is opaque (%s)", (segment) => {
    expect(isOpaqueSegment(segment)).toBe(true);
  });

  it.each([
    "mcp", "sse", "v1", "api", "s", "", "messages", "2025-06-18", "documentation-overview", "abcdefghijklmnop",
    "1234567890123", "123456789012345", "ABCDEFGHIJKLMNOP", ".well-known", MASK,
  ])("%s is not opaque", (segment) => {
    expect(isOpaqueSegment(segment)).toBe(false);
  });
});

describe("urlHasSecret and the masks", () => {
  it("flags userinfo, query, and an opaque path segment, and nothing else", () => {
    expect(urlHasSecret("https://cloud.comfy.org/mcp")).toBe(false);
    expect(urlHasSecret("https://x.example/mcp?k=1")).toBe(true);
    expect(urlHasSecret("https://me:pw@x.example/mcp")).toBe(true);
    expect(urlHasSecret("https://me@x.example/mcp")).toBe(true);
    expect(urlHasSecret("https://x.example/sse/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF123")).toBe(true);
    expect(urlHasSecret("https://mcp.example/s/Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA==/mcp")).toBe(true);
    expect(urlHasSecret("https://mcp.example/s/abcDEF123456789012/mcp")).toBe(true);
    expect(urlHasSecret("nonsense")).toBe(false);
  });

  it("a stored mask, raw or percent-encoded by URL parsing, is not a token", () => {
    expect(isOpaqueSegment(encodeURIComponent(MASK))).toBe(false);
    expect(urlHasSecret("https://h.example/s/\u2022\u2022\u2022/mcp")).toBe(false);
  });

  it("masks a pathname segment by segment", () => {
    expect(maskPathname("/s/abcDEF123456789012/mcp")).toBe(`/s/${MASK}/mcp`);
    expect(maskPathname("/mcp")).toBe("/mcp");
    expect(maskPathname(`/s/${MASK}/mcp`)).toBe(`/s/${MASK}/mcp`);
  });

  it("displayUrl leaks none of the four token shapes from the wave 1 review", () => {
    for (const url of [
      "https://x.example/sse/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF123",
      "https://mcp.example/s/Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA==/mcp",
      "https://mcp.example/s/abcDEF123456789012/mcp",
      "https://mcp.example/k/sk~live.0123456789abcdefghij/mcp",
    ]) {
      const shown = displayUrl(url);
      expect(shown).toContain(MASK);
      expect(shown).not.toMatch(/eyJ|Zm9v|abcDEF|sk~live/);
    }
    expect(displayUrl("https://me:pw@h.example/mcp?k=SECRET#f")).toBe("https://h.example/mcp");
    expect(displayUrl("ftp://x/")).toBe("");
    expect(displayUrl("nonsense")).toBe("");
  });

  it("carries the license header and imports nothing", () => {
    const source = readFileSync(new URL("./mcp-secret-url.mjs", import.meta.url), "utf8");
    expect(source).toContain("SPDX-License-Identifier: AGPL-3.0-or-later");
    expect(source).not.toMatch(/^import /m);
  });
});
