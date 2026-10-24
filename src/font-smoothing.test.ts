import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// 1.0.4 (186): body text uses the platform's own smoothing, not forced greyscale.
it("does not force greyscale font smoothing on the body", () => {
  const css = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");
  const body = /\nbody \{[\s\S]*?\n\}/.exec(css)?.[0] ?? "";
  expect(body).toContain("-webkit-font-smoothing: auto");
  expect(body).toContain("-moz-osx-font-smoothing: auto");
  expect(body).not.toContain("antialiased");
});
