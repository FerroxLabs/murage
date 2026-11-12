// Opus spec-check fix (hold = first send + 24 h in resolveUnknown): driven scenarios on the REAL reducer and world.
import { describe, expect, it } from "vitest";
import { CI_DOMAIN, DAY, H } from "./domain.ts";
import * as rm from "./reducer.ts";
import { seedIntentOpen } from "./seeds.ts";
import type { Move } from "./types.ts";
import * as m from "./world.ts";

const D = { ...CI_DOMAIN, budgets: { ...CI_DOMAIN.budgets, calls: 4, lost: 3, clock: 4, crashes: 2 } };
const play = (w0: ReturnType<typeof m.emptyWorld>, moves: Move[]) => {
  let w = w0; w.budget = { ...D.budgets };
  for (const mv of moves) { const r = m.step(w, mv, rm.reduce, D); if (r.error) throw new Error(r.error); w = r.world; }
  return w;
};
const intent = (w: ReturnType<typeof m.emptyWorld>) => w.homes.h1.durable.intents.b1 as unknown as Record<string, unknown>;

describe("Opus spec check: resolveUnknown judges the hold on the FIRST send (intent.at + 24 h)", () => {
  it("DRIVEN: a rotate sent at 0 whose last attempt was at 10 h is not resent with the old idem at DAY+1; the owner repair stays", () => {
    const s = seedIntentOpen(D).world;
    const i = intent(s); i.at = 0; i.unk = { kind: "rotate", first: 0, last: 10 * H };
    const w = play(s, [{ k: "clock", to: DAY + 1 }, { k: "drive", home: "h1", bot: "b1" }]);
    expect(Object.values(w.ops).some((o) => o.idem === "h1:b1:i1"), "no call with the old idem").toBe(false);
    expect(w.homes.h1.outbox.some((x) => x.a === "call" && x.idem === "h1:b1:i1")).toBe(false);
    expect(intent(w).step, "the owner repair persists").toBe("expired");
  });
});
