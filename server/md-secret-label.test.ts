// REDACT-MD-SINKS (designs/REDACT-MD-SINKS-1104.md §5): extent A on machine
// sinks. Every row fails on the base (int/1015 b47ece583) on an assertion,
// except the guard rows 22 and 24, which pass on both. f(f(x)) = f(x) on every
// row. The stream rows (14-18) live in drivers/native-md-stream.test.ts and the
// electron rows (12, 13, 19 electron) in electron/diagnostics.test.mjs.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as redact from "./redact.ts";
import { createLabelStream, maskSecretLabelsToEnd, scanLabelDelta } from "../shared/md-secret-label.mjs";

const R = redact as unknown as Record<string, ((input: unknown) => unknown) | undefined>;
// On the base these do not exist: the log writers ran redactSecretsInText and
// the native log ran redactSecrets. The fallback IS the base's machine sink, so
// a base run fails on the assertions below, not on an import.
const sink = (text: string): string => (R.redactSecretsForSink ?? redact.redactSecretsInText)(text) as string;
const sinkWalk = (input: unknown): unknown => (R.redactSecretsForSinkWalk ?? redact.redactSecrets)(input);
const MARKER_AT_END = /«redacted \d{1,9} chars»$/;

/** Masked to the end: ends in one marker, no secret piece survives, idempotent. */
function expectMasked(input: string, secrets: readonly string[]) {
  const out = sink(input);
  for (const secret of secrets) expect(out, `${JSON.stringify(input)} leaked ${secret}`).not.toContain(secret);
  expect(out, JSON.stringify(input)).toMatch(MARKER_AT_END);
  expect(sink(out)).toBe(out);
}

const ROWS: readonly [number, string, readonly string[]][] = [
  [1, "**password**: correct(horse)9", ["horse", "correct"]],
  [1, "**token**: data[abcdefghijklmnop]", ["abcdefghijklmnop", "data["]],
  [2, "**password**: abcd«TAILSECRET9", ["TAILSECRET9", "abcd"]],
  [2, "**password**: «redacted TAILSECRET9»", ["TAILSECRET9"]],
  [2, "**password**: «redacted 7 chars»TAILSECRET9", ["TAILSECRET9"]],
  [2, '**token**: "x «redacted 20 chars» TAIL9xyz"', ["TAIL9xyz"]],
  [3, `**password**: "${"a".repeat(1100)} TAILSECRET9\n\nnext ok`, ["TAILSECRET9", "next ok", "aaaa"]],
  [4, "**token**:\n**password**: hunter2", ["hunter2"]],
  [4, "**token**:**password**: hunter2", ["hunter2"]],
  [4, "**token**: **password**: hunter2", ["hunter2"]],
  [5, "**token: s3cret.**", ["s3cret"]],
  [5, "**password: abcd1234!TAILSECRET.**", ["TAILSECRET", "abcd1234"]],
  [6, "**password**:`alpha123 TAILSECRET9`", ["TAILSECRET9", "alpha123"]],
  [6, "**password**: ``abcd1234`TAILSECRET9``", ["TAILSECRET9", "abcd1234"]],
  [6, "**password**: ``abcd1234`TAILSECRET9", ["TAILSECRET9", "abcd1234"]],
  [7, '**password**: "alpha123\\" TAILSECRET9"', ["TAILSECRET9", "alpha123"]],
  [7, '**password**: "alpha\\"\nTAILSECRET9"', ["TAILSECRET9", "alpha"]],
  [8, '**password**: "alpha1234\nTAILSECRET9"', ["TAILSECRET9", "alpha1234"]],
  [8, '**password**: "alpha1234\n\nTAILSECRET9"', ["TAILSECRET9", "alpha1234"]],
  [8, "**password**:\n\nhunter2", ["hunter2"]],
  [8, "**password**:\n- hunter2", ["hunter2"]],
  [8, "**password**:\n> hunter2", ["hunter2"]],
  [8, "**password**:\nNote: hunter2", ["hunter2", "Note"]],
  [8, "**token**:\n**password**:\nhunter2", ["hunter2"]],
  [8, `**password**:${"\n".repeat(9)}hunter2`, ["hunter2"]],
  [9, "**password**: x1y2z3\nBearer: abcdefghijklmnop\n- Hint: hunter2secret", ["x1y2z3", "abcdefghijklmnop", "hunter2secret", "Hint"]],
  [10, "the token: note **password**: hunter2secret", ["hunter2secret"]],
  [10, "token: prose; **password**: hunter2", ["hunter2"]],
  [10, "**The password: correct horse**", ["correct", "horse"]],
  [10, "**OpenAI API key: hunter2**", ["hunter2"]],
  [10, "+ password: correct horse", ["correct", "horse"]],
  [20, "**password**:\nx9y8z7w6", ["x9y8z7w6"]],
  [20, "**password**:\r\nx9y8z7w6", ["x9y8z7w6"]],
  [20, "****password****: x9y8z7w6", ["x9y8z7w6"]],
  [20, "~~**password**~~: x9y8z7w6", ["x9y8z7w6"]],
  [20, "MURAGE_MODEL_PROVIDER_COMMIT_TOKEN: **x9y8z7w6**", ["x9y8z7w6"]],
  [20, "*Password*: leave blank", ["leave blank"]],
  [20, "`token`: string", ["string"]],
  [20, "_token=4096", ["4096"]],
];

