// r3.2h harness gates (Astra acct4 r3.2g DISAGREE + Fable r3.2g): the ONE drop rule (expiresInOutbox), no clock freeze, durable intent.at,
// the `expired` close, replayOpenR on the first send, the I6d/I7 spec clauses, the gate self-test. Mutants are text edits of the harness/spec/gate.
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runCheck } from "./checker.ts";
import type * as CheckerT from "./checker.ts";
import { CI_DOMAIN, DAY, H } from "./domain.ts";
import * as spec from "./invariants.current.ts";
import * as realReducer from "./reducer.ts";
import { seedIntentOpen, seedLV } from "./seeds.ts";
import type { HomeAction, Move, Reducer } from "./types.ts";
import * as realWorld from "./world.ts";

const D = { ...CI_DOMAIN, budgets: { ...CI_DOMAIN.budgets, calls: 4, lost: 3, clock: 4, crashes: 2 } };
type W = typeof realWorld;
type R = typeof realReducer;
const stub = (kind: "rotate" | "mint" | "delete" | "list"): Reducer => (home, ev) => {
  const h = structuredClone(home);
  const actions: HomeAction[] = [];
  const it = () => h.durable.intents.b1 as { at?: number } | undefined;
  const call = (): HomeAction => kind === "rotate" || kind === "mint"
    ? { a: "call", bot: "b1", kind, ...(kind === "rotate" ? { keyId: "K1" } : {}), idem: "i1", actor: "auto", at: it()?.at }
    : { a: "call", bot: "b1", kind, ...(kind === "delete" ? { keyId: "K1" } : {}), actor: "auto" };
  const hadIntent = !!it();
  if (ev.t === "drive" && ev.bot === "b1" && !hadIntent) {
    if (kind === "rotate" || kind === "mint") h.durable.intents.b1 = { origin: "rotate", step: "rotate", oldKeyId: "K1", rotateIdem: "i1", at: ev.now, sends: 1, strays: [] } as never;
    actions.push(call());
  } else if ((ev.t === "lost" || ev.t === "boot") && (hadIntent || kind === "delete" || kind === "list")) actions.push(call());
  else if (ev.t === "expired") delete h.durable.intents.b1;
  return { actions, state: h };
};
/** names of the scenarios that FAIL on the given world / reducer modules */
function scenarios(m: W, rm: R): string[] {
  const failed: string[] = [];
  const check = (name: string, f: () => void) => { try { f(); } catch (e) { failed.push(name); console.log(`SCENARIO ${name} failed: ${(e as Error).message.split("\n")[0]}`); } };
  const start = (d = D, base?: ReturnType<typeof m.emptyWorld>) => {
    const w = base ?? m.emptyWorld(d); const h = w.homes[Object.keys(w.homes)[0]];
    if (!base) { h.durable.bindings.b1 = { state: "active" } as never; h.memory.evidence = { gen: 0, bots: {} } as never; }
    return { w, hid: h.id };
  };
  const run = (red: Reducer, moves: (hid: string) => Move[], d = D, base?: ReturnType<typeof m.emptyWorld>) => {
    let { w, hid } = start(d, base); const rs: ReturnType<W["step"]>[] = [];
    for (const mv of moves(hid)) { const r = m.step(w, mv, red, d); if (r.error) throw new Error(r.error); rs.push(r); w = r.world; }
    return { w, rs, hid };
  };
  const pastHold = (hid: string): Move[] => [{ k: "drive", home: hid, bot: "b1" }, { k: "clock", to: DAY + 1 }, { k: "exec", home: hid }];
  check("expired-call-never-freezes-clock", () => {
    const D2 = { ...D, budgets: { ...D.budgets, calls: 1 } };
    const { w, hid } = run(stub("rotate"), (h) => [{ k: "drive", home: h, bot: "b1" }, { k: "exec", home: h }, { k: "dropReq", reqId: 1 }, { k: "clock", to: DAY + 1 }], D2);
    expect(w.homes[hid].outbox.some((x) => x.a === "call"), "retry re-emitted").toBe(true);
    expect(w.budget.calls).toBe(0);
    const mv = m.enabledMoves(w, D2);
    expect(mv.some((x) => x.k === "exec"), "the expired head can be dropped with no budget").toBe(true);
    expect(mv.some((x) => x.k === "clock" && x.to > DAY + 1), "time still moves").toBe(true);
  });
  for (const kind of ["delete", "list"] as const) check(`${kind === "delete" ? "old-key-delete" : "list"}-past-24h-is-sent`, () => {
    const { w, rs } = run(stub(kind), pastHold);
    expect(rs[rs.length - 1].action.kind).toBe("call");
    expect(w.requests.length).toBe(1);
  });
  check("rotate-after-successor-saved-is-not-dropped", () => {
    const { w, rs } = run(stub("rotate"), (hid) => [{ k: "drive", home: hid, bot: "b1" }, { k: "clock", to: DAY + 1 }, { k: "exec", home: hid }], D, (() => { const s = start(); s.w.homes[s.hid].durable.disk.bots.b1 = "K9"; return s.w; })());
    expect(rs[rs.length - 1].action.kind).toBe("call");
    expect(w.requests.length).toBe(1);
  });
  check("crash-before-first-exec-keeps-intent-at", () => {
    const base = [{ k: "drive" }, { k: "crash", mode: "power" }, { k: "clock", to: 10 * H }, { k: "boot" }] as const;
    const mk = (hid: string): Move[] => base.map((x) => ({ ...x, home: hid, bot: "b1" }) as unknown as Move);
    const a = run(stub("rotate"), (hid) => [...mk(hid), { k: "exec", home: hid }]);
    const op = Object.values(a.w.ops)[0];
    expect(op.firstSentAt).toBe(0);
    expect(spec.holdEnd(op)).toBe(DAY);
    const b = run(stub("rotate"), (hid) => [...mk(hid), { k: "clock", to: DAY + 1 }, { k: "exec", home: hid }]);
    expect(b.w.requests.length, "past the ORIGINAL holdEnd nothing is sent").toBe(0);
  });
  const seeded = () => { const s = seedIntentOpen(D, "rotate").world; s.budget = { ...D.budgets }; return s; };
  check("expired-rotate-closes-intent", () => {
    const { w } = run(rm.reduce, pastHold, D, seeded());
    const h = w.homes.h1, i = h.durable.intents.b1 as { rotateIdem?: string; unk?: unknown } | undefined;
    expect(i?.rotateIdem, "no dead idem left").toBeUndefined();
    expect(i?.unk).toBeUndefined();
    expect((h.memory as { busy?: Record<string, string> }).busy?.b1, "call-busy cleared").toBeUndefined();
    expect(h.outbox.some((x) => x.a === "call")).toBe(false);
    expect(w.requests.length).toBe(0);
  });
  check("replay-hold-ends-at-first-send", () => {
    const h = structuredClone(seeded().homes.h1) as never as Parameters<R["replayOpenR"]>[0];
    (h.durable.intents.b1 as unknown as { at: number; unk: unknown }).at = 0;
    (h.durable.intents.b1 as unknown as { unk: unknown }).unk = { kind: "rotate", first: 0, last: 10 * H };
    expect(rm.replayOpenR(h, "b1", DAY - 1)).toBe(true);
    expect(rm.replayOpenR(h, "b1", DAY + 1), "the hold ended at first send + 24 h, a late resend does not extend it").toBe(false);
  });
  check("expired-mint-reops", () => {
    const s = seedLV(D).world; s.budget = { ...D.budgets };
    s.homes.h1.durable.intents.b1 = { origin: "reconnect", step: "recover", next: "RC", oldKeyId: "b1:k1", mintIdem: "h1:b1:m0", at: 0, sends: 0, strays: [] } as never;
    const { w, rs } = run(rm.reduce, (hid) => [{ k: "clock", to: 10 * H }, { k: "drive", home: hid, bot: "b1" }, { k: "clock", to: DAY + 1 }, { k: "exec", home: hid }], D, s); // the op was decided at 0 (intent.at); the reducer's own last-send window (10 h + 24 h) is still open, so only the outbox drop acts
    expect(rs[rs.length - 1].action.kind, "the late mint is not sent").toBe("env");
    const i = w.homes.h1.durable.intents.b1 as unknown as { mintIdem: string; at: number };
    expect(i.mintIdem).not.toBe("h1:b1:m0");
    expect(i.at, "new op, decision time = now").toBe(DAY + 1);
    const out = w.homes.h1.outbox.find((x) => x.a === "call" && x.kind === "mint");
    expect(out && out.a === "call" && out.idem === i.mintIdem && out.at === DAY + 1, "the new mint is queued").toBe(true);
    const sent = m.step(w, { k: "exec", home: "h1" }, rm.reduce, D);
    expect(sent.error).toBeUndefined();
    expect(Object.values(sent.world.ops).find((o) => o.idem === i.mintIdem)?.firstSentAt).toBe(DAY + 1);
  });
  return failed;
}
const mutate = async <T,>(file: string, id: string, edits: string[][], tag: string): Promise<T> => {
  let src = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
  for (const [from, to] of edits) { expect(src.split(from).length, `${id}: edit found once`).toBe(2); src = src.replace(from, to); }
  const name = file.replace(".ts", `.mut-${tag}-${id}.ts`), url = new URL(`./${name}`, import.meta.url);
  writeFileSync(url, src);
  try { return (await import(/* @vite-ignore */ `./${name}`)) as T; } finally { rmSync(url, { force: true }); }
};

