// Its own file on purpose: the first assertion here observes the state BEFORE
// anything has touched the snapshot, and vitest gives each test file a fresh
// module instance. Sharing a file with any other lookup would make that
// assertion depend on test ordering, which is how a laziness test quietly
// stops testing laziness.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { lookupModelMetadata, modelMetadataLoads, modelMetadataUpdatedAt } from "./model-metadata.ts";
import { priceBandNote } from "./provider-model-picker.ts";

describe("the snapshot is parsed once per session, on first use", () => {
  it("is not parsed by importing the module", () => {
    // The whole point of the `?raw` import: module evaluation costs a string
    // literal, not a 7,842-entry object graph, so every app launch that never
    // opens the model picker pays nothing.
    expect(modelMetadataLoads()).toBe(0);
  });

  it("is parsed exactly once, however many lookups happen", async () => {
    // The getter is synchronous, so there is no in-flight window and no
    // genuine race to test: a second caller can only arrive after the memo is
    // assigned. That is strictly stronger than a shared promise, which does
    // have a window between its check and its assignment. These callers are
    // interleaved anyway, because "many callers, one parse" is the property
    // that was asked for and it costs nothing to pin.
    const concurrent = await Promise.all(
      Array.from({ length: 24 }, () => Promise.resolve().then(() => lookupModelMetadata("claude-opus-5", "anthropic"))),
    );
    expect(modelMetadataLoads()).toBe(1);
    expect(concurrent.every((match) => match?.metadata.outputPerMillion === 25)).toBe(true);

    // …and then five hundred more, standing in for reopening the picker.
    for (let open = 0; open < 500; open += 1) {
      expect(lookupModelMetadata("claude-sonnet-5", "anthropic")).not.toBeNull();
      expect(lookupModelMetadata("nothing-sells-this")).toBeNull();
    }
    expect(modelMetadataLoads()).toBe(1);
  });

  it("serves every caller the same objects, not a fresh copy each time", () => {
    const first = lookupModelMetadata("claude-opus-5", "anthropic");
    const second = lookupModelMetadata("claude-opus-5", "anthropic");
    expect(first!.metadata).toBe(second!.metadata);
    expect(modelMetadataLoads()).toBe(1);
  });

  it("does not reparse for the dated note either", () => {
    expect(priceBandNote()).toBe("Bands are approximate, from published rates, September 2026");
    // The date the snapshot itself records, read from disk rather than through
    // the module under test so this read cannot count as a parse. It used to be
    // the literal "2026-09-18", which made every `pnpm models:build` refresh
    // fail a test whose point is laziness, not the calendar.
    const fetchedAt = (JSON.parse(readFileSync(new URL("../data/model-metadata.json", import.meta.url), "utf8")) as { source: { fetchedAt: string } }).source.fetchedAt;
    expect(new Date(modelMetadataUpdatedAt()).toISOString().slice(0, 10)).toBe(fetchedAt);
    expect(modelMetadataLoads()).toBe(1);
  });
});
