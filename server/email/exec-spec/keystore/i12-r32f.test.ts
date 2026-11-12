// r3.2f I12 ruling gates: both mutants are KILLED by the named witnesses (a: I12 evaluated wholly on next; b: settled-op exemption removed).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as spec from "./invariants.current.ts";
import { fromStep } from "./invariants.registry.ts";
import { KEYSTORE_WITNESSES } from "./keystore-witnesses.ts";
import { runWitnesses } from "./witness.ts";

describe("I12 r3.2f mutants", () => {
  const MUT = [
    { id: "I12-wholly-on-next", kills: ["I12-rej-second-op-closed-without-answer"],
      edits: [["vals(prev.ops).some((o) => o.home === h.id && o.bot === b", "vals(next.ops).some((o) => o.home === h.id && o.bot === b"], ["prev.now < holdEnd(o) && !settledByStep(o)", "next.now < holdEnd(o)"]] },
    { id: "I12-no-settled-exemption", kills: ["I12-acc-close-on-settling-answer"],
      edits: [["prev.now < holdEnd(o) && !settledByStep(o)", "prev.now < holdEnd(o)"]] },
  ];
  for (const m of MUT) {
    it(`mutant ${m.id} is KILLED`, async () => {
      let src = readFileSync(new URL("./invariants.current.ts", import.meta.url), "utf8");
      for (const [from, to] of m.edits) { expect(src.split(from).length, `${m.id}: edit found once`).toBe(2); src = src.replace(from, to); }
      const dir = new URL("./__mutants12__/", import.meta.url);
      mkdirSync(dir, { recursive: true });
      try {
        writeFileSync(new URL(`${m.id}.ts`, dir), src);
        const mod = (await import(/* @vite-ignore */ `./__mutants12__/${m.id}.ts`)) as typeof spec;
        const mut = fromStep("I12_noCloseOverUnknown", mod.I12_noCloseOverUnknown as never);
        const failed = runWitnesses([mut], KEYSTORE_WITNESSES.filter((w) => w.invariant === mut.name)).map((x) => x.witness).sort();
        console.log(`MUTANT ${m.id}: fails ${failed.join(",") || "(nothing)"}`);
        for (const k of m.kills) expect(failed, m.id).toContain(k);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
});
