import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PushLedger } from "./push-ledger";

type Step = Record<string, unknown> & { op: string };
const fixture = JSON.parse(readFileSync(new URL("../contract/push-ledger.json", import.meta.url), "utf8")) as {
  cases: Array<{ name: string; steps: Step[] }>;
  decode: Array<{ input: string; total: number }>;
};

/** One interpreter, copied step for step by PushLedgerTests.swift and PushLedgerTest.java. */
export function run(steps: Step[]): void {
  let ledger = new PushLedger();
  for (const s of steps) {
    switch (s.op) {
      case "bind": ledger.bind(s.bindingId as string, s.origin as string); break;
      case "origin": expect(ledger.origin(s.bindingId as string)).toBe(s.expect); break;
      case "binding": expect(ledger.binding(s.origin as string)).toBe(s.expect); break;
      case "bindingIds": expect(ledger.bindingIds).toEqual(s.expect); break;
      case "accept":
        expect(ledger.accept(s.bindingId as string, s.collapseKey as string, s.revision as number, s.workspaceBadge as number)).toBe(s.expect);
        expect(ledger.total).toBe(s.total);
        break;
      case "acceptMany":
        for (let i = 0; i < (s.count as number); i++) ledger.accept(s.bindingId as string, `${s.prefix}${i}`, s.revision as number, s.workspaceBadge as number);
        break;
      case "setBadge": ledger.setBadge(s.bindingId as string, s.count as number); expect(ledger.total).toBe(s.total); break;
      case "unbindOrigin": expect(ledger.unbindOrigin(s.origin as string)).toBe(s.expect); expect(ledger.total).toBe(s.total); break;
      case "reconcile":
        expect(ledger.reconcile(s.bindingId as string, s.badge as number, s.pending as Array<{ collapseKey: string; revision: number }>, s.shown as string[])).toEqual(s.expect);
        expect(ledger.total).toBe(s.total);
        break;
      case "roundTrip": ledger = PushLedger.decode(ledger.encode()); break;
      default: throw new Error(`unknown op ${s.op}`);
    }
  }
}

describe("PushLedger", () => {
  it.each(fixture.cases)("$name", ({ steps }) => run(steps));
  it.each(fixture.decode)("decodes $input forgivingly", ({ input, total }) => {
    expect(PushLedger.decode(input).total).toBe(total);
  });
});
