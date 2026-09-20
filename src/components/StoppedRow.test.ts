// A stop that caught a desktop action mid-flight: the person is told, in the
// conversation itself, that the action may have finished anyway. The line is
// not a tool run, so it must not disappear with Settings → Tool calls off —
// which is where the plain "Stopped by you" chip goes.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StoppedByYouRow, StoppedMidActionRow } from "./StoppedRow";
import { isStoppedMidDesktopAction, STOPPED_MID_DESKTOP_ACTION } from "../../shared/host-stop";
import { TURN_STOPPED_DESKTOP_ACTION_NOTE, TURN_STOPPED_NOTE } from "../../server/turn-outcome";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");

describe("stopped while an action was running on the screen", () => {
  it("is one plain sentence that says to check the screen", () => {
    expect(TURN_STOPPED_DESKTOP_ACTION_NOTE).toBe(STOPPED_MID_DESKTOP_ACTION);
    const markup = renderToStaticMarkup(createElement(StoppedMidActionRow));
    expect(markup).toContain('role="status"');
    expect(markup).toContain("Stopped while an action was running on your screen — it may have finished anyway. Check the screen before retrying.");
    expect(markup).not.toContain("break-all");
    expect(isStoppedMidDesktopAction(STOPPED_MID_DESKTOP_ACTION)).toBe(true);
    expect(isStoppedMidDesktopAction(TURN_STOPPED_NOTE)).toBe(false);
  });

  it.each([
    ["ChatView", read("./ChatView.tsx"), 'case "activity"', "<ActivityChip"],
    ["GroupView", read("./GroupView.tsx"), 'm.kind === "activity" && m.tool', "<RoomToolChip"],
  ])("%s shows it whether or not Tool calls is on", (_name, source, branch, toolChip) => {
    const activity = source.indexOf(branch);
    const chip = source.indexOf(toolChip, activity);
    const routed = source.indexOf("isStoppedMidDesktopAction(", activity);
    expect(activity).toBeGreaterThan(-1);
    // routed to its own row inside the activity branch, before the tool chip
    // that Settings -> Tool calls hides
    expect(routed, "the note is not routed to its own row").toBeGreaterThan(activity);
    expect(routed).toBeLessThan(chip);
    const row = source.indexOf("<StoppedMidActionRow", routed);
    expect(row).toBeGreaterThan(routed);
    expect(row).toBeLessThan(chip);
  });
});

// The person's own Stop. It was an ordinary activity chip, so with
// Settings → Tool calls off — the default — a stopped turn left the
// transcript ending on the person's own bubble with nothing after it.
// "Stopped by you" showed only in the sidebar's thread preview.
describe("stopped by you", () => {
  it("is a plain status row, not a tool chip", () => {
    const markup = renderToStaticMarkup(createElement(StoppedByYouRow));
    expect(markup).toContain('role="status"');
    expect(markup).toContain(TURN_STOPPED_NOTE);
  });

  it.each([
    ["ChatView", read("./ChatView.tsx"), 'case "activity"', "<ActivityChip"],
    ["GroupView", read("./GroupView.tsx"), 'm.kind === "activity" && m.tool', "<RoomToolChip"],
  ])("%s shows it whether or not Tool calls is on", (_name, source, branch, toolChip) => {
    const activity = source.indexOf(branch);
    const chip = source.indexOf(toolChip, activity);
    expect(activity).toBeGreaterThan(-1);
    expect(chip).toBeGreaterThan(activity);
    // the note is recognised from the server's own constant, never a copy of
    // the words, and is routed before the chip Settings → Tool calls hides
    expect(source).toContain('TURN_STOPPED_NOTE');
    const routed = source.indexOf("TURN_STOPPED_NOTE", activity);
    expect(routed, "the stop is not routed to its own row").toBeGreaterThan(activity);
    expect(routed).toBeLessThan(chip);
    const row = source.indexOf("<StoppedByYouRow", routed);
    expect(row).toBeGreaterThan(routed);
    expect(row).toBeLessThan(chip);
  });
});
