// polish-1021 (d1): Settings told people to "use /learn" or have a bot "run /create-verification-skill". Those are
// commands, not words a person acts on. The skill recorder card and its off line say the same thing in plain words,
// in every language.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const LANGS = ["en", "de", "es", "fr", "hi", "ja", "pt-br", "zh"];
const KEYS = ["settings.workspaceFeature.recorder.note", "settings.stub.letsBots.skillRecorder"];
const pack = (code: string) => JSON.parse(readFileSync(new URL(`./${code}.json`, import.meta.url), "utf8")) as Record<string, string>;

it("the skill recorder copy names no slash command in any language", () => {
  for (const code of LANGS) for (const key of KEYS) {
    const value = pack(code)[key];
    expect(value, `${code}:${key}`).toBeTruthy();
    expect(value, `${code}:${key}`).not.toMatch(/\/(?:learn|create-verification-skill)\b/);
  }
});

it("the Teach a skill page source names no slash command", () => {
  for (const file of ["../components/SkillRecorderPage.tsx", "../components/SettingsModal.tsx"]) {
    expect(readFileSync(new URL(file, import.meta.url), "utf8"), file).not.toMatch(/["'`>][^"'`<]*\/(?:learn|create-verification-skill)\b/);
  }
});