describe("r3.2h harness: drop rule, no freeze, intent.at, expired close, first-send replay hold", () => {
  it("real harness passes all r3.2h scenarios", () => { expect(scenarios(realWorld, realReducer)).toEqual([]); });
  const MUT: { id: string; file: "world.ts" | "reducer.ts"; kills: string[]; edits: string[][] }[] = [
    { id: "expired-drop-needs-budget", file: "world.ts", kills: ["expired-call-never-freezes-clock"], edits: [["head.a !== \"call\" || expiresInOutbox(w, hid, head) || (b.calls", "head.a !== \"call\" || (b.calls"]] },
    { id: "bound-includes-expired", file: "world.ts", kills: ["expired-call-never-freezes-clock"], edits: [["&& !expiresInOutbox(w, h.id, x) && w.now < callHoldEnd(w, h.id, x)) clockLimit", "&& w.now < callHoldEnd(w, h.id, x) + DAY) clockLimit = Math.min(clockLimit, callHoldEnd(w, h.id, x) + 1); if (false) clockLimit"]] },
    { id: "drop-all-kinds", file: "world.ts", kills: ["old-key-delete-past-24h-is-sent", "list-past-24h-is-sent"], edits: [["  if (a.kind === \"mint\") return w.now >= callHoldEnd(w, hid, a);\n  if (a.kind !== \"rotate\") return false;", "  return w.now >= callHoldEnd(w, hid, a);"]] },
    { id: "drop-ignores-519", file: "world.ts", kills: ["rotate-after-successor-saved-is-not-dropped"], edits: [["const successorUnsaved = stored === undefined || stored === old;", "const successorUnsaved = (stored === undefined || stored === old) || true;"]] },
    { id: "restamp-at-boot", file: "world.ts", kills: ["crash-before-first-exec-keeps-intent-at"], edits: [["(a.a === \"call\" && a.at === undefined ? { ...a, at: w.now } : a)", "(a.a === \"call\" ? { ...a, at: w.now } : a)"]] },
    { id: "expired-event-not-delivered", file: "world.ts", kills: ["expired-rotate-closes-intent"], edits: [["        reduceAt(m.home, ev({ t: \"expired\"", "        if (false) reduceAt(m.home, ev({ t: \"expired\""]] },
    { id: "drop-rotate-only", file: "world.ts", kills: ["expired-mint-reops"], edits: [["  if (a.kind === \"mint\") return w.now >= callHoldEnd(w, hid, a);\n", ""]] },
    { id: "replayOpenR-last-send", file: "reducer.ts", kills: ["replay-hold-ends-at-first-send"], edits: [["return now < i!.at + H24 || busyOf", "return now < u.last + H24 || busyOf"]] },
  ];
  for (const mu of MUT) it(`mutant ${mu.id} is KILLED`, async () => {
    const mod = await mutate<W & R>(mu.file, mu.id, mu.edits, "h");
    const failed = mu.file === "world.ts" ? scenarios(mod as W, realReducer) : scenarios(realWorld, mod as R);
    console.log(`MUTANT ${mu.id}: fails ${failed.join(",") || "(nothing)"}`);
    for (const k of mu.kills) expect(failed, mu.id).toContain(k);
  });
  it("mutant freeze-check-off is KILLED (hand-built frozen world: clock moves filtered out)", async () => {
    const frozen = (c: typeof CheckerT) => c.runCheck({ domain: { ...CI_DOMAIN, depth: 1 }, seeds: [seedLV(CI_DOMAIN)], movesFn: (w, d) => realWorld.enabledMoves(w, d).filter((x) => x.k !== "clock") });
    expect(frozen({ runCheck } as never).freezes.length, "real checker reports the freeze").toBeGreaterThan(0);
    const mod = await mutate<typeof CheckerT>("checker.ts", "freeze-check-off", [["return w.budget.clock > 0 && !moves.some((m) => m.k === \"clock\"); }", "return false; }"]], "h");
    expect(frozen(mod).freezes.length, "mutant misses it").toBe(0);
  });
});

