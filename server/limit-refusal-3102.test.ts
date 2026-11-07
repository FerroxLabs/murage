// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// U15 #3102: Codex's "Try again at 5:23 PM" is read as today's reset time (not a one-hour guess), and a printed clock
// time whose minute has begun ends with that minute instead of rolling to tomorrow.

import { afterEach, describe, expect, it } from "vitest";
import { limitRefusal } from "./limit-refusal.ts";

const previousTz = process.env.TZ;
afterEach(() => { if (previousTz === undefined) delete process.env.TZ; else process.env.TZ = previousTz; });

const said = (time: string) => `You've hit your usage limit. Upgrade to Pro or try again at ${time}.`;
const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());

describe("U15 #3102 Codex try-again time", () => {
  it("reads a time-only reset as today's time", () => {
    const now = new Date(2026, 9, 19, 15, 0, 0).getTime();
    expect(limitRefusal("codex", { text: said("5:23 PM") }, now)).toEqual({ resetsAt: new Date(2026, 9, 19, 17, 23, 0).getTime() });
  });

  it("ends a reset minute that has already begun with that minute, never tomorrow", () => {
    const minute = new Date(2026, 9, 19, 17, 23, 0).getTime();
    expect(limitRefusal("codex", { text: said("5:23 PM") }, minute)?.resetsAt).toBe(minute + 59_999);
    expect(limitRefusal("codex", { text: said("5:23 PM") }, minute + 20_000)?.resetsAt).toBe(minute + 59_999);
    expect(limitRefusal("codex", { text: said("5:23 PM") }, minute + 90_000)?.resetsAt).toBe(minute + 59_999);
  });

  it("reads a full date as given", () => {
    const now = new Date(2026, 9, 15, 9, 0, 0).getTime();
    expect(limitRefusal("codex", { text: said("Oct 17th, 2026 5:23 PM") }, now)?.resetsAt).toBe(new Date(2026, 9, 17, 17, 23, 0).getTime());
  });

  // America/New_York repeats 1:00-1:59 AM on 2026-11-01 (05:00Z EDT, then 06:00Z EST).
  it("holds to the later instant of an hour a DST change repeats, so the hold never ends an hour early", () => {
    process.env.TZ = "America/New_York";
    expect(iso(limitRefusal("codex", { text: said("1:50 AM") }, Date.parse("2026-11-01T06:30:00Z"))?.resetsAt)).toBe("2026-11-01T06:50:00.000Z");
    expect(iso(limitRefusal("codex", { text: said("1:20 AM") }, Date.parse("2026-11-01T05:40:00Z"))?.resetsAt)).toBe("2026-11-01T06:20:00.000Z");
    // both instants still ahead: the words cannot say which, so the later one
    expect(iso(limitRefusal("codex", { text: said("1:50 AM") }, Date.parse("2026-11-01T05:30:00Z"))?.resetsAt)).toBe("2026-11-01T06:50:00.000Z");
    expect(iso(limitRefusal("codex", { text: said("Nov 1st, 2026 1:50 AM") }, Date.parse("2026-10-31T20:00:00Z"))?.resetsAt)).toBe("2026-11-01T06:50:00.000Z");
    // an hour no DST change repeats is unchanged
    expect(iso(limitRefusal("codex", { text: said("2:30 AM") }, Date.parse("2026-11-01T05:30:00Z"))?.resetsAt)).toBe("2026-11-01T07:30:00.000Z");
  });

  it("a structured reset time still wins over the prose", () => {
    const now = new Date(2026, 9, 19, 15, 0, 0).getTime();
    expect(limitRefusal("codex", { text: `${said("5:23 PM")} {"resets_in_seconds": 60}` }, now)?.resetsAt).toBe(now + 60_000);
  });

  it("a generic 'resets 3pm' read in its own minute ends with that minute", () => {
    const minute = new Date(2026, 9, 19, 15, 0, 0).getTime();
    expect(limitRefusal("claude", { text: "5-hour limit reached ∙ resets 3pm" }, minute + 20_000)?.resetsAt).toBe(minute + 59_999);
    // an hour past is still tomorrow, as before
    expect(limitRefusal("claude", { text: "5-hour limit reached ∙ resets 3pm" }, minute + 3_600_000)?.resetsAt).toBe(minute + 86_400_000);
  });
});
