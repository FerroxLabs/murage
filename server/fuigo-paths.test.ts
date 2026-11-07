import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { bootDataRoots } from "./data-roots.ts";
import { managedFuigoReceipt } from "./fuigo-native-update.ts";

it("S5 site 8 rebases the rollback CLI atomically and refuses unmatched previous paths without rewriting", async () => {
  mkdirSync(DATA_DIR, { recursive: true });
  const old = join(DATA_DIR, "old-root");
  writeFileSync(join(DATA_DIR, ".murage-root.json"), JSON.stringify({ schema: 1, root: old, previous: [] }));
  bootDataRoots();
  const root = join(DATA_DIR, "managed-engines");
  const cli = join(root, "fuigo", "fuigo", "1.0.9-abc", "fuigo");
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(cli, "fixture");
  const file = join(dirname(cli), "manifest.json");
  const receipt = { schema: 1, instanceId: "fuigo", version: "1.0.9", binarySha256: "a".repeat(64), proof: { version: "1.0.9", protocolVersion: 1, loadSession: true, sessionCreated: true }, previousManagedCli: join(old, "managed-engines", "fuigo", "fuigo", "1.0.9-def", "fuigo") };
  writeFileSync(file, JSON.stringify(receipt));
  const expected = join(root, "fuigo", "fuigo", "1.0.9-def", "fuigo");
  expect((await managedFuigoReceipt(root, "fuigo", cli))?.previousManagedCli).toBe(expected);
  expect(JSON.parse(readFileSync(file, "utf8")).previousManagedCli).toBe(expected);
  receipt.previousManagedCli = join(old, "elsewhere", "fuigo");
  const bytes = JSON.stringify(receipt);
  writeFileSync(file, bytes);
  expect((await managedFuigoReceipt(root, "fuigo", cli))?.previousManagedCli).toBeUndefined();
  expect(readFileSync(file, "utf8")).toBe(bytes);
});
