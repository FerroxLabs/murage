// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// BUNDLE-HEADROOM-1018: the bundled models.dev snapshot is its own chunk, so
// it is no longer part of the first paint. Its own file on purpose: these
// tests observe the module BEFORE the chunk has arrived, and vitest gives each
// test file a fresh module instance.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PickerPriceNote, PickerRowMeta, pickerRowTitle } from "../components/ModelPickerDialog";
import { lookupModelMetadata, modelMetadataLoads, modelMetadataReady, preloadModelMetadata, subscribeModelMetadata } from "./model-metadata.ts";
import { PRICE_UNKNOWN, isPricePending, pickerModels, type PickerEngine } from "./provider-model-picker.ts";

const claude: PickerEngine = {
  instanceId: "claudeAgent",
  driverKind: "claudeAgent",
  displayName: "Claude",
  snapshot: { state: "available", authenticated: true },
  models: { default: "claude-opus-5", options: [{ id: "claude-opus-5", label: "Claude Opus 5" }, { id: "flux-fast", label: "Flux Fast" }] },
};
const rowMeta = (row: ReturnType<typeof pickerModels>[number]) => renderToStaticMarkup(createElement(PickerRowMeta, { row }));
// Subscribed before anything can start the fetch (the first lookup below does).
let heard = 0;
const stop = subscribeModelMetadata(() => { heard += 1; });

describe("the price snapshot arrives after the first paint", () => {
  it("a failed chunk load leaves the rows pending and lets the next call try again", async () => {
    // Runs first: nothing has asked for the chunk yet, so the seam is the one used.
    await expect(preloadModelMetadata(() => Promise.reject(new Error("Failed to fetch dynamically imported module")))).resolves.toBeUndefined();
    expect(modelMetadataReady()).toBe(false);
    expect(modelMetadataLoads()).toBe(0);
  });

  it("before it arrives, a row's band is pending, never 'Price unavailable', and nothing is memoized", () => {
    expect(modelMetadataReady()).toBe(false);
    const [opus, flux] = pickerModels(claude, []);
    expect(opus!.label).toBe("Claude Opus 5");
    expect(opus!.pricing).toBeUndefined();
    expect(isPricePending(opus!)).toBe(true);
    expect(pickerRowTitle(opus!)).toBe("");
    const markup = rowMeta(opus!);
    expect(markup).toContain("data-price-pending");
    expect(markup).not.toContain(PRICE_UNKNOWN);
    // a Flux band is Murage's own and needs no snapshot
    expect(isPricePending(flux!)).toBe(false);
    expect(rowMeta(flux!)).toContain("$");
    // the dated note waits rather than showing undated
    expect(renderToStaticMarkup(createElement(PickerPriceNote, { shown: true }))).toBe("");
    expect(lookupModelMetadata("claude-opus-5", "anthropic")).toBeNull();
    expect(modelMetadataLoads()).toBe(0);
  });

  it("when it arrives, listeners hear once and the same row reads its band", async () => {
    await preloadModelMetadata();
    await preloadModelMetadata();
    stop();
    expect(heard).toBe(1);
    expect(modelMetadataReady()).toBe(true);
    const [opus] = pickerModels(claude, []);
    expect(opus!.pricing?.outputPerMillion).toBe(25);
    expect(isPricePending(opus!)).toBe(false);
    expect(rowMeta(opus!)).not.toContain("data-price-pending");
    expect(pickerRowTitle(opus!)).toContain("Output $25/M");
    expect(renderToStaticMarkup(createElement(PickerPriceNote, { shown: true }))).toContain("Bands are approximate");
    expect(modelMetadataLoads()).toBe(1);
  });
});
