// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeSwallowedError, logSwallowedConsumingError } from "./consuming-error-log.ts";

afterEach(() => { vi.restoreAllMocks(); });

describe("swallowed consuming-ledger errors leave one bounded, secret-free line", () => {
  it("names class, code, fence and the top three frames as file:line only", () => {
    const error = Object.assign(new TypeError(`cannot open /Users/fixture-owner/.murage/memory-index.db token=${"a".repeat(48)}\nsecond line`), {
      code: "SQLITE_BUSY", fence: { state: "checking", reason: "lookup-error" } });
    error.stack = `TypeError: x\n    at run (/Users/fixture-owner/app/server/memory/send-fence.ts:114:9)\n    at /home/fixture/app/server/consuming-turn-response.ts:160:3\n    at guarded (file:///opt/app/server/consuming-turn-ingress.ts:62:30)\n    at four (/x/y.ts:1:1)`;
    const line = describeSwallowedError(error);
    expect(line).toContain("class=TypeError code=SQLITE_BUSY fence=checking/lookup-error");
    expect(line).toContain("at=send-fence.ts:114 < consuming-turn-response.ts:160 < consuming-turn-ingress.ts:62");
    expect(line).not.toMatch(/fixture-owner|\/home\/|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|y\.ts|\n/);
    expect(line).toContain('message="-"');
    expect(line.length).toBeLessThan(420);
  });

  it("never prints free message text (a parse or SQL error can quote stored bytes); a bare code word is kept", () => {
    let parseError: unknown;
    try { JSON.parse('{"memory":"fixture-marker-quoted-frame-bytes'); } catch (error) { parseError = error; }
    const sql = Object.assign(new Error("near \"fixture-marker-sql-value\": syntax error"), { code: "SQLITE_ERROR" });
    for (const error of [parseError, sql, new Error("fixture-marker plain words")]) {
      const line = describeSwallowedError(error);
      expect(line).not.toMatch(/fixture-marker/);
      expect(line).toContain('message="-"');
    }
    expect(describeSwallowedError(new Error("MEMORY_CONTEXT_REVOKED"))).toContain('message="MEMORY_CONTEXT_REVOKED"');
    expect(describeSwallowedError(new Error("Memory_context revoked"))).toContain('message="-"');
  });

  it("logs at most twenty lines per site and never throws into the caller", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 25; i++) logSwallowedConsumingError("test.site", new Error("BOOM"));
    logSwallowedConsumingError("test.other", null);
    expect(warn.mock.calls.filter(call => String(call[0]).includes("site=test.site"))).toHaveLength(20);
    expect(String(warn.mock.calls.at(-1)![0])).toContain("site=test.other n=1 class=object");
    warn.mockImplementation(() => { throw new Error("console broken"); });
    expect(() => logSwallowedConsumingError("test.third", new Error("x"))).not.toThrow();
  });
});
// secret-scan: fixture (generic /Users/fixture-owner paths; rehearsal-only marker)
