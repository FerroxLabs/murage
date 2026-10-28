// The door's CSP refuses eval, and Zod 4's JIT probe tries it once per load.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { globalConfig } from "zod/v4/core";

it("turns Zod's JIT (and its eval probe) off before anything else loads", async () => {
  await import("./zod-config");
  expect(globalConfig.jitless).toBe(true);
  const main = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
  // Only the dependency-free randomUUID polyfill (it builds no schema) may come first.
  const firstImport = main.split("\n").find((line) => line.startsWith("import ") && line !== 'import "./lib/random-uuid-polyfill";');
  expect(firstImport).toBe('import "./lib/zod-config";');
});
