import { beforeUsersCreateIntegration } from './testing/userscreate-integration-amendment.ts';
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { f02ContractSnapshot } from "../../scripts/highlevel-f02-snapshot.ts";
import { contractSnapshot } from "../../scripts/highlevel-f0-snapshot.ts";
import { beforeF7ReviewAmendment } from "./testing/f7-contract-amendment.ts";
function beforeS0Batch(snapshot: Record<string, unknown>): Record<string, unknown> {
  const compatibility = JSON.parse(readFileSync("server/highlevel/s0-compatibility.json", "utf8"));
  for (const schemaPath of ["server/highlevel/operations/schemas/contacts.ts", "server/highlevel/operations/schemas/funnels.ts"]) {
    const delta = compatibility.amendments.find((row: { seat: string }) => row.seat === "0b").legacyHashDeltas.find((row: { path: string }) => row.path === schemaPath);
    expect(snapshot[schemaPath]).toBe(delta.after);
    snapshot[schemaPath] = delta.before;
  }
  return snapshot;
}

it("F0.2 is additive: original F0.1 signatures/schema hashes survive the enumerated F7 review amendment", () => {
  const current = beforeUsersCreateIntegration(contractSnapshot());
  // HL-BATCH-1 / HL-F10-12:04 retain the historical digest, normalizing only explicitly reviewed schema changes.
  const compatibility = JSON.parse(readFileSync("server/highlevel/s0-compatibility.json", "utf8"));
  for (const schemaPath of ["server/highlevel/operations/schemas/contacts.ts", "server/highlevel/operations/schemas/funnels.ts"]) {
    const delta = compatibility.amendments.find((row: { seat: string }) => row.seat === "0b").legacyHashDeltas.find((row: { path: string }) => row.path === schemaPath);
    expect(current[schemaPath]).toBe(delta.after);
    current[schemaPath] = delta.before;
  }
  // MAIN F0.2.4 amends only manifest data; frozen-snapshot checks its current hash.
  current["server/highlevel/operations/manifest-data.json"] = "d1e06611dfc013a4e3340c148fa5a01b2e18a75281ffdfb289df30626102c45b";
  const snapshot = `${JSON.stringify(beforeF7ReviewAmendment(current), null, 2)}\n`;
  expect(createHash("sha256").update(snapshot).digest("hex")).toBe("115cd36252b5033ac548808db72693ed81f0c9800ec4442b64fae457d2be674c");
});
it("F0.2 is additive: F0.1 public signatures and approved schema hashes stay frozen", () => {
  const current = beforeS0Batch(beforeUsersCreateIntegration(contractSnapshot()));
  current["server/highlevel/operations/manifest-data.json"] = "d1e06611dfc013a4e3340c148fa5a01b2e18a75281ffdfb289df30626102c45b";
  // Approved F7 approval context and 9aaeaa1195 validation copy; no operation or schema removed.
  expect(createHash("sha256").update(JSON.stringify(current, null, 2) + "\n").digest("hex")).toBe("6e0245b824f969b12119072934929900fbf5d0ec1dc6c1d521831208a40ce46d");
});
it("F0.2 signatures and every op identity policy match the additive freeze", () => {
  expect(f02ContractSnapshot()).toEqual(JSON.parse(readFileSync("server/highlevel/frozen-f02-contract.json", "utf8")));
});
it("family adoption cannot introduce a binder-to-registry initialization cycle", () => {
  for (const file of ["returned-identities.ts", "approval-idempotency.ts", "binding-json.ts", "operations/returned-identity-schemas.ts"]) {
    expect(readFileSync(`server/highlevel/${file}`, "utf8")).not.toMatch(/import\s+(?!type\b)[^;]*from\s+["'][^"']*registry\.ts["']/u);
  }
});
it("F0.2.2 additions match their own freeze without changing F0.1 or F0.2", async () => {
  const { f022ContractSnapshot } = await import("../../scripts/highlevel-f022-snapshot.ts");
  expect(f022ContractSnapshot()).toEqual(JSON.parse(readFileSync("server/highlevel/frozen-f022-contract.json", "utf8")));
});
it("F0.2.3 live invocation boundary matches its additive freeze", async () => {
  const { f023ContractSnapshot } = await import("../../scripts/highlevel-f023-snapshot.ts");
  expect(f023ContractSnapshot()).toEqual(JSON.parse(readFileSync("server/highlevel/frozen-f023-contract.json", "utf8")));
});
it("F0.2.4 reconciliation lookup matches its additive freeze", async () => {
  const { f024ContractSnapshot } = await import("../../scripts/highlevel-f024-snapshot.ts");
  expect(f024ContractSnapshot()).toEqual(JSON.parse(readFileSync("server/highlevel/frozen-f024-contract.json", "utf8")));
});


it("F0.2 also preserves the reviewed pre-public-fixture pin after F7 normalization", () => {
  const current = beforeS0Batch(beforeUsersCreateIntegration(contractSnapshot()));
  current["server/highlevel/operations/manifest-data.json"] = "d1e06611dfc013a4e3340c148fa5a01b2e18a75281ffdfb289df30626102c45b";
  const snapshot = beforeF7ReviewAmendment(current, { beforePublicFixtureAmendments: true });
  expect(createHash("sha256").update(JSON.stringify(snapshot, null, 2) + "\n").digest("hex"))
    .toBe("4582ddd67d7e3274e6fe595540a0e12ce386b9adb6a1a5b4e264f847bc3aa63d");
});
