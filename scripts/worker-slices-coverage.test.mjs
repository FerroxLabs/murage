// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { expect, test } from "vitest";

const source = readFileSync(new URL("../server/memory/worker-slices.test.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;

// Collect the real test registrations without opening its database. The normal
// fixture run separately verifies all receipts and transaction slicing.
for (const timing of [undefined, "1"]) {
  test(`worker receipt coverage stays enabled with timing ${timing ?? "unset"}`, () => {
    const registrations = [];
    const register = skipped => (name, body) => registrations.push({ name, body, skipped });
    const it = Object.assign(register(false), { skip: register(true), skipIf: skipped => register(skipped) });
    const vitest = { it, beforeEach() {}, afterEach() {}, vi: { hoisted: fn => fn(), mock() {} } };
    runInNewContext(compiled, {
      exports: {}, process: { env: timing ? { MURAGE_TEST_TIMING: timing } : {} },
      require: name => name === "vitest" ? vitest : {},
    });
    const receipts = registrations.filter(row => row.name.includes("every receipt lands"));
    expect(receipts).toHaveLength(1);
    expect(receipts[0].skipped, "functional receipt coverage must run without the timing opt-in").toBe(false);
    expect(typeof receipts[0].body).toBe("function");
  });
}
