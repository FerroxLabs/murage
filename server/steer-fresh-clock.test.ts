// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// STEER-NO-NOW-LINE, scoped (MurageMain 2026-11-06): a mid-turn steer to a Fuigo or Grok bot carries a fresh now line as its own
// prompt part; a Claude steer (and every other engine's) is the owner's words alone, as in 1.0.17.
import { describe, expect, it } from "vitest";

import { freshClockSteer, steerWithQuoteLineage } from "./steer-lineage.ts";

const NOW = "It is now Friday 6 November 2026, 9:12 am (09:12) in the owner's time zone, Europe/London (UTC+0).";

function engine(provider: string) {
  const sent: string[] = [];
  const adapter = {
    provider,
    capabilities: { queueing: true },
    steer: async (_thread: string, text: unknown, beforeWrite?: () => void) => { beforeWrite?.(); sent.push(String(text)); return true; },
  };
  return { adapter, sent };
}

/** What the desk steer in index.ts does: the now line only when the gate says so. */
async function deskSteer(provider: string, words: string) {
  const { adapter, sent } = engine(provider);
  const result = await steerWithQuoteLineage(adapter, "t", words, true, {
    holds: () => true, steerId: `s-${provider}`, lineage: undefined,
    ...(freshClockSteer(adapter) ? { now: NOW } : {}),
  });
  expect(result).toBe("steer");
  expect(sent).toHaveLength(1);
  return sent[0]!;
}

describe("which steers carry a fresh clock", () => {
  it("is Fuigo and Grok only", () => {
    expect(freshClockSteer({ provider: "fuigoAgent" })).toBe(true);
    expect(freshClockSteer({ provider: "grokAgent" })).toBe(true);
    for (const provider of ["claude", "codex", "pi", "acp", "openaiChat", "kimiAgent", ""]) expect(freshClockSteer({ provider }), provider).toBe(false);
    expect(freshClockSteer(undefined)).toBe(false);
  });

  it("a Fuigo or Grok steer sends the now line as its own part, ahead of the words, which stay as sent", async () => {
    for (const provider of ["fuigoAgent", "grokAgent"]) {
      expect(await deskSteer(provider, "and use the side door"), provider).toBe(`${NOW}\n\nand use the side door`);
    }
  });

  it("a Claude steer is the owner's words alone", async () => {
    expect(await deskSteer("claude", "and use the side door")).toBe("and use the side door");
  });
});
