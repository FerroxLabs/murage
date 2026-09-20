// Appearance is folded away.
//
// It used to OPEN the Overview: shape, expression, colour and body before
// "What is this bot for?" and before the role. A bot's looks are the one
// thing on that screen a person can already see.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const settings = readFileSync(fileURLToPath(new URL("./SettingsPanel.tsx", import.meta.url)), "utf8");
const appearance = (() => {
  const start = settings.indexOf("<details");
  expect(start, "the Appearance disclosure is missing").toBeGreaterThan(-1);
  const end = settings.indexOf("</details>", start);
  expect(end, "the Appearance disclosure is not closed").toBeGreaterThan(start);
  return settings.slice(start, end + "</details>".length);
})();

describe("bot Appearance default", () => {
  it("starts folded, in both legacy settings and the sectioned Overview", () => {
    expect(appearance).not.toContain(" open=");
    expect(settings).toContain('<SettingsSection id="overview" active={section}>');
  });

  it("is folded UNDER the purpose, which is what the panel opens on", () => {
    const overview = settings.indexOf('<SettingsSection id="overview" active={section}>');
    expect(settings.indexOf("<BotSetupAction", overview)).toBeGreaterThan(overview);
    expect(settings.indexOf("<BotSetupAction", overview)).toBeLessThan(settings.indexOf("<details", overview));
  });

  it("keeps the native disclosure control and avatar editor collapsible", () => {
    expect(appearance).toContain("<summary className=");
    expect(appearance).not.toMatch(/<(?:details|summary)\b[^>]*\bon(?:Toggle|Click)=/);
    expect(appearance).toContain("<BotProfileAvatarCard");
  });
});
