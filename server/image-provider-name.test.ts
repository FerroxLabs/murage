// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
// The line under a generated image, and the result the bot reads, name the
// provider the way Settings does ("Flux Router"), never its internal id
// ("flux"). Display only: the stored metadata keeps the id.
import { describe, expect, it } from "vitest";
import { IMAGE_PROVIDER_NAMES, imageProviderName, imageResultSummary, type GeneratedImageMetadata, type ImageProvider } from "./image-generation.ts";
import { imageTranscriptText } from "./image-operations.ts";

const metadata = (provider: ImageProvider) => ({ provider, model: "gpt-image-2", count: 1, delivered: [] }) as unknown as GeneratedImageMetadata;
const NAMES: Record<ImageProvider, string> = { flux: "Flux Router", openai: "OpenAI", openrouter: "OpenRouter", xai: "xAI", google: "Google" };

describe("the provider's name in image lines", () => {
  it.each(Object.entries(NAMES) as Array<[ImageProvider, string]>)("%s reads as %s", (provider, name) => {
    expect(imageProviderName(provider)).toBe(name);
    const item = metadata(provider);
    expect(imageTranscriptText(item)).toBe(`Image created with gpt-image-2 through ${name}.`);
    expect(imageResultSummary(item)).toContain(`with gpt-image-2 through ${name}.`);
    // Display only: what is stored is still the id.
    expect(item.provider).toBe(provider);
  });
  it("knows every provider, and a name is never anything a person typed", () => {
    expect(Object.keys(IMAGE_PROVIDER_NAMES).sort()).toEqual(Object.keys(NAMES).sort());
    expect(Object.isFrozen(IMAGE_PROVIDER_NAMES)).toBe(true);
    // An id this build does not know is shown as it is rather than dropped.
    expect(imageProviderName("someday" as ImageProvider)).toBe("someday");
  });
});
