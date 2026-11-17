// REDACT-MD-SINKS (designs/REDACT-MD-SINKS-1104.md §5): extent A on machine
// sinks. Every row fails on the base (int/1015 b47ece583) on an assertion,
// except the guard rows 22 and 24, which pass on both. f(f(x)) = f(x) on every
// row. The stream rows (14-18) live in drivers/native-md-stream.test.ts and the
// electron rows (12, 13, 19 electron) in electron/diagnostics.test.mjs.
import { existsSync, readFileSync } from "node:fs";
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

// Row 24: versioned original-input/base/final evidence. Never regenerate
// expected output from the current redactor or use a base output as input.
const CORPUS = [
  ...ROWS.map(([, input]) => input),
  "the token: leave this prose alone", "const token = await getToken();", "use a **strong password** here",
  "the `password` field", "my_token: x", "password=hunter2000", "Authorization: Bearer abcdefghijklmnop",
  "XAI_API_KEY: «redacted 12 chars»TAILSECRET9", "api_key: sk-proj-abcdefghijklmnopqrstuv", "**password**: hunter2\nmore\n",
];
const FIXTURE = join(import.meta.dirname, "testing", "md-secret-label-user-text.base.json");

type GoldenRow = { id: string; sourceIndex?: number; input: string; base: string; final: string; rule: string };
const GOLDEN = JSON.parse(readFileSync(FIXTURE, "utf8")) as { version: number; baseCommit: string; rows: GoldenRow[] };
describe("REDACT-MD-SINKS user-visible text", () => {
  it("golden.move-equality", () => {
    expect(GOLDEN.version).toBe(2);
    expect(GOLDEN.baseCommit).toBe("c12aaad9341e8f87126a193f35b5c2768f0aa66f");
    const original = GOLDEN.rows.filter(row => row.sourceIndex !== undefined);
    expect(original.map(row => row.sourceIndex)).toEqual(Array.from({ length: 49 }, (_, i) => i + 1));
    expect(original.map(row => row.input)).toEqual(CORPUS);
    expect(new Set(GOLDEN.rows.map(row => row.id)).size).toBe(64);
    for (const row of original) {
      expect(row.id).toBe(`K-24-${String(row.sourceIndex).padStart(2, "0")}`);
      // Preserved legacy pipeline proves the archived base output too.
      expect(redact.TEXT_RULES.reduce((text, [, rule]) => rule(text), row.input)).toBe(row.base);
    }
  });
  it.each(GOLDEN.rows)("row 24 explicit base/final $id ($rule)", row => {
    expect(redact.redactSecretsInText(row.input)).toBe(row.final);
  });
  // This slice is built against the frozen base in parallel with Wave 1.
  // The combined tree runs this gate automatically; an isolated slice cannot certify
  // the collector-first activation gate from absent implementation files.
  it.runIf(process.env.L5A_INTEGRATION === "1" || existsSync(new URL("harness/audience-collector.ts", import.meta.url)))("collector-before-user-text", async () => {
    expect(existsSync(new URL("harness/audience-collector.ts", import.meta.url))).toBe(true);
    const bus = readFileSync(new URL("harness/bus.ts", import.meta.url), "utf8");
    const harness = readFileSync(new URL("index.ts", import.meta.url), "utf8");
    expect(bus).toContain("subscribeAudience");
    expect(bus).toContain("subscribeExecution");
    expect(harness).not.toMatch(/bus\.subscribe\(/);
    expect(harness).toContain("admitNewTurn");
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


import { exactAllowKeyFor } from "./auto-approve.ts";
import { readDoneWhen, doneWhenBriefLine } from "./done-when.ts";

describe("redact-md-caller-contract", () => {
  it("redact-md-caller-contract.plain-colon", () => {
    for (const [input, output] of [
      ["token: x", "token: «redacted 1 chars»"], ["my_token: x", "my_token: «redacted 1 chars»"],
      ["password:\thunter2 \t", "password:\t«redacted 7 chars» \t"],
      ["password: hunter2\nordinary", "password: «redacted 7 chars»\nordinary"],
      ["notoken: x", "notoken: x"], ["password=short", "password=short"],
      ["password: hunter2 and more", "password: hunter2 and more"], ["password:", "password:"],
      ["password: x\ry", "password: x\ry"],
    ]) expect(redact.redactSecretsInText(input!), input).toBe(output);
  });
  it("redact-md-caller-contract.numeric-password", () => {
    for (const name of ["password", "secret", "authorization"]) expect(redact.redactSecretsInText(`${name}: 1234`)).toBe(`${name}: «redacted 4 chars»`);
  });
  it("redact-md-caller-contract.count-label", () => {
    expect(redact.redactSecretsInText("tokens: 1200")).toBe("tokens: 1200");
    expect(redact.redactSecretsInText("token: 1200")).toBe("token: «redacted 4 chars»");
    expect(redact.redactSecretsInText("auth_tokens: 1200")).toBe("auth_tokens: «redacted 4 chars»");
    expect(redact.redactSecretsInText("auth tokens: 1200")).toBe("auth tokens: «redacted 4 chars»");
  });
  it("redact-md-caller-contract.fixed-types", () => {
    for (const type of ["string", "number", "boolean", "null", "object", "array", "undefined", "unknown", "any", "void", "never", "token"]) {
      // An exemption never cancels pre-existing KEY_VALUE protection (undefined).
      const input = `token: ${type}`;
      const legacy = redact.TEXT_RULES.reduce((text, [, rule]) => rule(text), input);
      expect(redact.redactSecretsInText(input)).toBe(legacy);
    }
    expect(redact.redactSecretsInText("token: String")).toBe("token: «redacted 6 chars»");
  });
  it("caller.exact-grant-refusal", () => {
    const exact = { engine: "codex", cwd: "/work/project", command: "printf hello" };
    expect(exactAllowKeyFor("Bash", "prints hello", exact)).toBeDefined();
    expect(exactAllowKeyFor("Bash", "**password**: hunter2", exact)).toBeUndefined();
  });
  it("caller.done-when-drop", () => {
    for (const input of ["**password**: hunter2", "password: 1234", "token:x"]) expect(readDoneWhen(input)).toEqual({ ok: true });
  });
  it("caller.done-when-restored", () => {
    expect(doneWhenBriefLine("**password**: hunter2")).toBe("");
    expect(doneWhenBriefLine("tests pass")).toBe("\n\n[Done when: tests pass]");
  });
  it("redact-md-caller-contract.caller-baselines", () => {
    for (const input of ["tests pass", "the token: leave this prose alone", "tokens: 1200", "token: token"]) {
      expect(redact.redactSecretsInText(input)).toBe(input);
      expect(readDoneWhen(input)).toEqual({ ok: true, value: input });
    }
    expect(sink("`token`: string")).not.toContain("string");
    expect(sink("my_token: x")).toBe("my_token: x");
  });
});
