// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.1 Episode 1: a "Waiting for a tool-capable engine" line stayed in the
// conversation after the engine was ready.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HeldQueueRow } from "./EngineNotes";
import { heldQueueText, heldQueueWaiting } from "../../server/external-context-delivery";

describe("the queue row says only what still waits", () => {
  it("does not count a delegated result once the engine has tools: the next turn carries it", () => {
    expect(heldQueueWaiting({ held: 0, external: 2, routeHasTools: true })).toBe(0);
    expect(heldQueueWaiting({ held: 0, external: 2, routeHasTools: false })).toBe(2);
    expect(heldQueueWaiting({ held: 1, external: 2, routeHasTools: true })).toBe(1);
  });

  it("leaves the transcript once nothing waits", () => {
    const row = (count: number) => renderToStaticMarkup(createElement(HeldQueueRow, { text: count ? heldQueueText(count) : "Held items were delivered to a tool-capable engine.", count, onJump: () => {} }));
    expect(row(1)).toContain("Waiting for a tool-capable engine");
    expect(row(0)).toBe("");
  });

  it("is settled by the server when the engine becomes ready, at turn start and turn end", () => {
    const index = readFileSync(join(__dirname, "../../server/index.ts"), "utf8");
    const note = index.slice(index.indexOf("function noteHeldQueue("), index.indexOf("const heldDispatches"));
    // the count ignores results a tool-capable engine will carry anyway
    expect(note).toContain("heldQueueWaiting(");
    // a settled row frees the slot, so a later wait starts a fresh row
    expect(note).toContain("setTaskHeldQueueRow(botId, threadId, undefined)");
    // engine reloads look at every queue row again
    expect(index.match(/refreshHeldQueues\(\);/g)?.length).toBeGreaterThanOrEqual(2);
    // group conversations hide a settled row too
    const group = readFileSync(join(__dirname, "GroupView.tsx"), "utf8");
    expect(group).toContain("settledHeldQueue(m.murage.held.count) ? null");
  });
});
