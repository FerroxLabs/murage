// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner writes as deltas on ONE store write chain (CLOUD-EMAIL-KEYSTORE-1019 r4 A, B and r5 A, B; tests S5 to S7, O1 to O11).
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { sanitizeEmailSecrets } from "../email/email-secrets.ts";
import { SealedSecretStore } from "./secrets.ts";
import { BOT_EMAIL_SECRETS_KEY } from "./credential-projection.ts";
import { applyOwnerDelta, docKeyIds, emailBootFields, readRecord, writeOwner, type EmailDoc } from "./email-keystore.ts";
import { createSupervisorPort } from "./supervisor-port.ts";
import type { DeviceCodePoll, FluxDeviceCodeClient, RevokeResult } from "./email-owner-signin.ts";

const KEY = Buffer.alloc(32, 7), MACHINE = "fixture-machine";
const START = { deviceCode: "dc-1", userCode: "ABCD-1234", verificationUrl: "https://flux.example/device", intervalMs: 5, expiresInMs: 10_000 };
const A = { token: "owner-A-CANARY", keyId: "key_A" };
const B = { token: "owner-B-CANARY", keyId: "key_B" };
const WIPE = { type: "murage:cloud-recovery-wipe", requestId: "11111111-1111-4111-8111-111111111111" };
const D0: EmailDoc = sanitizeEmailSecrets({ bots: { b1: { token: "bot-1", keyId: "key_b1" } } }) as EmailDoc;
const D1: EmailDoc = sanitizeEmailSecrets({ bots: { b1: { token: "bot-1", keyId: "key_b1" }, b2: { token: "bot-2", keyId: "key_b2" } } }) as EmailDoc;
const wipeFixture = () => ({ modelSignIn: { invalidateOwner: () => {}, dispatch: async () => {} } as unknown as NonNullable<Parameters<typeof createSupervisorPort>[0]["modelSignIn"]>, wipeEngineSignIns: async () => {} });
const until = async (check: () => boolean, label: string) => { for (let i = 0; i < 400; i++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error(`timed out: ${label}`); };

/** A home with a sealed store whose directory sync can be made to fail AFTER the rename (the commit is then uncertain). */
function home() {
  const state = { failSync: false, failRead: false, writes: [] as string[] };
  const dir = join(mkdtempSync(join(tmpdir(), "owner-reconcile-")), "secrets");
  const real = new SealedSecretStore(dir, MACHINE, KEY, { syncDir: () => { if (state.failSync) throw Object.assign(new Error("EIO"), { code: "EIO" }); return "synced"; } });
  const store = {
    getAll: () => real.getAll(), patch: real.patch.bind(real),
    patchDurable: (r: Record<string, string>) => { if (r[BOT_EMAIL_SECRETS_KEY]) state.writes.push(r[BOT_EMAIL_SECRETS_KEY]!); return real.patchDurable(r); },
    readBack: () => { if (state.failRead) { state.failRead = false; throw new Error("EIO read"); } return real.readBack(); },
  };
  const seed = (owner?: typeof A) => { expect(emailBootFields(real, true).emailStore).toBe(1); if (owner) writeOwner(real, owner, 0); };
  return { dir, real, store, state, seed, file: join(dir, "credentials.enc"), done: () => { real.close(); removeTempDirSync(join(dir, "..")); } };
}
/** Fake Flux client with one shared event log (sends and revokes in the order they happened). */
function fakeFlux(minted = B, over: Partial<{ poll: () => Promise<DeviceCodePoll>; revoke: (t: string) => Promise<RevokeResult> }> = {}) {
  const log: string[] = [];
  const client: FluxDeviceCodeClient = {
    start: vi.fn(async () => START),
    poll: over.poll ?? (async () => ({ state: "ok", owner: minted, scoped: true })),
    revoke: vi.fn(async (token: string) => { log.push(`revoke:${token}`); return over.revoke ? over.revoke(token) : "revoked"; }),
  };
  return { client, log };
}
/** A gate for the backoff timer: each wait stays open until released. */
function gate() {
  const waits: Array<() => void> = [];
  return { sleep: () => new Promise<void>(resolve => { waits.push(resolve); }), release: () => { waits.splice(0).forEach(r => r()); }, count: () => waits.length };
}
function boot(h: ReturnType<typeof home>, flux: ReturnType<typeof fakeFlux>, g: ReturnType<typeof gate>) {
  const send = vi.fn((m: object) => { const t = (m as { type: string; owner?: unknown }).type; if (t === "murage:cloud-email-owner") flux.log.push(`send:owner:${(m as { owner: { keyId: string } | null }).owner?.keyId ?? "null"}`); });
  const port = createSupervisorPort({ store: h.store, send, emailStore: true, emailSleep: async () => {}, emailBackoffSleep: g.sleep, emailDeviceCode: flux.client, ...wipeFixture() });
  const sent = (type: string) => send.mock.calls.map(c => c[0] as Record<string, unknown>).filter(m => m.type === type);
  const result = (state: string) => sent("murage:email-owner-signin-result").some(m => m.state === state);
  return { port, send, sent, result, start: (id = "r1") => port.handle({ type: "murage:email-owner-signin-start", requestId: id, actor: { environmentId: "e1", deviceId: "d1" }, gen: 0 }) };
}
const save = (rev: number, doc: EmailDoc, gen = 0) => ({ type: "murage:email-secrets-save", rev, epoch: 5, gen, doc });

describe("owner write that fails after the rename: reconcile, never revoke (r4 B)", () => {
  it("O1. dir sync throws EIO after rename: no revoke of A or B, no cloud-email-owner, status saving; the retry is durable: owner sent, THEN A revoked", async () => {
    const h = home(), flux = fakeFlux(), g = gate(); h.seed(A);
    try {
      const t = boot(h, flux, g);
      h.state.failSync = true;
      await t.start(); await until(() => t.result("saving"), "saving");
      expect(flux.client.revoke).not.toHaveBeenCalled();
      expect(t.sent("murage:cloud-email-owner")).toHaveLength(0);
      expect(t.sent("murage:cloud-email-owner-status")).toEqual([{ type: "murage:cloud-email-owner-status", owner: "saving" }]);
      h.state.failSync = false; g.release();
      await until(() => t.sent("murage:cloud-email-owner").length === 1, "owner sent");
      await until(() => flux.log.includes(`revoke:${A.token}`), "A revoked");
      expect(flux.log.filter(l => l.startsWith("send:owner"))).toEqual(["send:owner:key_B"]);
      expect(flux.log.indexOf("send:owner:key_B")).toBeLessThan(flux.log.indexOf(`revoke:${A.token}`));
      expect(flux.log).not.toContain(`revoke:${B.token}`);
      expect(readRecord(h.real.readBack())).toMatchObject({ ownerRev: 2, owner: B });
      expect(t.result("done")).toBe(true);
    } finally { h.done(); }
  });
  it("O2. the reread fails after the rename: same as O1", async () => {
    const h = home(), flux = fakeFlux(), g = gate(); h.seed(A);
    try {
      const t = boot(h, flux, g);
      h.state.failRead = true;
      await t.start(); await until(() => t.result("saving"), "saving");
      expect(flux.client.revoke).not.toHaveBeenCalled();
      expect(t.sent("murage:cloud-email-owner")).toHaveLength(0);
      g.release();
      await until(() => t.sent("murage:cloud-email-owner").length === 1, "owner sent");
      await until(() => flux.log.includes(`revoke:${A.token}`), "A revoked");
      expect(flux.log).not.toContain(`revoke:${B.token}`);
    } finally { h.done(); }
  });
  it("O3. the supervisor restarts during reconcile with the file holding B: boot owner is B, no revoke call for B on any path", async () => {
    const h = home(), flux = fakeFlux(), g = gate(); h.seed(A);
    try {
      const t = boot(h, flux, g);
      h.state.failSync = true;
      await t.start(); await until(() => t.result("saving"), "saving");
      t.port.dispose(); g.release();
      await new Promise(r => setTimeout(r, 30));
      const fresh = new SealedSecretStore(h.dir, MACHINE, KEY);
      try { expect(readRecord(fresh.getAll())!.owner).toEqual(B); } finally { fresh.close(); }
      expect(flux.client.revoke).not.toHaveBeenCalled();
    } finally { h.done(); }
  });
  it("O4. a refusal before anything was written (stale gen): B is revoked, A untouched, the file bytes unchanged", async () => {
    const h = home(), g = gate(); h.seed(A);
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const flux = fakeFlux(B, { poll: async () => { await hold; return { state: "ok", owner: B, scoped: true }; } });
    try {
      const t = boot(h, flux, g);
      await t.start(); await until(() => (flux.client.start as ReturnType<typeof vi.fn>).mock.calls.length === 1, "started");
      // another writer moved the generation while the sign-in waited (a wipe does exactly this)
      h.real.patch({ [BOT_EMAIL_SECRETS_KEY]: JSON.stringify({ ...readRecord(h.real.getAll())!, gen: 1 }) });
      const before = readFileSync(h.file, "utf8");
      release();
      await until(() => flux.log.includes(`revoke:${B.token}`), "B revoked");
      expect(flux.log).not.toContain(`revoke:${A.token}`);
      expect(readFileSync(h.file, "utf8")).toBe(before);
      expect(t.sent("murage:cloud-email-owner")).toHaveLength(0);
    } finally { h.done(); }
  });
  it("S5. a 200 without the email:owner scope writes no owner and revokes that key", async () => {
    const h = home(), g = gate(); h.seed();
    const flux = fakeFlux(B, { poll: async () => ({ state: "ok", owner: B, scoped: false }) });
    try {
      const t = boot(h, flux, g);
      await t.start(); await until(() => flux.log.includes(`revoke:${B.token}`), "B revoked");
      expect(readRecord(h.real.getAll())!.owner).toBeUndefined();
      expect(t.sent("murage:cloud-email-owner")).toHaveLength(0);
    } finally { h.done(); }
  });
  it("S6. a 200 after a newer attempt, after a wipe or after a gen change writes no owner, sends nothing, revokes the key", async () => {
    const h = home(), g = gate(); h.seed();
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    let polls = 0;
    const flux = fakeFlux(B, { poll: async () => { if (polls++ === 0) { await hold; return { state: "ok", owner: B, scoped: true }; } return { state: "pending" }; } });
    try {
      const t = boot(h, flux, g);
      await t.start("old"); await until(() => polls === 1, "first poll");
      await t.start("new"); // a newer attempt cancels the old one
      release();
      await until(() => flux.log.includes(`revoke:${B.token}`), "revoked");
      await new Promise(r => setTimeout(r, 30));
      expect(t.sent("murage:cloud-email-owner")).toHaveLength(0);
      expect(readRecord(h.real.getAll())!.owner).toBeUndefined();
    } finally { h.done(); }
  });
  it("O7. while a write is not confirmed: a new sign-in answers owner_busy and starts nothing", async () => {
    const h = home(), flux = fakeFlux(), g = gate(); h.seed(A);
    try {
      const t = boot(h, flux, g);
      h.state.failSync = true;
      await t.start(); await until(() => t.result("saving"), "saving");
      await t.start("r2");
      expect(t.sent("murage:email-owner-signin-result")).toContainEqual({ type: "murage:email-owner-signin-result", requestId: "r2", state: "owner_busy" });
      expect(flux.client.start).toHaveBeenCalledTimes(1);
    } finally { h.done(); }
  });
  it("O8. a recovery wipe during reconcile: the wipe's durable empty reread first, then A and B are both revoked, gen + 1", async () => {
    const h = home(), flux = fakeFlux(), g = gate(); h.seed(A);
    try {
      const t = boot(h, flux, g);
      h.state.failSync = true;
      await t.start(); await until(() => t.result("saving"), "saving");
      h.state.failSync = false;
      await t.port.handle(WIPE);
      expect(t.sent("murage:cloud-recovery-result")).toEqual([{ type: "murage:cloud-recovery-result", requestId: WIPE.requestId, ok: true }]);
      const rec = readRecord(h.real.readBack())!;
      expect(rec.gen).toBe(1); expect(rec.owner).toBeUndefined();
      await until(() => flux.log.includes(`revoke:${A.token}`) && flux.log.includes(`revoke:${B.token}`), "both revoked");
      g.release(); await new Promise(r => setTimeout(r, 20));
      expect(t.sent("murage:cloud-email-owner")).toHaveLength(0);
      expect(readRecord(h.real.readBack())!.owner).toBeUndefined();
    } finally { h.done(); }
  });
});

describe("ONE store write chain: a doc save during backoff never writes the old owner back (r5 A, B)", () => {
  it("O9. owner write fails after rename; a doc save with a new bot key (D1) fails too during backoff; the retry applies only the owner delta onto the latest record: B, ownerRev of P and D1's ids survive a restart; owner sent once; A revoked once, after", async () => {
    const h = home(), flux = fakeFlux(), g = gate(); h.seed(A);
    try {
      const t = boot(h, flux, g);
      await t.port.handle(save(1, D0));
      h.state.failSync = true;
      await t.start(); await until(() => t.result("saving"), "saving");
      await t.port.handle(save(2, D1)); // the doc lands in the file but is not confirmed: no ack
      expect(t.sent("murage:email-secrets-saved").map(m => m.rev)).toEqual([1]);
      h.state.failSync = false; g.release();
      await until(() => t.sent("murage:cloud-email-owner").length === 1, "owner sent");
      await until(() => flux.log.includes(`revoke:${A.token}`), "A revoked");
      const rec = readRecord(h.real.readBack())!;
      expect(rec.owner).toEqual(B); expect(rec.ownerRev).toBe(2);
      expect(docKeyIds(rec.doc)).toEqual(["key_b1", "key_b2"]);
      const fresh = new SealedSecretStore(h.dir, MACHINE, KEY);
      try { const again = readRecord(fresh.getAll())!; expect(again.owner).toEqual(B); expect(docKeyIds(again.doc)).toEqual(["key_b1", "key_b2"]); } finally { fresh.close(); }
      expect(flux.log.filter(l => l === `revoke:${A.token}`)).toHaveLength(1);
      expect(flux.log.indexOf("send:owner:key_B")).toBeLessThan(flux.log.indexOf(`revoke:${A.token}`));
    } finally { h.done(); }
  });
  it("O10. the doc save transaction during backoff is durable and rereads owner B: P is settled by it (owner sent, A revoked), the retry timer does nothing, zero further owner writes", async () => {
    const h = home(), flux = fakeFlux(), g = gate(); h.seed(A);
    try {
      const t = boot(h, flux, g);
      await t.port.handle(save(1, D0));
      h.state.failSync = true;
      await t.start(); await until(() => t.result("saving"), "saving");
      h.state.failSync = false;
      await t.port.handle(save(2, D1));
      expect(t.sent("murage:email-secrets-saved").map(m => m.rev)).toEqual([1, 2]);
      expect(t.sent("murage:cloud-email-owner")).toEqual([{ type: "murage:cloud-email-owner", gen: 0, ownerRev: 2, owner: B }]);
      await until(() => flux.log.includes(`revoke:${A.token}`), "A revoked");
      const writes = h.state.writes.length;
      g.release(); await new Promise(r => setTimeout(r, 30));
      expect(h.state.writes.length).toBe(writes);
      expect(t.sent("murage:cloud-email-owner")).toHaveLength(1);
      expect(flux.log.filter(l => l === `revoke:${A.token}`)).toHaveLength(1);
      const rec = readRecord(h.real.readBack())!;
      expect(rec.owner).toEqual(B); expect(docKeyIds(rec.doc)).toEqual(["key_b1", "key_b2"]);
      // a later doc save no longer carries any owner delta
      await t.port.handle(save(3, D1));
      expect(readRecord(h.real.readBack())!.ownerRev).toBe(2);
    } finally { h.done(); }
  });
  it("O11. the owner delta holds no doc: the written doc is byte-equal to the latest record's doc, even when that doc is newer than anything the lane saw", () => {
    const h = home(); h.seed(A);
    try {
      h.real.patch({ [BOT_EMAIL_SECRETS_KEY]: JSON.stringify({ ...readRecord(h.real.getAll())!, doc: D1 }) });
      const latest = readRecord(h.real.getAll())!;
      const written: string[] = [];
      const spy = { ...h.store, patchDurable: (r: Record<string, string>) => { written.push(r[BOT_EMAIL_SECRETS_KEY]!); return h.real.patchDurable(r); } };
      const delta = { gen: 0, ownerRev: 9, owner: B };
      expect(Object.keys(delta).sort()).toEqual(["gen", "owner", "ownerRev"]);
      expect(applyOwnerDelta(spy, delta)).toEqual({ kind: "ok", gen: 0, ownerRev: 9 });
      expect(JSON.stringify((JSON.parse(written[0]!) as { doc: unknown }).doc)).toBe(JSON.stringify(latest.doc));
      expect(JSON.parse(written[0]!)).toMatchObject({ ownerRev: 9, owner: B, gen: 0, storeId: latest.storeId });
      // another generation: nothing is written
      expect(applyOwnerDelta(spy, { ...delta, gen: 1 })).toEqual({ kind: "dropped" });
      expect(written).toHaveLength(1);
    } finally { h.done(); }
  });
  it("O11b. at the port: the retry writes the doc that is in the store at that moment, not the one the lane started from", async () => {
    const h = home(), flux = fakeFlux(), g = gate(); h.seed(A);
    try {
      const t = boot(h, flux, g);
      await t.port.handle(save(1, D0));
      h.state.failSync = true;
      await t.start(); await until(() => t.result("saving"), "saving");
      h.real.patch({ [BOT_EMAIL_SECRETS_KEY]: JSON.stringify({ ...readRecord(h.real.getAll())!, doc: D1 }) });
      h.state.failSync = false;
      const before = h.state.writes.length;
      g.release();
      await until(() => t.sent("murage:cloud-email-owner").length === 1, "owner sent");
      const retried = JSON.parse(h.state.writes[before]!) as { doc: unknown; owner: unknown };
      expect(JSON.stringify(retried.doc)).toBe(JSON.stringify(D1));
      expect(retried.owner).toEqual(B);
    } finally { h.done(); }
  });
});
