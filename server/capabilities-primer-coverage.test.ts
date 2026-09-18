/** The guard that keeps the primer honest as Murage grows.
 *
 * `INTEGRATION_FACTS` already fails to COMPILE when a key is added to
 * `SendTurnInput["integrations"]` and not to the table (`satisfies`). This test
 * fails the SUITE for the same mistake, because a contributor who adds an
 * integration and runs `vitest` without `tsc` would otherwise ship a bot that
 * is silently never told about the new capability — the exact failure the
 * composio prompt was written to end.
 *
 * It reads the contract's source rather than its types so it is a real second
 * check and not a restatement of the same compile step.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { INTEGRATION_FACTS, capabilitiesPrimer, type IntegrationFact, type IntegrationKey } from "./capabilities-primer.ts";

/** Top-level keys of the `integrations?: { … }` block in contracts.ts. */
function integrationKeysFromContract(): string[] {
  const source = readFileSync(fileURLToPath(new URL("./contracts.ts", import.meta.url)), "utf8");
  const start = source.indexOf("  integrations?: {");
  expect(start, "contracts.ts no longer declares `integrations?: {` — this guard needs updating").toBeGreaterThan(-1);
  let depth = 0;
  let index = source.indexOf("{", start);
  const body: string[] = [];
  for (; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
    // Only record property names declared at the block's own depth.
    if (depth === 1) body.push(character);
  }
  return [...body.join("").matchAll(/(?:^|\n)\s{4}([A-Za-z][A-Za-z0-9]*)\??\s*:/g)].map((match) => match[1]);
}

describe("integration coverage", () => {
  it("accounts for every integration the contract can mount", () => {
    const declared = integrationKeysFromContract();
    expect(declared.length).toBeGreaterThan(5);
    expect([...declared].sort()).toEqual(Object.keys(INTEGRATION_FACTS).sort());
  });

  it("gives every integration a present clause, so mounting it is never silent", () => {
    for (const [key, fact] of Object.entries(INTEGRATION_FACTS)) {
      expect(fact.present.trim(), `${key} has no "you can" clause`).not.toBe("");
    }
  });

  it("puts every present clause into the block when that integration mounts", () => {
    for (const key of Object.keys(INTEGRATION_FACTS) as IntegrationKey[]) {
      // peers: 1 — `peers: 0` selects the no-peer variant for any integration
      // that declares one, which is a different clause on purpose.
      const text = capabilitiesPrimer({
        engine: "Test", toolAccess: "direct", imageInput: "unknown",
        mounted: { [key]: true }, memory: "off", imageProvider: false,
        folder: "none", peers: 1, canAskOwner: true,
      });
      expect(text, `${key} mounted but never mentioned`).toContain(INTEGRATION_FACTS[key].present);
    }
  });

  it("puts the no-peer variant into the block instead, when one is declared", () => {
    // The variant exists so a block never claims a peer it then denies. If it
    // were declared and never reached, the contradiction would be back.
    for (const key of Object.keys(INTEGRATION_FACTS) as IntegrationKey[]) {
      // `satisfies` narrows each row to its own literal, so read the
      // declared shape rather than the union to see the optional field.
      const fact: IntegrationFact = INTEGRATION_FACTS[key];
      const variant = fact.presentWithoutPeers;
      if (variant === undefined) continue;
      const text = capabilitiesPrimer({
        engine: "Test", toolAccess: "direct", imageInput: "unknown",
        mounted: { [key]: true }, memory: "off", imageProvider: false,
        folder: "none", peers: 0, canAskOwner: true,
      });
      expect(text, `${key} declares a no-peer clause that is never used`).toContain(variant);
      expect(text, `${key} used both clauses`).not.toContain(INTEGRATION_FACTS[key].present);
    }
  });

  it("puts every absent clause into the block when that integration is missing", () => {
    const text = capabilitiesPrimer({
      engine: "Test", toolAccess: "none", imageInput: "unknown",
      mounted: {}, memory: "off", imageProvider: false, folder: "none", peers: 0, canAskOwner: true,
    });
    for (const [key, fact] of Object.entries(INTEGRATION_FACTS)) {
      if (!fact.absent) continue;
      expect(text, `${key} absent but never mentioned`).toContain(fact.absent);
    }
  });
});
