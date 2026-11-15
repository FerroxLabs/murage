// TEST SUPPORT ONLY. A deliberately tiny rotate flow, used to prove the harness (fault injector, supervisor queue, checker,
// counterexample printer) works end to end. It is NOT the keystore reducer. `bug: true` retires the old key straight off the
// 201 instead of waiting for the durable ack: the checker must find that.
import { DAY, MARGIN } from "./domain.ts";
import type { Home, HomeAction, HomeEvent, Reducer } from "./types.ts";

export const makeToyReducer = (bug: boolean): Reducer => (home: Home, ev: HomeEvent) => {
  const h = structuredClone(home);
  const actions: HomeAction[] = [];
  const snapshot = (bot: string, key: string): HomeAction => ({ a: "save", bots: { ...h.durable.disk.bots, [bot]: key }, owner: h.durable.disk.owner, retired: h.durable.disk.retired, prev: h.durable.disk.prev });
  switch (ev.t) {
    case "drive": {
      const b = ev.bot;
      if (h.durable.intents[b] || h.durable.bindings[b]?.state !== "active" || h.repairVisible[b]) break;
      const oldKeyId = h.durable.disk.bots[b] ?? null;
      const rotateIdem = `${h.id}:${b}:i${h.durable.disk.gen}`;
      h.durable.intents[b] = { origin: "rotate", step: "rotate", oldKeyId, rotateIdem, at: ev.now, sends: 1, strays: [], deadlineAt: ev.now + DAY - MARGIN };
      actions.push({ a: "call", bot: b, kind: "rotate", keyId: oldKeyId ?? undefined, idem: rotateIdem, actor: "auto", at: ev.now });
      break;
    }
    case "response": {
      const i = h.durable.intents[ev.bot];
      if (ev.kind === "delete") { if (i?.step === "retire_old") { delete h.durable.intents[ev.bot]; h.repairVisible[ev.bot] = false; } break; }
      if (!i || i.step !== "rotate") break;
      const r = ev.resp;
      if (r.code === 201 || (r.code === 409 && r.error === "rotation_pending" && r.keyId)) {
        const key = (r as { keyId: string }).keyId;
        i.newKeyId = key; i.step = "save";
        actions.push(snapshot(ev.bot, key));
        if (bug && i.oldKeyId) actions.push({ a: "call", bot: ev.bot, kind: "delete", keyId: i.oldKeyId, actor: "auto", cause: { by: "retire" } });
      } else if (r.code === 503) actions.push({ a: "call", bot: ev.bot, kind: "rotate", keyId: i.oldKeyId ?? undefined, idem: i.rotateIdem, actor: "auto", at: (i as { at?: number }).at });
      else if (r.code === 400) actions.push({ a: "alert", bot: ev.bot, code: "400_hold" });
      break;
    }
    case "lost": {
      const i = h.durable.intents[ev.bot];
      if (ev.kind === "rotate" && i?.step === "rotate") actions.push({ a: "call", bot: ev.bot, kind: "rotate", keyId: i.oldKeyId ?? undefined, idem: i.rotateIdem, actor: "auto", at: (i as { at?: number }).at });
      break;
    }
    case "ack": {
      h.durable.proof = ev.ev; h.memory.evidence = ev.ev; h.memory.D = { ...ev.ev.bots };
      for (const b of Object.keys(h.durable.intents)) {
        const i = h.durable.intents[b];
        if (i.step === "save" && i.newKeyId && ev.ev.bots[b] === i.newKeyId) {
          i.step = "retire_old"; h.memory.botKey[b] = i.newKeyId;
          if (i.oldKeyId && !bug) actions.push({ a: "call", bot: b, kind: "delete", keyId: i.oldKeyId, actor: "auto", cause: { by: "retire" } });
        }
      }
      break;
    }
    case "boot": {
      h.memory.evidence = ev.proofValid ? ev.proof : null;
      if (ev.proofValid && ev.proof) { h.memory.D = { ...ev.proof.bots }; h.memory.botKey = { ...ev.proof.bots }; }
      break;
    }
    case "rejected": h.repairVisible[ev.bot] = true; break;
    default: break;
  }
  return { actions, state: h };
};
