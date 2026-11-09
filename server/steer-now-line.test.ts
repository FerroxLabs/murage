// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// STEER-NO-NOW-LINE: a steer sent mid-turn carries a fresh date and time line, so the bot does not keep the turn-start time.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { steerWithQuoteLineage } from "./steer-lineage.ts";

function recordingEngine() {
  const sent: unknown[] = [];
  const adapter = {
    capabilities: { queueing: true },
    steer: async (_thread: string, text: unknown, beforeWrite?: () => void) => { beforeWrite?.(); sent.push(text); return true; },
  };
  return { adapter, sent };
}

const NOW = " It is now Thursday 5 November 2026, 3:04 pm (15:04) in the owner's time zone, Europe/London (UTC+0).";

describe("a steer carries the time it was sent", () => {
  it("puts the now line on top of the owner's words", async () => {
    const engine = recordingEngine();
    expect(await steerWithQuoteLineage(engine.adapter, "t", "and use the side door", true, {
      holds: () => true, steerId: "s-now", lineage: undefined, now: NOW,
    })).toBe("steer");
    const text = JSON.stringify(engine.sent);
    expect(text).toContain("It is now Thursday 5 November 2026, 3:04 pm");
    expect(text.indexOf("It is now")).toBeLessThan(text.indexOf("and use the side door"));
  });

  it("leaves the words alone when no line is given", async () => {
    const engine = recordingEngine();
    await steerWithQuoteLineage(engine.adapter, "t", "and use the side door", true, { holds: () => true, steerId: "s-bare", lineage: undefined });
    expect(JSON.stringify(engine.sent)).not.toContain("It is now");
  });

  it("the desk steer passes a fresh now line", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");
    const call = source.indexOf("steerWithQuoteLineage(instance?.adapter");
    expect(call).toBeGreaterThan(0);
    const end = source.indexOf("});", source.indexOf("onFence: steerReceiver.atFence", call));
    expect(source.slice(call, end)).toMatch(/now: nowPrompt\(new Date\(\), routineTimeZone\(\)\)/);
  });
});
