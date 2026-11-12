import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
/** Additive S0 contracts are frozen separately; no historical surface is silently replaced. */
export function s0ContractSnapshot(): Record<string, string> {
  return Object.fromEntries([
    "server/highlevel/recovery-contract.ts", "server/highlevel/operations/invocation-plans.ts",
    "server/highlevel/operations/invocation-plan-inventory.json", "server/highlevel/s0-owner-inventory.json",
    "server/highlevel/s0-ownership.json", "cloudflare/crm-broker/src/contracts.ts",
    "server/highlevel/s0-compatibility.json", "server/highlevel/s0-locale-inventory.json",
  ].map(path => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const file = "server/highlevel/frozen-s0-contract.json";
  const snapshot = JSON.stringify(s0ContractSnapshot(), null, 2) + "\n";
  if (process.argv.includes("--write")) writeFileSync(file, snapshot);
  else if (snapshot !== readFileSync(file, "utf8")) throw new Error("S0 contract changed: named amendment required");
}
