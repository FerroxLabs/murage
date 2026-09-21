// THE PAGE THE FIRST RUN SHOWS BEFORE IT ASKS FOR ANYTHING.
//
// Three properties matter and each is here for its own reason.
//
// It costs nothing to produce. That is the whole argument for showing a
// sample at all: there is no free starter allowance, so the thing that
// demonstrates the product before the ask has to be a page with no abuse
// surface. A render that quietly grew a model call or a font request would
// take that away without anybody noticing.
//
// It is honest. Empty sections are omitted, a quiet day is one line, and
// nothing invents urgency.
//
// It escapes. The real brief is assembled from other people's mail and
// calendar entries, and it is opened in a real browser.

import { describe, expect, it } from "vitest";

import { renderBriefHtml } from "./brief-html.ts";
import { BRIEF_SECTIONS, type BriefData, briefIsQuiet } from "./brief.ts";
import { SAMPLE_BRIEF_DATE, sampleBrief } from "./brief-sample.ts";

const empty = (over: Partial<BriefData> = {}): BriefData => ({
  ownerName: "Sean",
  dateLabel: "Tuesday",
  ...over,
});

describe("the brief as a page", () => {
  it("is a whole document that asks the network for nothing", () => {
    const html = renderBriefHtml(sampleBrief("Sean"));
    expect(html.startsWith("<!doctype html>")).toBe(true);

    // THE PROPERTY THE SAMPLE BRIEF RESTS ON. No stylesheet, no font, no
    // script, no image, no frame. It renders identically on a machine that
    // has connected nothing at all, and it cannot phone home from somebody's
    // browser.
    for (const outside of ["<script", "<link", "<img", "<iframe", "@import", "url(http", "https://", "http://"]) {
      expect.soft(html, `the brief reaches outside itself: ${outside}`).not.toContain(outside);
    }
  });

  it("puts their name on it", () => {
    expect(renderBriefHtml(sampleBrief("Sean"))).toContain("Good morning, Sean");
    // ...and stays a sentence rather than a gap when there is no name yet.
    const anonymous = renderBriefHtml(sampleBrief("   "));
    expect(anonymous).toContain("Good morning<");
    expect(anonymous).not.toContain("Good morning, <");
  });

  // Matched on the rendered heading markup, not on the words anywhere in the
  // document. A first version searched the whole string and found "Today" in
  // a CSS comment explaining the timeline, which made a correctly ordered
  // page look out of order. The heading is what is on screen; a comment is
  // not.
  const headingAt = (html: string, heading: string) => html.indexOf(`<span>${heading}</span>`);

  it("leads with the decision, because that is the only part that needs them", () => {
    const html = renderBriefHtml(sampleBrief("Sean"));
    const order = BRIEF_SECTIONS.map((section) => headingAt(html, section.heading));
    expect(order.every((at) => at > -1), "a section heading is missing from the sample").toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("carries a recommendation, not a menu", () => {
    // A list of options is a failure to do the job. Every decision in the
    // sample has to model the behaviour the real brief is meant to copy.
    for (const decision of sampleBrief("Sean").needsYou ?? []) {
      expect.soft(decision.recommend?.trim(), decision.title).toBeTruthy();
    }
  });

  it("omits a section it has nothing to put in", () => {
    const html = renderBriefHtml(empty({ today: [{ title: "One thing" }] }));
    expect(headingAt(html, "Today")).toBeGreaterThan(-1);
    for (const heading of ["Needs you", "Overnight", "Handled for you", "Worth knowing"]) {
      expect.soft(headingAt(html, heading), heading).toBe(-1);
    }
  });

  it("says one line on a quiet day rather than five empty headings", () => {
    const quiet = empty({ quiet: "Nothing needs you today. Your first thing is at eleven." });
    expect(briefIsQuiet(quiet)).toBe(true);
    const html = renderBriefHtml(quiet);
    expect(html).toContain("Nothing needs you today.");
    for (const section of BRIEF_SECTIONS) {
      expect.soft(headingAt(html, section.heading), section.heading).toBe(-1);
    }
  });

  it("has a sentence even when a quiet day forgot to bring one", () => {
    expect(renderBriefHtml(empty())).toContain("Nothing needs you");
  });

  it("escapes everything, because this is other people's text in a browser", () => {
    const nasty = empty({
      ownerName: '<script>alert(1)</script>',
      needsYou: [{
        title: '<img src=x onerror=alert(2)>',
        detail: 'She said "yes" & meant it',
        recommend: "<b>do it</b>",
        by: "<i>noon</i>",
      }],
      today: [{ when: "<u>9</u>", title: "</h1><script>x</script>", detail: "a & b" }],
    });
    const html = renderBriefHtml(nasty);

    // The property is that none of it is ever MARKUP. The words survive as
    // words, which is correct and is the point: a subject line that reads
    // `<img src=x onerror=...>` should be shown to the owner exactly as it
    // was sent to them. So the assertion is on the angle brackets, which are
    // what turn text into a tag, and not on the payload's own substrings.
    // `</h1>` is deliberately NOT in this list: the page has a real one of
    // its own. What proves the injected closer never landed is that the
    // escaped form of the whole payload is present, asserted below.
    for (const tag of ["<script", "<img", "<b>", "<i>", "<u>"]) {
      expect.soft(html, `unescaped ${tag} reached the page`).not.toContain(tag);
    }
    expect(html).toContain("&lt;/h1&gt;&lt;script&gt;x&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(2)&gt;");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;yes&quot;");
  });

  // The sample is an EXAMPLE and must never read as a forecast of their real
  // day. Dating it "today" would make it demonstrably wrong the moment they
  // opened it, because none of it is on their actual calendar.
  it("says plainly that the sample is an example", () => {
    expect(SAMPLE_BRIEF_DATE.toLowerCase()).toContain("example");
    expect(renderBriefHtml(sampleBrief("Sean"))).toContain("An example");
  });
});

// The brief is the Chief talking, so it is held to the Chief's rules. This is
// the same gate src/lib/first-run-copy.test.ts applies to the cards, for the
// same reason: a rule that lives only in a brief is a rule that comes back.
describe("the sample brief obeys the house rules", () => {
  const text: string[] = [];
  const data = sampleBrief("Sean");
  for (const section of BRIEF_SECTIONS) {
    for (const entry of (data[section.key] ?? []) as ReadonlyArray<Record<string, unknown>>) {
      for (const value of Object.values(entry)) if (typeof value === "string") text.push(value);
    }
  }
  text.push(SAMPLE_BRIEF_DATE);

  it("has copy to check at all", () => {
    expect(text.length).toBeGreaterThan(12);
  });

  it("never uses an em dash", () => {
    for (const line of text) expect.soft(line).not.toContain("—");
  });

  it("never mentions what anything costs", () => {
    for (const line of text) {
      expect.soft(line, line).not.toMatch(/\b(price|pricing|cost|costs|free|paid|pay|billing|budget|spend|cheap|dollar|\$)\b/i);
    }
  });

  // A deadline is a fact. Urgency is a feeling, and manufacturing it is what
  // spam does. The sample says "Answer by noon" and never "urgent".
  it("never manufactures urgency", () => {
    for (const line of text) {
      expect.soft(line, line).not.toMatch(/\b(urgent|urgently|asap|immediately|critical|action required)\b/i);
      expect.soft(line, line).not.toContain("!");
    }
  });

  // Nobody is being taught a lesson, and nobody is being flattered.
  it("never praises the owner or narrates its own cleverness", () => {
    for (const line of text) {
      expect.soft(line, line).not.toMatch(/\b(great|well done|excellent|congratulations on|proud|lesson|homework)\b/i);
    }
  });
});
