import { describe, expect, it } from "vitest";
import { appendNativeEvent, shortcutLabel } from "./skill-recorder";

const event = (patch: Partial<NativeSkillRecordingEvent>): NativeSkillRecordingEvent => ({
  type: "key", atMs: 100, app: "Notes", windowTitle: "Ideas", ...patch,
});

describe("skill recording events", () => {
  it("never retains ordinary typed characters and coalesces a typing burst", () => {
    const first = appendNativeEvent([], event({ keycode: 0 }));
    const second = appendNativeEvent(first.events, event({ atMs: 400, keycode: 11 }));
    expect(second.events).toEqual([expect.objectContaining({ type: "typing", keyCount: 2 })]);
    expect(JSON.stringify(second.events)).not.toContain("A");
  });

  it("keeps modified keys as readable shortcuts", () => {
    const native = event({ keycode: 35, meta: true, shift: true });
    expect(shortcutLabel(native)).toBe("⇧⌘P");
    expect(appendNativeEvent([], native).events[0]).toMatchObject({ type: "shortcut", shortcut: "⇧⌘P" });
  });

  it("coalesces repeated scrolling in the same window", () => {
    const first = appendNativeEvent([], event({ type: "scroll", deltaY: -2 }));
    const second = appendNativeEvent(first.events, event({ type: "scroll", atMs: 600, deltaY: -7 }));
    expect(second.events).toHaveLength(1);
  });
});

