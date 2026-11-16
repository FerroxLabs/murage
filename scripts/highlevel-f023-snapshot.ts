import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { publicSignatures } from "./highlevel-f0-snapshot.ts";

export function f023ContractSnapshot(): Record<string, unknown> {
  const path = "server/highlevel/approval-invocations.ts";
  return { [path]: publicSignatures(readFileSync(path, "utf8")) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const snapshot = `${JSON.stringify(f023ContractSnapshot(), null, 2)}\n`;
  const file = "server/highlevel/frozen-f023-contract.json";
  if (process.argv.includes("--write")) writeFileSync(file, snapshot);
  else if (snapshot !== readFileSync(file, "utf8")) throw new Error("F0.2.3 additive contract changed");
}
