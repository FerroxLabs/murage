import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const settings = readFileSync(fileURLToPath(new URL("./SettingsPanel.tsx", import.meta.url)), "utf8");
const appearance = (() => {
  const start = settings.indexOf('<details open=');
  expect(start, "the Appearance disclosure is missing").toBeGreaterThan(-1);
  const end = settings.indexOf("</details>", start);
  expect(end, "the Appearance disclosure is not closed").toBeGreaterThan(start);
  return settings.slice(start, end + "</details>".length);
})();

describe("bot Appearance default", () => {
  it("opens in both legacy settings and the sectioned Overview", () => {
    expect(appearance).toContain('open={section === undefined || section === "overview" ? true : undefined}');
    expect(settings).toContain('<SettingsSection id="overview" active={section}>');
  });

  it("keeps the native disclosure control and avatar editor collapsible", () => {
    expect(appearance).toContain("<summary className=");
    expect(appearance).not.toMatch(/<(?:details|summary)\b[^>]*\bon(?:Toggle|Click)=/);
    expect(appearance).toContain("<BotProfileAvatarCard");
  });
});
