import { beforeUsersCreateIntegration } from "./testing/userscreate-integration-amendment.ts";
import { beforeF7ReviewAmendment } from "./testing/f7-contract-amendment.ts";
import { expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
it("S0 compatibility inventory permits only the named F0 hash deltas and preserves all legacy signatures", () => {
  const compatibility = JSON.parse(readFileSync("server/highlevel/s0-compatibility.json", "utf8"));
  const snapshot = JSON.parse(readFileSync("server/highlevel/frozen-contract.json", "utf8"));
  const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
  const historical = beforeF7ReviewAmendment(beforeUsersCreateIntegration(snapshot));
  const signatures = Object.fromEntries(Object.entries(historical).filter(([, value]) => Array.isArray(value)));
  expect(hash(JSON.stringify(signatures))).toBe(compatibility.legacyPublicSignaturesSha256);
  const batch = compatibility.amendments.find((row: { seat: string }) => row.seat === "0b");
  expect(batch.legacyHashDeltas.map((row: { path: string }) => row.path)).toEqual([
    "server/highlevel/operations/manifest-data.json", "server/highlevel/operations/schemas/contacts.ts", "server/highlevel/operations/schemas/funnels.ts",
  ]);
  for (const row of batch.legacyHashDeltas) {
    if (row.path === "server/highlevel/operations/manifest-data.json") {
      // Exact union of S0 batch qualification and the previously reviewed family/users.create rows.
      expect(row.after).toBe("bb74cc7fb5eb843c10f7d6fd4c130c20e49b1b6c3cfa32393ad65364c3d02906");
      expect(snapshot[row.path]).toBe("95775c194ec397cd3e7259904c59939df18e92d4b164b5b8523c45cca7d364eb");
    } else expect(snapshot[row.path]).toBe(row.after);
  }
  for (const [file, digest] of Object.entries(compatibility.historicalAdditiveFreezeSha256)) {
    let bytes = readFileSync(file);
    if (file === "server/highlevel/frozen-f02-contract.json") {
      // Reviewed 33b5a61d2c adds only invoice _id aliases; the live F0.2 assertion separately pins that union.
      const historical = JSON.parse(bytes.toString());
      const policy = "server/highlevel/operations/returned-identity-policy.json";
      expect(historical[policy]).toBe("ff074f404e7a51c1ba05cf95cf5bfb60da5c49022915d102975acbfe513f2dfb");
      historical[policy] = "b165f1de1e3e847a7c3b10780180eea3d077612d259f576a6842743905efdec9";
      bytes = Buffer.from(JSON.stringify(historical, null, 2) + "\n");
    }
    expect(hash(bytes), file).toBe(digest);
  }
});
it("HL-PLAN-1 additive shared contracts match their separately reviewed freeze", async () => {
  const { s0ContractSnapshot } = await import("../../scripts/highlevel-s0-snapshot.ts");
  expect(s0ContractSnapshot()).toEqual(JSON.parse(readFileSync("server/highlevel/frozen-s0-contract.json", "utf8")));
});
it("T-F4 frozen.snapshotMatchesF0 compares signatures and schema data", async () => {
  expect(existsSync("server/highlevel/frozen-contract.json")).toBe(true);
  const { contractSnapshot } = await import("../../scripts/highlevel-f0-snapshot.ts");
  expect(contractSnapshot()).toEqual(JSON.parse(readFileSync("server/highlevel/frozen-contract.json", "utf8")));
});
it("T-F4 implementation bodies are editable but public signatures are frozen", async () => {
  expect(existsSync("scripts/highlevel-f0-snapshot.ts")).toBe(true);
  const { publicSignatures } = await import("../../scripts/highlevel-f0-snapshot.ts");
  const a = 'export class Example { run(x: string): boolean { return true; } }';
  expect(publicSignatures(a)).toEqual(publicSignatures(a.replace("return true", "throw new Error('C2')")));
  expect(publicSignatures(a)).not.toEqual(publicSignatures(a.replace("x: string", "x: number")));
});

it("T-F4 strip-only constructor desugaring preserves the frozen public surface", async () => {
  const { publicSignatures } = await import("../../scripts/highlevel-f0-snapshot.ts");
  const frozen = 'export class Example extends Error { constructor(readonly code: string) { super(code); } }';
  const executable = 'export class Example extends Error {\n/** @frozenParameterProperty */\nreadonly code: string; constructor(code: string) { super(code); this.code = code; } }';
  expect(publicSignatures(executable)).toEqual(publicSignatures(frozen));
  // Canonicalization must retain the original F0 spelling, not rewrite its baseline.
  expect(publicSignatures(executable)[0]).toContain("constructor(readonly code: string)");
  for (const changed of [
    executable.replace("readonly code", "code"),
    executable.replace("readonly code", "protected readonly code"),
    executable.replace("readonly code", "private readonly code"),
    executable.replace("readonly code: string", "readonly code: number"),
    executable.replace("readonly code: string", "readonly code?: string"),
    executable.replace("constructor(code: string)", "constructor(code: number)"),
    executable.replace("constructor(code: string)", "constructor(code?: string)"),
    executable.replace("constructor(code: string)", "constructor(code: string, extra: boolean)"),
    executable.replace("readonly code", "static readonly code"),
    executable.replace("readonly code", "readonly other"),
  ]) expect(publicSignatures(changed)).not.toEqual(publicSignatures(frozen));
});

it("T-F4 constructor normalization preserves explicitly frozen properties in other classes", async () => {
  const { publicSignatures } = await import("../../scripts/highlevel-f0-snapshot.ts");
  const source = 'export class PreparedUpload { readonly name: string; constructor(name: string) { this.name = name; } }';
  const signatures = publicSignatures(source, undefined, ["AnchoredReadRefused"]);
  expect(signatures[0]).toContain("readonly name: string;");
  expect(signatures[0]).toContain("constructor(name: string)");
  expect(publicSignatures(source.replace("readonly name: string", "readonly name: number"), undefined, ["AnchoredReadRefused"])).not.toEqual(signatures);
});
it("T-F4 portable readonly fields preserve the parameter-property API without hiding signature changes", async () => {
  const { publicSignatures } = await import("../../scripts/highlevel-f0-snapshot.ts");
  const shorthand = 'export class Refusal { constructor(readonly code: string) {} }';
  const portable = 'export class Refusal {\n/** @frozenParameterProperty */\nreadonly code: string; constructor(code: string) { this.code = code; } }';
  expect(publicSignatures(portable)).toEqual(publicSignatures(shorthand));
  for (const changed of [portable.replace('readonly code:', 'code:'), portable.replace('readonly code: string', 'readonly code: number'), portable.replace('constructor(code: string)', 'constructor(code: number)'), portable.replace('readonly code: string;', '')]) {
    expect(publicSignatures(changed)).not.toEqual(publicSignatures(shorthand));
  }
  expect(publicSignatures(portable.replace('/** @frozenParameterProperty */', ''))).not.toEqual(publicSignatures(shorthand));
});