describe("REDACT-MD-SINKS extent A on the server sink", () => {
  it.each(ROWS)("row %i masks after a wrapped label: %j", (_row, input, secrets) => expectMasked(input, secrets));

  it("row 21 writes the exact mask over the whole rest", () => {
    expect(sink("**password**: hunter2")).toBe("**password**: «redacted 8 chars»");
    expect(sink("**password**: hunter2\nmore\n")).toBe("**password**: «redacted 14 chars»");
    for (const input of ["**password**: hunter2", "**password**: hunter2\nmore\n"]) expect(sink(sink(input))).toBe(sink(input));
  });

  it.each([
    "the token: leave this prose alone",
    "const token = await getToken();",
    "use a **strong password** here",
    "the `password` field",
    "my_token: x",
  ])("row 22 (guard) keeps %j unchanged on the server sink", (input) => {
    expect(sink(input)).toBe(input);
    expect(sink(sink(input))).toBe(input);
  });

  it("row 23 masks every string leaf in the sink walk: nested, env-array override, depth fallback", () => {
    const leaf = "**password**: x1y2z3\nBearer: abcdefghijklmnop\n- Hint: hunter2secret";
    let deep: unknown = { note: leaf };
    for (let i = 0; i < 15; i++) deep = { next: deep };
    const input = { a: { b: { c: [leaf] } }, env: [{ name: "PLAIN_NOTE", value: leaf, extra: leaf }], deep };
    const once = JSON.stringify(sinkWalk(input));
    for (const secret of ["x1y2z3", "abcdefghijklmnop", "hunter2secret"]) expect(once).not.toContain(secret);
    expect(JSON.stringify(sinkWalk(sinkWalk(input)))).toBe(once);
  });
});

// Row 24 (guard): the user-visible rule is byte-for-byte the base's. The
// fixture is the base output of this corpus, written once from b47ece583 with
// RDS_WRITE_BASE=1 on the build host; head and base must both reproduce it.
const CORPUS = [
  ...ROWS.map(([, input]) => input),
  "the token: leave this prose alone", "const token = await getToken();", "use a **strong password** here",
  "the `password` field", "my_token: x", "password=hunter2000", "Authorization: Bearer abcdefghijklmnop",
  "XAI_API_KEY: «redacted 12 chars»TAILSECRET9", "api_key: sk-proj-abcdefghijklmnopqrstuv", "**password**: hunter2\nmore\n",
];
const FIXTURE = join(import.meta.dirname, "testing", "md-secret-label-user-text.base.json");

describe("REDACT-MD-SINKS user-visible text", () => {
  it("row 24 (guard) redactSecretsInText equals the base output byte for byte", () => {
    const now = CORPUS.map((input) => redact.redactSecretsInText(input));
    if (process.env.RDS_WRITE_BASE === "1") writeFileSync(FIXTURE, JSON.stringify(now, null, 1) + "\n");
    expect(existsSync(FIXTURE)).toBe(true);
    expect(now).toEqual(JSON.parse(readFileSync(FIXTURE, "utf8")));
  });
});

// Row 19, server side: the sink is linear. A quadratic path is caught at 16 KiB
// before the large sizes run, so a slow base fails on the assertion, not a hang.
describe("REDACT-MD-SINKS clock (row 19, server sink)", () => {
  const time = (text: string) => { const t = performance.now(); sink(text); return performance.now() - t; };
  const build = (unit: string, bytes: number, tail = "") => unit.repeat(Math.ceil(bytes / unit.length)) + tail;
  it.each([
    ["**password**: alpha1234 "], ["**token**:\n"], ["token:"], ["«"], ["a_"], ["`"],
  ])("unit %j stays linear at 64 and 256 KiB", (unit) => {
    const tail = unit === "token:" ? "(" : "";
    expect(time(build(unit, 16 * 1024, tail))).toBeLessThan(100);
    const best = (bytes: number) => { const text = build(unit, bytes, tail); return Math.min(time(text), time(text), time(text)); };
    const t64 = Math.max(best(64 * 1024), 1);
    const t256 = best(256 * 1024);
    expect(t256 / t64).toBeLessThan(6);
    expect(t256).toBeLessThan(250);
  });
});

// 1.0.18: the masking intent of native-md-stream rows 14d, 17 and 18, at the public layer where text still flows (the native trace no
// longer holds text, d9b5e9db8). The latch reset on a prompt or tool result lives in drivers/native.ts, which is private, so it is not
// asserted here; this module resets only at a line end.
describe("md-secret-label: clean text passes, a wrapped label masks the rest", () => {
  const mask = () => "«redacted»";
  it("maskSecretLabelsToEnd leaves clean text unmasked and masks the value after a wrapped label", () => {
    expect(maskSecretLabelsToEnd("clean text", mask)).toBe("clean text");
    const out = maskSecretLabelsToEnd("**password**: hunter2", mask);
    expect(out).not.toContain("hunter2");
    expect(out).toContain("«redacted»");
  });
  it("scanLabelDelta finds nothing in clean text and the mask point after a wrapped label, across deltas", () => {
    const clean = createLabelStream();
    expect(scanLabelDelta(clean, "clean text")).toBe(-1);
    const st = createLabelStream();
    expect(scanLabelDelta(st, "**password**")).toBe(-1);
    const raw = ": hunter2";
    const at = scanLabelDelta(st, raw);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(raw.slice(0, at)).not.toContain("hunter2");
    expect(raw.slice(at)).toContain("hunter2");
  });
  it("a new line starts a fresh line state, so clean text after a finished line is not masked", () => {
    const st = createLabelStream();
    expect(scanLabelDelta(st, "ordinary line\nclean text")).toBe(-1);
  });
});
