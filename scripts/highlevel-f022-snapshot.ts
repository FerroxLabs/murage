import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { publicSignatures } from "./highlevel-f0-snapshot.ts";
export function f022ContractSnapshot(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const path of ["server/highlevel/rpc-approval-replay.ts", "server/highlevel/returned-confirmation.ts", "server/highlevel/operations/returned-confirmation-schemas.ts"]) out[path] = publicSignatures(readFileSync(path, "utf8"));
  return out;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const snapshot = `${JSON.stringify(f022ContractSnapshot(), null, 2)}\n`;
  const file = "server/highlevel/frozen-f022-contract.json";
  if (process.argv.includes("--write")) writeFileSync(file, snapshot);
  else if (snapshot !== readFileSync(file, "utf8")) throw new Error("F0.2.2 additive contract changed");
}
