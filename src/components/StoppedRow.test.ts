// A stop that caught a desktop action mid-flight: the person is told, in the
// conversation itself, that the action may have finished anyway. The line is
// not a tool run, so it must not disappear with Settings → Tool calls off —
// which is where the plain "Stopped by you" chip goes.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StoppedMidActionRow } from "./StoppedRow";
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
