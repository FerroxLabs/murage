// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Settings v10 B7: a routine on the bot page is drawn with its own switch in its true state, so a Fix that lands here
// (restored routine, Off) shows the switch Off and in view. The destination carries the routine id for the Fix-link lint.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/state/store", async (orig) => ({ ...(await orig<typeof import("@/state/store")>()), api: async () => ({}) }));

import { BotRoutineRow, routineToggleRequest } from "./BotRoutineRow";

const routine = (enabled: boolean) => ({ id: "morning", name: "Morning inbox sort", botId: "dax", enabled }) as never;

describe("bot page routine row (B7)", () => {
  it("a routine that is off is drawn with its switch off, named, and addressable by routine id", () => {
    const html = renderToStaticMarkup(createElement(BotRoutineRow, { routine: routine(false) }));
    expect(html).toContain('data-routine-id="morning"');
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain("Morning inbox sort");
  });
  it("a routine that is on is drawn with its switch on", () => {
    expect(renderToStaticMarkup(createElement(BotRoutineRow, { routine: routine(true) }))).toContain('aria-checked="true"');
  });
  it("the switch sends the opposite of what is drawn", () => {
    expect(routineToggleRequest(routine(false))).toEqual({ path: "/api/routines/morning", body: { enabled: true } });
    expect(routineToggleRequest(routine(true))).toEqual({ path: "/api/routines/morning", body: { enabled: false } });
  });
});
