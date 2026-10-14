import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettingsSection } from "./SettingsPanel";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
const marker = (text: string) => createElement("p", null, text);

describe("bot settings tabs mount lazily", () => {
  it("renders only the shown tab's contents", () => {
    const html = renderToStaticMarkup(createElement("div", null,
      createElement(SettingsSection, { id: "overview", active: "overview" }, marker("OVERVIEW-BODY")),
      createElement(SettingsSection, { id: "memory", active: "overview" }, marker("MEMORY-BODY")),
      createElement(SettingsSection, { id: "access", active: "overview" }, marker("ACCESS-BODY"))));
    expect(html).toContain("OVERVIEW-BODY");
    expect(html).not.toContain("MEMORY-BODY");
    expect(html).not.toContain("ACCESS-BODY");
    // the hidden tabs keep their section element, so Playwright selectors and the nav stay valid
    expect(html).toContain('data-settings-section="memory"');
  });
  it("a deep link opens straight onto its tab, mounted", () => {
    const html = renderToStaticMarkup(createElement(SettingsSection, { id: "skills", active: "skills" }, marker("SKILLS-BODY")));
    expect(html).toContain("SKILLS-BODY");
  });
  it("renders everything when no tab is selected (the standalone panel)", () => {
    const html = renderToStaticMarkup(createElement(SettingsSection, { id: "voice" }, marker("VOICE-BODY")));
    expect(html).toContain("VOICE-BODY");
  });
  it("the dialog still routes intents into the section prop that mounts the tab", () => {
    const dialog = read("./BotSettingsDialog.tsx");
    expect(dialog).toContain("setSection(state.botSettingsIntent.section)");
    expect(dialog).toContain("section={section}");
    expect(read("./BotSkillsPanel.tsx")).toContain("useState(Boolean(state.botSettingsIntent?.addSkill))");
  });
});
