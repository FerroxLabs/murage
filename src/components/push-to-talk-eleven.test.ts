// SPDX-License-Identifier: AGPL-3.0-or-later
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
const context = vi.hoisted(() => ({ route: "elevenlabs" as string | null }));
vi.mock("@/state/store", () => ({ useStoreIfAny: () => ({ state: { config: { tts: { routes: { transcribe: context.route } } } } }) }));
import { PushToTalk } from "./PushToTalk";
import { voiceFailure } from "@/lib/tts";
import { setLocale } from "@/lib/i18n";
import { loadLocalePack } from "@/locales";
const render = (nativeDictation = false) => renderToStaticMarkup(createElement(PushToTalk, { facts: { nativeDictation, fluxConfigured: false, secure: true, canRecord: true }, onTranscript: () => {} }));
it("an own ElevenLabs transcription route enables the microphone without Flux", () => {
  context.route = "elevenlabs";
  expect(render()).toContain("Hold to talk");
  expect(render()).not.toContain("Add a Flux key");
});
it("keeps native dictation first and the existing missing-key instruction", () => {
  context.route = "elevenlabs"; expect(render(true)).toBe("");
  context.route = null; expect(render()).toContain("Add a Flux key");
});
it.each(["en", "de", "es", "fr", "hi", "ja", "pt-br", "zh"])("shows the speech-language refusal in %s", async code => {
  try {
    await setLocale(code);
    const translated = (await loadLocalePack(code))["tts.unsupportedLanguage"];
    expect(translated).toBeTruthy(); expect(voiceFailure(400, "unsupported language")).toBe(translated);
  } finally { await setLocale("en"); }
});
