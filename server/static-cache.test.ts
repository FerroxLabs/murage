import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { staticCacheControl } from "./static-cache.ts";

describe("staticCacheControl", () => {
  it("lets the window keep content-hashed build files", () => {
    for (const p of ["/assets/index-D1FV2dyq.js", "/assets/index-C3MTRbjj.css", "/assets/zh-CrzEIC2Q.js", "/assets/yaml-Buea-lGh.js"])
      expect(staticCacheControl(p), p).toBe("public, max-age=31536000, immutable");
  });
  it("never caches the page or files that are not hashed", () => {
    for (const p of ["/", "/index.html", "/manifest.webmanifest", "/app-icon.svg", "/assets/readme.txt", "/assets/", "/assets/a/b-D1FV2dyq.js", "/mermaid-frame.html"])
      expect(staticCacheControl(p), p).toBeUndefined();
  });
  it("is applied by the static route in index.ts", () => {
    const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(index).toContain("staticCacheControl(safe)");
  });
});
