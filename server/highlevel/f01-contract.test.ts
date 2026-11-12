import { beforeUsersCreateIntegration } from './testing/userscreate-integration-amendment.ts';
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";
import { contractSnapshot, publicSignatures } from "../../scripts/highlevel-f0-snapshot.ts";

import { beforeF7ReviewAmendment } from "./testing/f7-contract-amendment.ts";

const path = "server/highlevel/operations/registry.ts";
const source = readFileSync(path, "utf8");
const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
function hooks(owner: string, name: string) {
  const declaration = file.statements.find((s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === owner)!;
  return declaration.members.filter((m): m is ts.MethodSignature => ts.isMethodSignature(m) && m.name.getText(file) === name);
}

for (const [owner, name] of [["SpecBase", "project"], ["MutationSpec", "recordId"]]) {
  it(`F0.1 ${owner}.${name} retains deprecated F0 call and adds required request context`, () => {
    const methods = hooks(owner, name);
    expect(methods).toHaveLength(2);
    const old = methods.find(m => m.parameters.length === 1)!;
    const bound = methods.find(m => m.parameters.length === 2)!;
    expect(ts.getJSDocDeprecatedTag(old)).toBeDefined();
    expect(ts.getJSDocDeprecatedTag(bound)).toBeUndefined();
    expect(bound.parameters[1].name.getText(file)).toBe("frozen");
    expect(bound.parameters[1].type?.getText(file)).toBe("FrozenRequest");
    expect(bound.parameters[1].questionToken).toBeUndefined();
    expect(Boolean(bound.questionToken)).toBe(name === "recordId");
  });
}

function snapshotBeforeF01Overloads() {
  const additions = [...hooks("SpecBase", "project"), ...hooks("MutationSpec", "recordId")]
    .filter(m => m.parameters.length === 2).sort((a, b) => b.pos - a.pos);
  let original = source;
  for (const method of additions) original = original.slice(0, method.pos) + original.slice(method.end);
  const snapshot = contractSnapshot();
  snapshot[path] = publicSignatures(original);
  // HL-BATCH-1 / HL-F10-12:04: normalize ONLY the two reviewed schema hashes after checking their exact new values.
  const compatibility = JSON.parse(readFileSync("server/highlevel/s0-compatibility.json", "utf8"));
  for (const schemaPath of ["server/highlevel/operations/schemas/contacts.ts", "server/highlevel/operations/schemas/funnels.ts"]) {
    const delta = compatibility.amendments.find((row: { seat: string }) => row.seat === "0b").legacyHashDeltas.find((row: { path: string }) => row.path === schemaPath);
    expect(snapshot[schemaPath]).toBe(delta.after);
    snapshot[schemaPath] = delta.before;
  }
  // MAIN F0.2.4 amends only manifest data; frozen-snapshot checks its current hash.
  snapshot["server/highlevel/operations/manifest-data.json"] = "d1e06611dfc013a4e3340c148fa5a01b2e18a75281ffdfb289df30626102c45b";
  // Approved amendments: F7 approval context (wave 5) and validation copy 9aaeaa1195 (reds-main).
  return beforeUsersCreateIntegration(snapshot);
}

it("F0.1 adds only the two overloads; every F0 signature/schema hash survives the MAIN F0.2.4 manifest amendment", () => {
  const snapshot = snapshotBeforeF01Overloads();
  const digest = createHash("sha256").update(JSON.stringify(snapshot, null, 2) + "\n").digest("hex");
  expect(digest).toBe("7129446b6d8e68f5b1f47cbf7ba9d9ce71ed71dad619a8af84c6591fc7081f74");
});

it("F0.1 adds only the two overloads; every F0 signature/schema hash survives the enumerated F0.2.4 and F7 review amendments", () => {
  const snapshot = snapshotBeforeF01Overloads();
  const digest = createHash("sha256").update(JSON.stringify(beforeF7ReviewAmendment(snapshot), null, 2) + "\n").digest("hex");
  expect(digest).toBe("d5a50b9748f38856b9524e0bba18be3819598544f1c8efee1c8ce7cbdc668141");
});


it("F0.1 also preserves the reviewed pre-public-fixture pin after F7 normalization", () => {
  const snapshot = beforeF7ReviewAmendment(snapshotBeforeF01Overloads(), { beforePublicFixtureAmendments: true });
  expect(createHash("sha256").update(JSON.stringify(snapshot, null, 2) + "\n").digest("hex"))
    .toBe("d52393f6f8eaae89ec619f2bfd6234e0fb8ec1bd360d29ff4511c5ae888caecc");
});
