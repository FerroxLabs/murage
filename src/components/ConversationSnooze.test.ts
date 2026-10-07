// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QuestionBadge, SnoozeChoices, SnoozedMarker } from "./ConversationSnooze";

const now = Date.parse("2026-09-24T15:30:00-04:00");
const clock = { timeZone: "America/New_York", locale: "en-US" };
const noop = () => {};

describe("the question badge", () => {
  it("names itself unless the row already does, and draws nothing at zero", () => {
    expect(renderToStaticMarkup(createElement(QuestionBadge, { count: 2 }))).toContain('aria-label="2 questions for you"');
    const quiet = renderToStaticMarkup(createElement(QuestionBadge, { count: 1, labelled: false }));
    expect(quiet).toContain('aria-hidden="true"');
    expect(quiet).not.toContain("aria-label");
    expect(renderToStaticMarkup(createElement(QuestionBadge, { count: 0 }))).toBe("");
  });
});

describe("the snoozed marker", () => {
  it("spells out the time, or is a decorated icon inside a row that says it", () => {
    const until = Date.parse("2026-09-25T09:00:00-04:00");
    expect(renderToStaticMarkup(createElement(SnoozedMarker, { until, now, clock }))).toContain(">Snoozed until tomorrow, 9:00 AM<");
    const icon = renderToStaticMarkup(createElement(SnoozedMarker, { until, now, clock, iconOnly: true }));
    expect(icon).toContain('title="Snoozed until tomorrow, 9:00 AM"');
    expect(icon).toContain('aria-hidden="true"');
  });
});

describe("the snooze choices", () => {
  const render = (extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(SnoozeChoices, {
    threadId: "t", name: "Weekly numbers", onDone: noop, now, clock, ...extra,
  }));

  it("offers the three presets with their times, and a picked time", () => {
    const markup = render();
    expect(markup).toContain('aria-label="Snooze Weekly numbers"');
    expect(markup).toContain('aria-label="Snooze for 1 hour, until 4:30 PM"');
    expect(markup).toContain('aria-label="Snooze for tomorrow morning, until Fri 9:00 AM"');
    expect(markup).toContain('aria-label="Snooze for next week, until Mon 9:00 AM"');
    expect(markup).toContain(">Pick a time<");
    expect(markup).not.toContain("Unsnooze");
  });

  it("shows when it wakes and offers Unsnooze when it is snoozed", () => {
    const markup = render({ until: Date.parse("2026-09-25T09:00:00-04:00") });
    expect(markup).toContain("Snoozed until tomorrow, 9:00 AM");
    expect(markup).toContain(">Unsnooze<");
  });

  it("offers to snooze until new activity, and says so once snoozed that way", () => {
    expect(render()).toContain('aria-label="Snooze until new activity, the next reply or message"');
    const markup = render({ until: now + 30 * 86_400_000, untilActivity: true });
    expect(markup).toContain("Snoozed until new activity");
    expect(markup).toContain(">Unsnooze<");
    const marker = renderToStaticMarkup(createElement(SnoozedMarker, { until: now + 60_000, now, clock, untilActivity: true, iconOnly: true }));
    expect(marker).toContain('title="Snoozed until new activity"');
  });

  it("explains, rather than offers, when something is waiting on the owner", () => {
    const markup = render({ blocked: true });
    expect(markup).toContain("This conversation is waiting on your answer. Answer it first, then snooze it.");
    expect(markup).not.toContain("Snooze for");
  });

  it("uses plain words and no em dashes", () => {
    for (const markup of [render(), render({ blocked: true }), render({ until: now + 60_000 }), render({ until: now + 60_000, untilActivity: true })]) expect(markup).not.toContain("—");
  });
});
