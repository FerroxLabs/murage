// Chat reading polish (1.0.16 lane u18-u19-u23-ui).
//
// Source contracts: the renderer suite runs in node with no DOM, so these pin
// the class and handler wiring each fix depends on.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");

describe("a long unbroken word in your own message", () => {
  // Upstream d903c42d2: a long URL with no break opportunity grew the w-fit
  // bubble past its cap. overflow-wrap:anywhere also lowers min-content width.
  it("wraps inside the bubble in a 1:1 chat", () => {
    expect(read("./ChatView.tsx")).toContain('"bg-bubble-user px-4 py-2.5 whitespace-pre-wrap [overflow-wrap:anywhere] text-ink"');
  });

  it("wraps inside the bubble in a room", () => {
    expect(read("./GroupView.tsx")).toContain('"whitespace-pre-wrap [overflow-wrap:anywhere] bg-bubble-user text-ink"');
  });
});

describe("Enter that picks an input-method candidate", () => {
  // Upstream 49db3dd1a: Japanese/Chinese/Korean typists press Enter to choose
  // a candidate. That Enter must not also save the form.
  it("does not save a new calendar event", () => {
    expect(read("./RoutineCalendarPage.tsx")).toContain('event.key === "Enter" && valid && !imeComposing({ isComposing: event.nativeEvent.isComposing, keyCode: event.keyCode })');
  });
});
