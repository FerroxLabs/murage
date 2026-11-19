// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
it("inventories the new ACP conversation errors and every routine release-note addition", () => {
  const inventory = new URL("../docs/verification/op-routines-english.md", import.meta.url);
  expect(existsSync(inventory), "release copy needs a checked-in English inventory").toBe(true);
  const text = readFileSync(inventory, "utf8"), rows = text.split("## Production string inventory")[1] ?? "";
  const core = readFileSync(new URL("./drivers/acp/core.ts", import.meta.url), "utf8");
  for (const message of [
    "Hermes permission could not be bound to the approved action; Murage rejected it.",
    "Hermes bot turns require the default approval mode. The prompt was not sent.",
    "The saved approval differs from the engine request. Murage rejected it.",
  ]) { expect(core).toContain(message); expect(rows, "every new conversation error needs a surface entry").toContain(message); }
  for (const line of readFileSync(new URL("../release-notes/1.0.19.md", import.meta.url), "utf8").split("\n").slice(1).filter(Boolean)) expect(text).toContain(line);
});
