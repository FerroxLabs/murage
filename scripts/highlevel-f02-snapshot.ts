import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { publicSignatures } from "./highlevel-f0-snapshot.ts";
export function f02ContractSnapshot(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const path of ["server/highlevel/binding-json.ts", "server/highlevel/returned-identities.ts", "server/highlevel/operations/returned-identity-schemas.ts", "server/highlevel/approval-idempotency.ts"]) out[path] = publicSignatures(readFileSync(path, "utf8"));
  out["server/highlevel/operations/returned-identity-policy.json"] = createHash("sha256").update(readFileSync("server/highlevel/operations/returned-identity-policy.json")).digest("hex");
  return out;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const snapshot = `${JSON.stringify(f02ContractSnapshot(), null, 2)}\n`;
  const file = "server/highlevel/frozen-f02-contract.json";
  if (process.argv.includes("--write")) writeFileSync(file, snapshot);
  else if (snapshot !== readFileSync(file, "utf8")) throw new Error("F0.2 additive contract changed");
}
