import { describe, expect, it } from "vitest";
import { fieldsChanged } from "./use-dirty-baseline";

const base = { name: "a", botIds: ["b1"], weekdays: [1, 2], timeoutMinutes: null, attachments: [] as unknown[], runOn: "ember" };

describe("fieldsChanged", () => {
  it("is clean before a baseline exists and when nothing changed", () => {
    expect(fieldsChanged(base, null)).toBe(false);
    expect(fieldsChanged({ ...base, botIds: ["b1"], weekdays: [1, 2] }, base)).toBe(false);
  });
  it("sees a change in any field, not only name and instructions", () => {
    for (const change of [{ name: "b" }, { botIds: ["b1", "b2"] }, { weekdays: [1] }, { timeoutMinutes: 30 }, { attachments: [{ id: "x" }] }, { runOn: "cloud" }]) {
      expect(fieldsChanged({ ...base, ...change }, base), JSON.stringify(change)).toBe(true);
    }
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
describe("the routine editors ask before a backdrop click closes unsaved edits", () => {
  const source = readFileSync(fileURLToPath(new URL("../components/RoutineCalendarPage.tsx", import.meta.url)), "utf8");
  it("routes the editor and quick composer backdrops through closeWithAsk", () => {
    expect(source).toContain("editorDirty.closeWithAsk(onClose)");
    expect(source).toContain("quickDirty.closeWithAsk(onClose)");
    expect(source).not.toContain("onMouseDown={() => setQuick(null)}");
  });
  it("watches every editor field", () => {
    const snap = /useDirtyBaseline\(\{\s*kind, name, description,([^}]*)\}\)/.exec(source)?.[1] ?? "";
    for (const field of ["date", "startTime", "durationMinutes", "timeoutMinutes", "recurrence", "weekdays", "intervalMinutes", "botIds", "routineTarget", "groupId", "runOn", "overlap", "permissionMode", "attachments"]) {
      expect(snap, field).toContain(field);
    }
  });
});
