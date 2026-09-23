// Product copy never uses an em dash. The Goal button's hover text did
// ("Finish together — the team keeps working ..."), and hover text is copy
// like any other.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const source = readFileSync(new URL("./Composer.tsx", import.meta.url), "utf8");

it("keeps em dashes out of the composer's hover text, labels and placeholders", () => {
  const attributes = [...source.matchAll(/\b(?:title|aria-label|placeholder)="([^"]*)"/g)].map((match) => match[1]);
  expect(attributes).toContain("Finish together");
  expect(attributes.filter((text) => text.includes("—"))).toEqual([]);
});