describe("r3.2h spec: I6d progression and I7 intent.at", () => {
  const verdicts = (m: typeof spec, ids: string[]) => m.STEP_WITNESSES.filter((w) => ids.includes(w.id)).map((w) => {
    const ok = (m.STEP_INVARIANTS as Record<string, (p: never, a: never, n: never) => boolean>)[w.inv](w.prev as never, w.action as never, w.next as never);
    return { id: w.id, wrong: ok !== (w.expect === "accept") };
  });
  const IDS = ["I6d-acc-stamped-take-progresses-rotate-to-save", "I6d-rej-stamp-value-changed-in-progression", "I7-rej-intent-at-moved-same-idem", "I7-rej-created-op-firstSentAt-not-intent-at", "I7-acc-new-idem-new-at"];
  it("real spec: the five r3.2h witnesses give their verdicts", () => { const v = verdicts(spec, IDS); expect(v.length).toBe(5); expect(v.filter((x) => x.wrong)).toEqual([]); });
  const SMUT = [
    { id: "I6d-whole-intent", kills: ["I6d-acc-stamped-take-progresses-rotate-to-save"], edits: [["!(sameTake(b) && same(n.ownerReconnect, p?.ownerReconnect))", "!(same(n, p) && same(nh.durable.takeAuth[b], ph.durable.takeAuth[b]))"]] },
    { id: "I6d-identity-only-no-stamp-eq", kills: ["I6d-rej-stamp-value-changed-in-progression"], edits: [["!(sameTake(b) && same(n.ownerReconnect, p?.ownerReconnect))", "!sameTake(b)"]] },
    { id: "I7-no-at-check", kills: ["I7-rej-intent-at-moved-same-idem", "I7-rej-created-op-firstSentAt-not-intent-at"], edits: [["&& n.at !== p.at) return false;", "&& false) return false;"], ["if (created && !(defined(i?.at) && created.firstSentAt === i!.at)) return false;", ""]] },
  ];
  for (const mu of SMUT) it(`mutant ${mu.id} is KILLED`, async () => {
    const mod = await mutate<typeof spec>("invariants.current.ts", mu.id, mu.edits, "h");
    const wrong = verdicts(mod, IDS).filter((x) => x.wrong).map((x) => x.id);
    console.log(`MUTANT ${mu.id}: wrong verdicts ${wrong.join(",") || "(nothing)"}`);
    for (const k of mu.kills) expect(wrong, mu.id).toContain(k);
  });
});

describe("r3.2h RC gate self-test", () => {
  const selftest = (gate?: string) => { try { return { rc: 0, out: execFileSync("bash", [new URL("./gate-selftest.sh", import.meta.url).pathname, ...(gate ? [gate] : [])], { encoding: "utf8" }) }; } catch (e) { return { rc: 1, out: String((e as { stdout?: string }).stdout) }; } };
  it("the gate passes only the good case; every stub failure case fails it", () => { const r = selftest(); console.log(r.out.split("\n").filter((l) => l.startsWith("SELFTEST SUMMARY")).join("")); expect(r.rc).toBe(0); expect(r.out).toMatch(/SELFTEST SUMMARY: cases=1\d passed=1\d failed=0/); });
  it("mutant gate-r32g (the old script) is KILLED by the self-test", () => { const r = selftest(new URL("./gate-rc-d6.r32g.sh", import.meta.url).pathname); expect(r.rc).not.toBe(0); expect(r.out).toMatch(/failed=[1-9]/); });
});
