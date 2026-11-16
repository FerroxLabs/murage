// Owner: sc-safety (mechanical continuity); independent reviewers own fixture approvals.
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { removeTempDirSync } from "./cleanup.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });
const source = `import { expect, it, beforeEach, describe } from "vitest";
let output = [];
beforeEach(() => { output = []; });
function fixture() { return { output: [] }; }
it("case A", () => {
  const f = fixture();
  for (const revoked of [false, true]) { void revoked; }
  expect(f.output).toEqual([]);
});
it("case B", () => { expect(output).toEqual([]); });
`;
const seamHash = (text: string) => createHash("sha256").update(text).digest("hex");
const baseBody = "{ return { output: [] }; }";
const changedBody = "{ const clock = 1; void clock; return { output: [] }; }";
const seam = { file: "server/internal-response-fence.test.ts", function: "fixture", baselineSha256: seamHash(baseBody) };
const approval = { file: seam.file, function: seam.function, before: seamHash(baseBody), after: seamHash(changedBody), reviewer: "review-seat", cases: ["case A"], productPath: "server/product.ts" };
const relevant = { case: "case A", matches: 1, beforeHash: "a".repeat(64), afterHash: "b".repeat(64), control: "PASS", result: "ASSERTION_RED", productFile: "server/product.ts", relevance: "The affected fixture input reaches this product declaration in case A", reviewer: "review-seat" };
function check(after: string, options: { seams?: object[]; hunks?: object[]; mutants?: object[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "assertion-continuity-")); roots.push(root);
  const file = "server/internal-response-fence.test.ts";
  const baseline: Record<string, string> = { [file]: source,
    "server/drivers/codex-warm.test.ts": 'it("a prewarm whose close is unconfirmed stays owned in the stuck registry", () => {});' };
  for (const name of ["server/memory/learning-send-boundary.test.ts", "server/nl-win-1018.test.ts", "server/ledger-refusal-server.test.ts", "server/drivers/acp/r2-hermes.test.ts"]) baseline[name] = "";
  for (const [name, text] of Object.entries(baseline)) { mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), name === file ? after : text); }
  mkdirSync(join(root, "server/testing"), { recursive: true });
  writeFileSync(join(root, "server/testing/seams.json"), JSON.stringify({ seams: options.seams ?? [] }));
  const modern = resolve("scripts/verification/sc-safety/assertion-continuity.mjs");
  const script = existsSync(modern) ? modern : resolve("docs/verification/sc-safety-r4/assertion-preservation.mjs");
  const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8", env: {
    ...process.env, SC_PRESERVATION_BASE64: deflateSync(JSON.stringify(baseline)).toString("base64"),
    SC_CONTINUITY_REVIEW: JSON.stringify(options),
  }, timeout: 20_000 });
  expect(result.error).toBeUndefined();
  expect(result.stdout.trim(), "the checker must always produce a structured report").not.toBe("");
  return { status: result.status, report: JSON.parse(result.stdout) };
}
it("CHK control retains all file content and assertions", () => { expect(check(source).status).toBe(0); });
it("CHK-1 rejects an early return", () => { expect(check(source.replace("  expect(f.output)", "  return;\n  expect(f.output)")).status).not.toBe(0); });
it("CHK-2 rejects an uncalled assertion closure", () => { expect(check(source.replace("  expect(f.output).toEqual([]);", "  const never = () => { expect(f.output).toEqual([]); };")).status).not.toBe(0); });
it("CHK-3 rejects a rebound assertion actual", () => { expect(check(source.replace("const f = fixture()", "const f = { output: [] }")).status).not.toBe(0); });
it("CHK-4 rejects moving assertions between test IDs", () => { expect(check(source.replace("  expect(f.output).toEqual([]);", "").replace("expect(output).toEqual([]);", "expect(output).toEqual([]); expect(f.output).toEqual([]);")).status).not.toBe(0); });
it("CHK-5 rejects a reduced matrix", () => { expect(check(source.replace("[false, true]", "[false]")).status).not.toBe(0); });
it("CHK-6 rejects skip and retry wrappers", () => {
  expect(check(source.replace('it("case A"', 'it.skip("case A"')).status).not.toBe(0);
  expect(check(source.replace('it("case A"', 'it("case A", { retry: 3 }')).status).not.toBe(0);
});
it("CHK-7 rejects assertions inside proposed fixture seams", () => {
  expect(check(source.replace("return { output: [] };", "expect(true).toBe(true); return { output: [] };"), { seams: [seam] }).status).not.toBe(0);
});
it("CHK-8 rejects unreviewed seam changes", () => { expect(check(source.replace("output: []", "output: [1]"), { seams: [seam] }).status).not.toBe(0); });
it("CHK-9 rejects changed fixture cases without relevant activated mutants", () => { expect(check(source.replace(baseBody, changedBody), { seams: [seam], hunks: [approval] }).status).not.toBe(0); });
it("CHK-HIGH rejects changed assertion imports and surrounding hooks", () => {
  expect(check(source.replace('import { expect,', 'import { fakeExpect as expect,')).status).not.toBe(0);
  expect(check(source.replace("output = [];", "output = []; return; it.skip = it;" )).status).not.toBe(0);
});

it("CHK positive seam requires exact independent review and relevant activated mutation", () => {
  const after = source.replace(baseBody, changedBody);
  expect(check(after, { seams: [seam], hunks: [approval], mutants: [relevant] }).status).toBe(0);
  expect(check(after, { seams: [seam], hunks: [approval], mutants: [{ ...relevant, productFile: "server/unrelated.ts" }] }).status).not.toBe(0);
  expect(check(after, { seams: [{ ...seam, baselineSha256: "wrong" }], hunks: [approval], mutants: [relevant] }).status).not.toBe(0);
});
it("CHK new exclusive registrations cannot disable existing cases", () => {
  expect(check(source + '\nit.only("added", () => {});').status).not.toBe(0);
});

it("CHK nested additive suites preserve the existing registration context", () => {
  expect(check(source + '\ndescribe("added", () => { it("nested", () => { expect(true).toBe(true); }); });\n').status).toBe(0);
});

it("CHK new registrations cannot execute inside an existing case", () => {
  const changed=source.replace("  const f = fixture();", '  it("nested", () => {});\n  const f = fixture();');
  expect(check(changed).status).not.toBe(0);
});
it("CHK cast budget cannot be bypassed by fixture approval", () => {
  const body="{ const opaque = undefined "+["as","unknown","as"].join(" ")+" number; void opaque; return { output: [] }; }";
  const after=source.replace(baseBody,body);
  expect(check(after,{seams:[seam],hunks:[{...approval,after:seamHash(body)}],mutants:[relevant]}).status).not.toBe(0);
});
