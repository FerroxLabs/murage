// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { describe, expect, it } from "vitest";
import { redactUpstreamText } from "./remote-mcp-client.ts";
import { redact } from "./model-gateway.ts";
import { providerArguments, scrubKnown, scrubKnownLeaves, SecretStreamFilter } from "./drivers/openai-chat-tools.ts";
import { formatDiff } from "./browser-extension-snapshot.ts";

const a = "abcd" + "efgh";
const b = "efgh" + "ijkl";
const whole = "abcd" + "efgh" + "ijkl";
const masks = [
  ["remote MCP", redactUpstreamText],
  ["gateway", redact],
  ["tool result", (text: string, secrets: string[]) => scrubKnown(text, secrets)],
  ["tool replay", (text: string, secrets: string[]) => scrubKnownLeaves(text, secrets)],
  ["replayed arguments", (text: string, secrets: string[]) => (JSON.parse(providerArguments(JSON.stringify({ v: text }), secrets)) as { v: string }).v],
  ["stream", (text: string, secrets: string[]) => { const f = new SecretStreamFilter(secrets); return f.push(text) + f.flush(); }],
] as const;

describe.each(masks)("configured values: %s", (_name, mask) => {
  it("merges crossing matches in either order", () => {
    for (const secrets of [[a, b], [b, a]]) expect(mask(whole, secrets)).toBe("[redacted]");
  });
  it("merges nested matches", () => {
    expect(mask(whole, [a, whole])).toBe("[redacted]");
  });
  it("masks three occurrences and ignores an empty configured value", () => {
    expect(mask([a, a, a].join(" / "), ["", a])).toBe("[redacted] / [redacted] / [redacted]");
  });
});

it("replays malformed arguments as an empty object without the configured value", () => {
  const out = providerArguments(`{"v": "${whole}`, [a, b]);
  expect(out).toBe("{}");
});

it("masks crossing field values in browser diffs", () => {
  const node = { key: "new", ref: "b1", backendNodeId: 1, frameLoader: "frame", role: "button", name: whole, interactive: true, ordinal: 1 };
  const diff = formatDiff({ url: "https://example.com", nodes: [], dialogs: [] }, { url: "https://example.com", nodes: [node], dialogs: [] }, "https://example.com", [a, b]);
  expect(diff).toContain("[hidden]");
  expect(diff).not.toContain("ijkl");
});

it("keeps large dense overlap input within a linear work budget", () => {
  const run = (size: number) => {
    const input = ("ab" + "cd" + "ef").repeat(size);
    const start = performance.now();
    const output = redactUpstreamText(input, ["ab" + "cd", "cd" + "ef", "ef" + "ab"]);
    const ms = performance.now() - start;
    expect(output).toBe("[redacted]");
    return ms;
  };
  run(1000);
  const small = run(25_000);
  const large = run(250_000);
  expect(large).toBeLessThan(Math.max(2000, small * 20));
});

it("keeps an overlapping match pending across every stream split", () => {
  for (let cut = 0; cut <= whole.length; cut++) {
    const filter = new SecretStreamFilter([a, b]);
    expect(filter.push(whole.slice(0, cut)) + filter.push(whole.slice(cut)) + filter.flush()).toBe("[redacted]");
  }
});


it("streams a long crossing chain without buffering the whole answer", () => {
  const filter = new SecretStreamFilter(["ab" + "cd", "cd" + "ef", "ef" + "ab"]);
  let output = "";
  for (let i = 0; i < 20_000; i++) {
    output += filter.push("abc" + "def");
    if (i === 1) expect(output).toBe("[redacted]");
  }
  expect(output + filter.flush()).toBe("[redacted]");
});
