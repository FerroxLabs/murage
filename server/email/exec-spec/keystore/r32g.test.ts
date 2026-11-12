// r3.2g R1 harness gates (spec-owner ruling): the clock may step while a decided call sits in an outbox (bounded to just past holdEnd);
// holdEnd = first send (decision) + 24 h for every resend; a call still in the outbox past holdEnd is never sent.
// Mutants (harness world.ts text edits): holdEnd-from-last-send and clock-blocked-again are both KILLED.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CI_DOMAIN, DAY, H } from "./domain.ts";
import * as spec from "./invariants.current.ts";
import type { HomeAction, Move, Reducer } from "./types.ts";
import * as realWorld from "./world.ts";

const D = { ...CI_DOMAIN, budgets: { ...CI_DOMAIN.budgets, calls: 4, lost: 3, clock: 4 } };
/** one rotate (idem i1) on drive; the retry (same idem) on `lost`. The decision time is stamped by the scheduler. */
const reducer: Reducer = (home, ev) => {
  const h = structuredClone(home);
  const actions: HomeAction[] = [];
  const call = (): HomeAction => ({ a: "call", bot: "b1", kind: "rotate", idem: "i1", actor: "auto", at: (h.durable.intents.b1 as { at?: number } | undefined)?.at }); // r3.2h: every rotate/mint call carries intent.at
  if (ev.t === "drive" && ev.bot === "b1" && !h.durable.intents.b1) {
    h.durable.intents.b1 = { origin: "rotate", step: "rotate", oldKeyId: null, rotateIdem: "i1", at: ev.now, sends: 1, strays: [] } as never;
    actions.push(call());
  } else if (ev.t === "lost") actions.push(call());
  return { actions, state: h };
};
type W = typeof realWorld;
/** returns the names of the scenarios that FAIL on the given world module */
function scenarios(m: W): string[] {
  const failed: string[] = [];
  const check = (name: string, f: () => void) => { try { f(); } catch { failed.push(name); } };
  const start = () => {
    const w = m.emptyWorld(D); const h = w.homes[Object.keys(w.homes)[0]];
    h.durable.bindings.b1 = { state: "active" } as never; h.memory.evidence = { gen: 0, bots: {} } as never;
    return { w, hid: h.id };
  };
  const run = (moves: (hid: string) => Move[]) => {
    let { w, hid } = start(); const rs: ReturnType<W["step"]>[] = [];
    for (const mv of moves(hid)) { const r = m.step(w, mv, reducer, D); if (r.error) throw new Error(r.error); rs.push(r); w = r.world; }
    return { w, rs, hid };
  };
  const I7 = (spec.STEP_INVARIANTS as Record<string, (p: never, a: never, n: never) => boolean>).I7_idempotency;
  check("clock-steps-while-call-pending-bounded", () => {
    const { w } = run((hid) => [{ k: "drive", home: hid, bot: "b1" }]);
    expect(Object.values(w.homes)[0].outbox.some((x) => x.a === "call")).toBe(true);
    const t0 = w.now, to = m.enabledMoves(w, D).filter((x): x is Extract<Move, { k: "clock" }> => x.k === "clock").map((x) => x.to);
    expect(to.length, "clock enabled with a call pending").toBeGreaterThan(0);
    expect(Math.max(...to), "no jump beyond just past holdEnd").toBeLessThanOrEqual(t0 + DAY + 1);
    expect(to, "reaches just past holdEnd").toContain(t0 + DAY + 1);
  });
  check("resend-after-boot-inside-first-send-24h-keeps-first-send-holdEnd", () => {
    const { w, rs, hid } = run((hid) => [{ k: "drive", home: hid, bot: "b1" }, { k: "exec", home: hid }, { k: "dropReq", reqId: 1 }, { k: "clock", to: 10 * H }, { k: "exec", home: hid }]);
    void hid;
    const op = Object.values(w.ops)[0];
    expect(Object.values(w.ops).length).toBe(1);
    expect(op.firstSentAt).toBe(0);
    expect(spec.holdEnd(op)).toBe(DAY);
    const last = rs[rs.length - 1], prev = rs[rs.length - 2].world;
    expect(I7(prev as never, last.action as never, last.world as never), "resend inside first send + 24 h accepted").toBe(true);
  });
  check("outbox-call-past-holdEnd-is-never-sent", () => {
    const { w, rs } = run((hid) => [{ k: "drive", home: hid, bot: "b1" }, { k: "exec", home: hid }, { k: "dropReq", reqId: 1 }, { k: "clock", to: DAY + 1 }, { k: "exec", home: hid }]);
    expect(rs[rs.length - 1].action.kind).toBe("env");
    expect(w.requests.length).toBe(0);
    expect(Object.values(w.ops)[0].delivered.length).toBe(1);
  });
  return failed;
}

describe("r3.2g R1 clock and holdEnd (harness)", () => {
  it("real harness passes all R1 scenarios", () => { expect(scenarios(realWorld)).toEqual([]); });
  const MUT = [
    { id: "holdEnd-from-last-send", kills: ["resend-after-boot-inside-first-send-24h-keeps-first-send-holdEnd"],
      edits: [["        sendsOf(w.ops[opId], 1);", "        w.ops[opId].firstSentAt = w.now; sendsOf(w.ops[opId], 1);"]] },
    { id: "clock-blocked-again", kills: ["clock-steps-while-call-pending-bounded"],
      edits: [["  if (b.clock > 0) {\n    const ts", "  if (b.clock > 0 && !Number.isFinite(clockLimit)) {\n    const ts"]] },
    { id: "late-outbox-call-sent", kills: ["outbox-call-past-holdEnd-is-never-sent"],
      edits: [["if (a.a === \"call\" && expiresInOutbox(w, m.home, a)) {", "if (false) {"]] },
  ];
  for (const mu of MUT) {
    it(`mutant ${mu.id} is KILLED`, async () => {
      let src = readFileSync(new URL("./world.ts", import.meta.url), "utf8");
      for (const [from, to] of mu.edits) { expect(src.split(from).length, `${mu.id}: edit found once`).toBe(2); src = src.replace(from, to); }
      const name = `world.mut-g-${mu.id}.ts`, url = new URL(`./${name}`, import.meta.url);
      writeFileSync(url, src);
      try {
        const mod = (await import(/* @vite-ignore */ `./${name}`)) as W;
        const failed = scenarios(mod);
        console.log(`MUTANT ${mu.id}: fails ${failed.join(",") || "(nothing)"}`);
        for (const k of mu.kills) expect(failed, mu.id).toContain(k);
      } finally { rmSync(url, { force: true }); }
    });
  }
});
