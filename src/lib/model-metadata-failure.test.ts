// Its own file on purpose: vitest gives each test file a fresh module
// instance, and this one deliberately poisons the index. Run beside the others
// it would make every later lookup return null.
import { describe, expect, it } from "vitest";

import { loadModelMetadata, lookupModelMetadata, modelMetadataLoads } from "./model-metadata.ts";
import { PRICE_UNKNOWN, isPriceUnknown, modelPriceLabel, pickerModels } from "./provider-model-picker.ts";

describe("when the snapshot cannot be parsed at all", () => {
  it("memoizes the failure as empty, retries nothing, and every row reads as unknown", () => {
    expect(modelMetadataLoads()).toBe(0);

    // The data is a compiled-in string, so this cannot realistically happen;
    // the decision is what the code does IF it ever does. Chosen: memoize an
    // empty catalog. Leaving it unmemoized would repeat the parse on every
    // picker open forever, and rethrowing would take the picker down with it.
    loadModelMetadata(() => {
      throw new SyntaxError("Unexpected token } in JSON at position 42");
    });
    expect(modelMetadataLoads()).toBe(1);

    // Degrades to the honest state, not a broken or empty row: the row still
    // renders, still has its label, and says it does not know the price.
    const [row] = pickerModels(
      {
        instanceId: "claudeAgent",
        driverKind: "claudeAgent",
        displayName: "Claude",
        snapshot: { state: "available", authenticated: true },
        models: { default: "claude-opus-5", options: [{ id: "claude-opus-5", label: "Claude Opus 5" }] },
      },
      [],
    );
    expect(row!.label).toBe("Claude Opus 5");
    expect(row!.pricing).toBeUndefined();
    expect(modelPriceLabel(row!)).toBe(PRICE_UNKNOWN);
    expect(isPriceUnknown(row!)).toBe(true);

    // Reopening the picker any number of times does no further work.
    for (let open = 0; open < 100; open += 1) expect(lookupModelMetadata("claude-opus-5", "anthropic")).toBeNull();
    expect(modelMetadataLoads()).toBe(1);
  });
});
