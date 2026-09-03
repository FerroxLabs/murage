// Which provider the avatar panel says it is about to use, and what it shows.
import { describe, expect, it } from "vitest";

import {
  AVATAR_COPY,
  avatarGeneratorPlan,
  providerFor,
  type AvatarGeneratorFacts,
} from "./avatar-generation";

const facts = (over: Partial<AvatarGeneratorFacts> = {}): AvatarGeneratorFacts => ({
  flux: false,
  openAiImageKey: false,
  lastAttemptFailed: false,
  ...over,
});

describe("who is going to draw it", () => {
  it("uses Flux when there is a Flux key, whatever else is saved", () => {
    // This is the SERVER's order (resolveAvatarImageRoutes, avatar-image.ts).
    // If these two ever disagree the panel names one provider and another one
    // sends the bill, which is the whole failure this module exists to prevent.
    expect(providerFor(facts({ flux: true }))).toBe("flux");
    expect(providerFor(facts({ flux: true, openAiImageKey: true }))).toBe("flux");
  });

  it("uses the OpenAI image key when that is the only key", () => {
    expect(providerFor(facts({ openAiImageKey: true }))).toBe("openai");
  });

  it("has nobody to draw it with no key at all", () => {
    expect(providerFor(facts())).toBe("none");
  });

  it("does not name a provider before config has answered", () => {
    // `null` is "GET /api/config has not come back", not "no key". Reading it
    // as no-key makes a Flux machine flash the OpenAI heading every launch.
    expect(providerFor(facts({ flux: null, openAiImageKey: null }))).toBe("none");
    expect(avatarGeneratorPlan(facts({ flux: null, openAiImageKey: null })).fluxHint).toBe(null);
  });
});

describe("what the panel shows", () => {
  it("names Flux, and drops the OpenAI key drawer, when Flux is doing the work", () => {
    const plan = avatarGeneratorPlan(facts({ flux: true, openAiImageKey: true }));
    expect(plan.heading).toContain("Flux");
    expect(plan.body).toContain("Flux Router");
    expect(plan.canGenerate).toBe(true);
    // Not needed, so not shown: the key it would replace is not the one paying.
    expect(plan.showKeyDrawer).toBe(false);
    expect(plan.showKeyField).toBe(false);
    // Nothing to offer: they already have the key the hint would point at.
    expect(plan.fluxHint).toBe(null);
  });

  it("brings the OpenAI key drawer back the moment a Flux attempt fails", () => {
    // Flux answers 402 for an account that is not paid and cleared, and this
    // panel is the ONLY place in the app an OpenAI image key can be entered.
    // Without this the person is told to pay or give up.
    const plan = avatarGeneratorPlan(facts({ flux: true, lastAttemptFailed: true }));
    expect(plan.showKeyDrawer).toBe(true);
    expect(plan.provider).toBe("flux");
  });

  it("keeps the working OpenAI path AND offers Flux as the easier one", () => {
    const plan = avatarGeneratorPlan(facts({ openAiImageKey: true }));
    expect(plan.provider).toBe("openai");
    expect(plan.canGenerate).toBe(true);
    expect(plan.showKeyDrawer).toBe(true);
    expect(plan.heading).toContain("OpenAI");
    // The offer, not a replacement: nothing here removes the path they use.
    expect(plan.fluxHint).toBe(AVATAR_COPY.fluxHint);
  });

  it("asks for a key, and offers Flux, when nothing can draw yet", () => {
    const plan = avatarGeneratorPlan(facts());
    expect(plan.canGenerate).toBe(false);
    expect(plan.showKeyField).toBe(true);
    expect(plan.showKeyDrawer).toBe(false);
    expect(plan.fluxHint).toBe(AVATAR_COPY.fluxHint);
  });

  it("never shows the first-run key field and the replace drawer at once", () => {
    // Two password inputs for the same credential, one of them hidden in a
    // details element, is the shape of a panel that grew a state by accident.
    for (const flux of [true, false, null] as const) {
      for (const openAiImageKey of [true, false, null] as const) {
        for (const lastAttemptFailed of [true, false]) {
          const plan = avatarGeneratorPlan({ flux, openAiImageKey, lastAttemptFailed });
          expect(plan.showKeyField && plan.showKeyDrawer).toBe(false);
          // And a panel that cannot generate never shows a generate control.
          expect(plan.canGenerate).toBe(plan.provider !== "none");
        }
      }
    }
  });
});

describe("copy rules", () => {
  it("uses no em dashes anywhere a person can read", () => {
    for (const [name, line] of Object.entries(AVATAR_COPY)) {
      expect(`${name}: ${line}`).not.toContain("—");
    }
    // POSITIVE control: prove the assertion can fail rather than passing
    // because the matcher never sees the character.
    expect(() => expect("a — dash").not.toContain("—")).toThrow();
  });

  it("says what the person gets, and names the thing that does it", () => {
    expect(AVATAR_COPY.fluxHeading).toMatch(/Flux/);
    expect(AVATAR_COPY.openAiHeading).toMatch(/OpenAI/);
    const all = Object.values(AVATAR_COPY).join(" ").toLowerCase();
    expect(all).not.toMatch(/configure your|enter your api key/);
  });

  it("stays short enough to be a panel rather than documentation", () => {
    for (const [name, line] of Object.entries(AVATAR_COPY)) {
      expect(`${name} is ${line.length} chars`).toBe(`${name} is ${Math.min(line.length, 160)} chars`);
    }
  });
});
