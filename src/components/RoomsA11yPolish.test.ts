// Sidebar, rooms and accessibility polish (1.0.16 lane u18-u19-u23-ui).
// Source contracts: the renderer suite runs in node with no DOM.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");

describe("a room with Tool calls off (upstream 62f1c0264)", () => {
  it("hides a failed step like a 1:1 chat, and still shows a failed turn", () => {
    const room = read("./GroupView.tsx");
    expect(room).not.toContain('m.tool.ok === false || m.tool.name.startsWith("error:") || showToolCalls');
    // U4 S3 also shows a step that carries a done-when line
    expect(room).toContain(') : m.tool.name.startsWith("error:") || showToolCalls || hasDoneWhenLine(m.tool.doneWhen) ? (');
  });
});

describe("dropdown options on the dark skin (upstream e2dde06a6)", () => {
  it("follow the skin instead of the platform's white list", () => {
    const css = read("../styles.css").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toMatch(/\}\s*select\s*\{\s*color-scheme:\s*var\(--code-color-scheme\);\s*\}/);
    expect(css).toMatch(/select option,\s*select optgroup\s*\{\s*background-color:\s*var\(--color-raised\);\s*color:\s*var\(--color-ink\);\s*\}/);
  });
});

describe("fields a screen reader can name (upstream fde016edc)", () => {
  it("labels the command palette search", () => {
    expect(read("./CommandPalette.tsx")).toContain('aria-label={t("palette.searchLabel")}');
  });
  it("labels the calendar editors' title and instructions or description fields", () => {
    const calendar = read("./RoutineCalendarPage.tsx");
    expect(calendar.match(/aria-label=\{t\("routines\.editor\.titleLabel"\)\}/g)).toHaveLength(2);
    expect(calendar).toContain('rows={5} aria-label={t(kind === "call" ? "routines.editor.descriptionLabel" : "routines.editor.instructionsLabel")}');
    expect(calendar).toContain('rows={3} aria-label={t(kind === "routine" ? "routines.editor.instructionsLabel" : "routines.editor.descriptionLabel")}');
  });
});
