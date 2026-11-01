// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { imageCacheControl } from "./image-cache-control.ts";

describe("imageCacheControl", () => {
  it("a final image takes the caller's rule, else the desktop's year", () => {
    expect(imageCacheControl(true, undefined)).toBe("private, max-age=31536000, immutable");
    expect(imageCacheControl(true, "private, no-cache")).toBe("private, no-cache");
    expect(imageCacheControl(true, "private, max-age=0, stale-while-revalidate=2592000")).toBe("private, max-age=0, stale-while-revalidate=2592000");
    expect(imageCacheControl(true, "private, no-store")).toBe("private, no-store");
  });
  it("a stand-in original is never kept: no-store stays no-store, anything else checks again", () => {
    expect(imageCacheControl(false, undefined)).toBe("private, no-cache");
    expect(imageCacheControl(false, "private, max-age=0, stale-while-revalidate=2592000")).toBe("private, no-cache");
    expect(imageCacheControl(false, "private, max-age=31536000, immutable")).toBe("private, no-cache");
    expect(imageCacheControl(false, "private, no-store")).toBe("private, no-store");
    expect(imageCacheControl(false, "no-store")).toBe("private, no-store");
  });
});
