// The avatar panel's four states, rendered.
//
// TEST RIG: this file runs in vitest's node environment, and importing the
// card reaches @/state/store, so `window` has to exist before the module graph
// is walked. Same shape as the other component suites here.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

globalThis.window ??= { location: { href: "http://localhost/" } } as unknown as Window & typeof globalThis;

import { AVATAR_COPY, avatarGeneratorPlan, type AvatarGeneratorFacts } from "@/lib/avatar-generation";
import { AvatarGenerateSection, type AvatarGenerateSectionProps } from "./BotProfileAvatarCard";

const facts = (over: Partial<AvatarGeneratorFacts> = {}): AvatarGeneratorFacts => ({
  flux: false,
  openAiImageKey: false,
  lastAttemptFailed: false,
  ...over,
});

const render = (over: Partial<AvatarGenerateSectionProps> = {}) =>
  renderToStaticMarkup(
    createElement(AvatarGenerateSection, {
      plan: avatarGeneratorPlan(facts()),
      direction: "",
      onDirection: vi.fn(),
      directionPlaceholder: "Optional direction",
      generating: false,
      uploading: false,
      onGenerate: vi.fn(),
      imageKey: "",
      onImageKey: vi.fn(),
      savingKey: false,
      onSaveKey: vi.fn(),
      onOpenSettings: vi.fn(),
      ...over,
    }),
  );

describe("the avatar panel with a Flux key", () => {
  const html = () => render({ plan: avatarGeneratorPlan(facts({ flux: true, openAiImageKey: true })) });

  it("says Flux is doing it, and offers no OpenAI key to paste", () => {
    expect(html()).toContain(AVATAR_COPY.fluxHeading);
    expect(html()).toContain("Generate avatar");
    expect(html()).not.toContain(AVATAR_COPY.keyDrawerLabel);
    expect(html()).not.toContain('type="password"');
  });

  it("offers the key again once an attempt has failed", () => {
    const failed = render({ plan: avatarGeneratorPlan(facts({ flux: true, lastAttemptFailed: true })) });
    expect(failed).toContain(AVATAR_COPY.keyDrawerLabel);
    expect(failed).toContain('type="password"');
  });
});

describe("the avatar panel without a Flux key", () => {
  it("keeps the OpenAI path working for someone already using it", () => {
    const html = render({ plan: avatarGeneratorPlan(facts({ openAiImageKey: true })) });
    expect(html).toContain(AVATAR_COPY.openAiHeading);
    expect(html).toContain("Generate avatar");
    expect(html).toContain(AVATAR_COPY.keyDrawerLabel);
  });

  it("points at Settings for the easier path, without blocking the panel", () => {
    const html = render({ plan: avatarGeneratorPlan(facts({ openAiImageKey: true })) });
    expect(html).toContain(AVATAR_COPY.fluxHint);
    expect(html).toContain(AVATAR_COPY.fluxHintAction);
    // An offer, not a gate: the generate control is still right there.
    expect(html).toContain("Generate avatar");
  });

  it("asks for a key when there is nothing at all, and still offers Flux", () => {
    const html = render({ plan: avatarGeneratorPlan(facts()) });
    expect(html).toContain("Paste OpenAI image API key");
    expect(html).toContain(AVATAR_COPY.fluxHintAction);
    expect(html).not.toContain("Generate avatar");
  });
});

describe("the panel never renders a secret", () => {
  it("holds no saved key: the only value in the markup is what was just typed", () => {
    // FluxKeyCard's precedent is about what the RENDERER IS GIVEN. GET
    // /api/config answers `imageGen: { configured }` and never the key, so a
    // configured panel with an empty box has no key material in it anywhere.
    const configured = render({ plan: avatarGeneratorPlan(facts({ openAiImageKey: true })) });
    expect(configured).toContain(AVATAR_COPY.keyDrawerLabel);
    expect(configured).not.toMatch(/value="[^"]/);
    // And the box it would be typed into is masked and off autocomplete.
    expect(configured).toContain('type="password"');
    // react-dom/server keeps the camelCase spelling; match either.
    expect(configured).toMatch(/autocomplete="off"/i);
  });

  it("POSITIVE control: the rig would notice key material in the markup", () => {
    // A controlled input DOES serialise what the person is currently typing.
    // That is the field they are typing in, not a stored secret, but it proves
    // the assertion above is reading real markup rather than an empty string.
    const typed = render({
      plan: avatarGeneratorPlan(facts({ openAiImageKey: true })),
      imageKey: "sk-typed-just-now",
    });
    expect(typed).toContain("sk-typed-just-now");
    expect(() => expect(typed).not.toMatch(/value="[^"]/)).toThrow();
  });
});
