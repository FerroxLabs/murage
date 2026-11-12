// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { EmailSecretStore, credentialFingerprint, sanitizeEmailSecrets, type EmailSecretsDoc } from "../email/email-secrets.ts";
import { SealedSecretStore } from "./secrets.ts";
import { BOT_EMAIL_SECRETS_KEY, isGenericCredentialPatch, serverCredentialProjection } from "./credential-projection.ts";
import { createSupervisorPort } from "./supervisor-port.ts";
import { createHomeSupervisorSession } from "./supervisor-session.ts";
import { parseServerSecrets } from "./server-secrets.ts";
import { HOME_SERVER_ENV_KEYS, HOME_SERVER_OPTIONAL_ENV_KEYS, homeServerEnvironment } from "./boot.ts";
import { EMAIL_ENVELOPE_LIMIT, cloudBotEmailEnabled, docKeyIds, emailBootFields, readRecord, stripOwner, writeOwner, type EmailDoc } from "./email-keystore.ts";
import { cloudEmailBackend, createCloudEmailSaver } from "./email-keystore-server.ts";
import { cloudHomeCopy } from "./copy.ts";

const KEY = Buffer.alloc(32, 7), MACHINE = "fixture-machine";
const TOKEN_BOT = "bot-token-CANARY-1111", TOKEN_OWNER = "owner-token-CANARY-2222";
const full: EmailSecretsDoc = sanitizeEmailSecrets({ owner: { token: TOKEN_OWNER, keyId: "key_owner" }, bots: { b1: { token: TOKEN_BOT, keyId: "key_b1" }, b2: { token: "bot-token-CANARY-3333", keyId: "key_b2" } } });
const doc: EmailDoc = stripOwner(full);
const save = (rev = 1, epoch = 5, gen = 0, d: unknown = doc) => ({ type: "murage:email-secrets-save", rev, epoch, gen, doc: d });

function home(seams?: ConstructorParameters<typeof SealedSecretStore>[3]) {
  const dir = join(mkdtempSync(join(tmpdir(), "email-keystore-")), "secrets");
  const store = new SealedSecretStore(dir, MACHINE, KEY, seams);
  const seed = () => { expect(emailBootFields(store, true).emailStore).toBe(1); return readRecord(store.getAll())!; };
  return { dir, store, seed, file: join(dir, "credentials.enc"), done: () => { store.close(); removeTempDirSync(join(dir, "..")); } };
}
const sent = (send: ReturnType<typeof vi.fn>, type: string) => send.mock.calls.map(c => c[0] as Record<string, unknown>).filter(m => m.type === type);
const wipeFixture = () => ({ modelSignIn: { invalidateOwner: () => {}, dispatch: async () => {} } as unknown as NonNullable<Parameters<typeof createSupervisorPort>[0]["modelSignIn"]>, wipeEngineSignIns: async () => {} });
const WIPE = { type: "murage:cloud-recovery-wipe", requestId: "11111111-1111-4111-8111-111111111111" };

describe("H1 durable save: fsync, rename, a directory sync that ran, an authenticated reread", () => {
  it("1. a filesystem that cannot sync a directory: no ack, a refusal with a reason only", async () => {
    const h = home({ syncDir: () => "unsupported" }), send = vi.fn();
    try {
      h.store.patch({ [BOT_EMAIL_SECRETS_KEY]: JSON.stringify({ v: 1, storeId: "a".repeat(32), gen: 0, ownerRev: 0, doc: { bots: {} } }) });
      await createSupervisorPort({ store: h.store, send, emailStore: true }).handle(save());
      expect(sent(send, "murage:email-secrets-saved")).toHaveLength(0);
      expect(sent(send, "murage:email-secrets-refused")).toEqual([{ type: "murage:email-secrets-refused", rev: 1, epoch: 5, reason: "not_durable" }]);
    } finally { h.done(); }
  });
  it("2. rename succeeds, the directory fsync throws EIO: no ack", async () => {
    let fail = false;
    const h = home({ syncDir: () => { if (fail) throw Object.assign(new Error("EIO"), { code: "EIO" }); return "synced"; } }), send = vi.fn();
    try {
      h.seed(); fail = true;
      await createSupervisorPort({ store: h.store, send, emailStore: true }).handle(save());
      expect(sent(send, "murage:email-secrets-saved")).toHaveLength(0);
      expect(sent(send, "murage:email-secrets-refused")[0]).toMatchObject({ reason: "write_failed" });
    } finally { h.done(); }
  });
  it("3. ack key ids come from the reread: a corrupted file gives no ack, a tampered doc gives no ack", async () => {
    const h = home(), send = vi.fn();
    try {
      h.seed();
      const corrupt = { getAll: () => h.store.getAll(), patch: h.store.patch.bind(h.store), patchDurable: (r: Record<string, string>) => { const out = h.store.patchDurable(r); writeFileSync(h.file, "garbage", { mode: 0o600 }); return out; }, readBack: () => h.store.readBack() };
      await createSupervisorPort({ store: corrupt, send, emailStore: true }).handle(save());
      expect(sent(send, "murage:email-secrets-saved")).toHaveLength(0);
      expect(JSON.stringify(send.mock.calls)).not.toContain("CANARY");
    } finally { h.done(); }
    const g = home(), send2 = vi.fn();
    try {
      const rec = g.seed();
      // memory says both keys are saved; the disk holds only b1: the superset check fails and key_b2 is never acknowledged
      const tamper = { getAll: () => g.store.getAll(), patch: g.store.patch.bind(g.store), patchDurable: (r: Record<string, string>) => { const next = JSON.parse(r[BOT_EMAIL_SECRETS_KEY]!); delete next.doc.bots.b2; return g.store.patchDurable({ [BOT_EMAIL_SECRETS_KEY]: JSON.stringify(next) }); }, readBack: () => g.store.readBack() };
      await createSupervisorPort({ store: tamper, send: send2, emailStore: true }).handle(save(1, 5, rec.gen));
      expect(sent(send2, "murage:email-secrets-saved")).toHaveLength(0);
    } finally { g.done(); }
  });
  it("3b. a good save acks {rev, epoch, gen, keyIds} read back from disk, and a fresh store on the dir agrees", async () => {
    const h = home(), send = vi.fn();
    try {
      h.seed();
      await createSupervisorPort({ store: h.store, send, emailStore: true }).handle(save(3, 9));
      expect(sent(send, "murage:email-secrets-saved")).toEqual([{ type: "murage:email-secrets-saved", rev: 3, epoch: 9, gen: 0, keyIds: ["key_b1", "key_b2"] }]);
      const fresh = new SealedSecretStore(h.dir, MACHINE, KEY);
      expect(docKeyIds(readRecord(fresh.getAll())!.doc)).toEqual(["key_b1", "key_b2"]);
      fresh.close();
    } finally { h.done(); }
  });
  it("4. probe unsupported: no emailStore in the envelope, the backend answers none", () => {
    const h = home({ syncDir: () => "unsupported" });
    try {
      expect(h.store.probeDurable()).toBe(false);
      expect(emailBootFields(h.store, true)).toEqual({});
      const session = createHomeSupervisorSession({ store: h.store, bootstrapSecret: "b".repeat(40), emailStore: h.store.probeDurable() });
      expect(cloudEmailBackend(parseServerSecrets(session.envelope()))).toBe("none");
      session.close();
    } finally { h.done(); }
    const ok = home();
    try { expect(ok.store.probeDurable()).toBe(true); } finally { ok.done(); }
  });
});

describe("H2 recovery: the email generation is fenced before ok", () => {
  it("5. the wipe bumps gen, drops owner and keys, and is durable before ok:true; an old-gen save queued behind it is refused", async () => {
    const h = home(), send = vi.fn();
    try {
      const rec = h.seed();
      const port = createSupervisorPort({ store: h.store, send, emailStore: true, ...wipeFixture() });
      await port.handle(save(1, 5, rec.gen));
      writeOwner(h.store, { token: TOKEN_OWNER, keyId: "key_owner" }, rec.gen);
      await port.handle(WIPE);
      const after = readRecord(h.store.readBack())!;
      expect(after).toMatchObject({ storeId: rec.storeId, gen: rec.gen + 1, ownerRev: 2 });
      expect(after.owner).toBeUndefined();
      expect(docKeyIds(after.doc)).toEqual([]);
      expect(sent(send, "murage:cloud-recovery-result")).toEqual([expect.objectContaining({ ok: true })]);
      send.mockClear();
      await port.handle(save(2, 5, rec.gen));
      expect(sent(send, "murage:email-secrets-saved")).toHaveLength(0);
      expect(sent(send, "murage:email-secrets-refused")[0]).toMatchObject({ reason: "stale_generation" });
    } finally { h.done(); }
  });
  it("6. a sign-in that completes after the wipe writes no owner and sends no cloud-email-owner", async () => {
    const h = home(), send = vi.fn();
    try {
      h.seed();
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const deviceCode = { start: async () => ({ deviceCode: "d", userCode: "U", verificationUrl: "https://x/", intervalMs: 1, expiresInMs: 100000 }), poll: async () => { await gate; return { state: "ok" as const, owner: { token: TOKEN_OWNER, keyId: "key_owner" }, scoped: true }; }, revoke: vi.fn(async () => "revoked" as const) };
      const port = createSupervisorPort({ store: h.store, send, emailStore: true, emailDeviceCode: deviceCode, emailSleep: async () => {}, ...wipeFixture() });
      await port.handle({ type: "murage:email-owner-signin-start", requestId: "r", actor: { environmentId: "e1", deviceId: "d1" }, gen: 0 });
      await port.handle(WIPE);
      release(); await new Promise(r => setTimeout(r, 50));
      expect(sent(send, "murage:cloud-email-owner")).toHaveLength(0);
      expect(readRecord(h.store.readBack())!.owner).toBeUndefined();
      // the key that never reached the file is revoked (r4 revoke rule 1)
      await new Promise(r => setTimeout(r, 20));
      expect(deviceCode.revoke).toHaveBeenCalledWith(TOKEN_OWNER);
    } finally { h.done(); }
  });
  it("7. the server fence: after it nothing is persisted, held or answered; recovery calls it first", () => {
    const persist = vi.fn(), store = new EmailSecretStore(persist);
    store.attachCloud({ storeId: "a".repeat(32), gen: 0, ownerRev: 0, owner: { token: TOKEN_OWNER, keyId: "key_owner" }, doc: stripOwner(full) });
    expect(store.botKey("b1")).not.toBeNull();
    store.fence();
    store.setBotKey("b9", { token: "t", keyId: "k" }); store.setOwner({ token: "t", keyId: "k" }); store.clearBotKey("b1"); store.replaceAll(full);
    expect(persist).not.toHaveBeenCalled();
    expect(store.botKey("b1")).toBeNull(); expect(store.owner()).toBeNull(); expect(store.isFenced()).toBe(true);
    const index = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    expect(index).toMatch(/if \(reason === "recovery"\) \{ emailRuntime\.stop\(\); emailRuntime\.secrets\.fence\(\); \}\s*homeExecutionGate!\.hold\(reason/);
  });
  it("8. a wipe that cannot be made durable or reread reports ok:false", async () => {
    const h = home(), send = vi.fn();
    try {
      h.seed();
      const bad = { getAll: () => h.store.getAll(), patch: h.store.patch.bind(h.store), patchDurable: () => { throw new Error("disk"); }, readBack: () => h.store.readBack() };
      await createSupervisorPort({ store: bad, send, emailStore: true, ...wipeFixture() }).handle(WIPE);
      expect(sent(send, "murage:cloud-recovery-result")[0]).toMatchObject({ ok: false });
      const g = home({ syncDir: () => "unsupported" }), send2 = vi.fn();
      try {
        g.store.patch({ [BOT_EMAIL_SECRETS_KEY]: JSON.stringify({ v: 1, storeId: "a".repeat(32), gen: 0, ownerRev: 0, doc: { bots: {} } }) });
        await createSupervisorPort({ store: g.store, send: send2, ...wipeFixture() }).handle(WIPE);
        expect(sent(send2, "murage:cloud-recovery-result")[0]).toMatchObject({ ok: false });
      } finally { g.done(); }
    } finally { h.done(); }
  });
  it("the wipe is not gated by the flag: a home turned OFF after it held keys still erases them; a home that never had a record is untouched", async () => {
    const h = home(), send = vi.fn(), plain = home(), send2 = vi.fn();
    try {
      const rec = h.seed();
      await createSupervisorPort({ store: h.store, send, ...wipeFixture() }).handle(WIPE);
      expect(readRecord(h.store.readBack())!.gen).toBe(rec.gen + 1);
      await createSupervisorPort({ store: plain.store, send: send2, ...wipeFixture() }).handle(WIPE);
      expect(plain.store.getAll()[BOT_EMAIL_SECRETS_KEY]).toBeUndefined();
      expect(sent(send2, "murage:cloud-recovery-result")[0]).toMatchObject({ ok: true });
    } finally { h.done(); plain.done(); }
  });
});

describe("H4 one writer per slot, compare-and-set on gen", () => {
  it("13. owner B (ownerRev 2) then a server save built when owner was A: the sealed owner stays B, also after a crash and reread", async () => {
    const h = home(), send = vi.fn();
    try {
      const rec = h.seed();
      writeOwner(h.store, { token: "a-tok", keyId: "key_A" }, rec.gen);
      writeOwner(h.store, { token: "b-tok", keyId: "key_B" }, rec.gen);
      const port = createSupervisorPort({ store: h.store, send, emailStore: true });
      await port.handle(save(1, 5, rec.gen));
      expect(readRecord(h.store.readBack())).toMatchObject({ ownerRev: 2, owner: { keyId: "key_B" } });
      const fresh = new SealedSecretStore(h.dir, MACHINE, KEY);
      expect(readRecord(fresh.getAll())).toMatchObject({ ownerRev: 2, owner: { keyId: "key_B" } });
      fresh.close();
    } finally { h.done(); }
  });
  it("14. a save with an owner field is refused, and an old rev in the same epoch is refused", async () => {
    const h = home(), send = vi.fn();
    try {
      const rec = h.seed();
      const port = createSupervisorPort({ store: h.store, send, emailStore: true });
      await port.handle(save(1, 5, rec.gen, { ...doc, owner: { token: "x", keyId: "k" } }));
      await port.handle(save(4, 5, rec.gen));
      await port.handle(save(4, 5, rec.gen)); await port.handle(save(3, 5, rec.gen));
      await port.handle(save(1, 6, rec.gen)); // a new epoch starts fresh
      expect(sent(send, "murage:email-secrets-refused").map(m => m.reason)).toEqual(["owner_field", "stale_revision", "stale_revision"]);
      expect(sent(send, "murage:email-secrets-saved")).toHaveLength(2);
    } finally { h.done(); }
  });
  it("15. the server applies cloud-email-owner only for its gen and a newer ownerRev; null clears; the owner slot is never in a server save", () => {
    const store = new EmailSecretStore();
    store.attachCloud({ storeId: "a".repeat(32), gen: 2, ownerRev: 3, doc: stripOwner(full) });
    const msg = (gen: number, ownerRev: number, owner: unknown) => ({ type: "murage:cloud-email-owner", gen, ownerRev, owner });
    expect(store.applyCloudOwner(msg(1, 9, { token: "t", keyId: "old_gen" }))).toBe(true);
    expect(store.applyCloudOwner(msg(2, 3, { token: "t", keyId: "same_rev" }))).toBe(true);
    expect(store.owner()).toBeNull();
    store.applyCloudOwner(msg(2, 4, { token: "tok4", keyId: "key_4" }));
    expect(store.owner()?.keyId).toBe("key_4");
    store.applyCloudOwner(msg(2, 4, { token: "tok4b", keyId: "key_4b" }));
    expect(store.owner()?.keyId).toBe("key_4");
    store.applyCloudOwner(msg(2, 5, null));
    expect(store.owner()).toBeNull();
    expect(store.applyCloudOwner({ type: "murage:email-owner" })).toBe(false);
    const saver = createCloudEmailSaver(2, () => 7);
    expect(saver.message(full)).toMatchObject({ gen: 2, epoch: 7 });
    expect(saver.message(full).doc).not.toHaveProperty("owner");
  });
  it("16. a save that drops an acked prev or retired key id without moving it is refused (production sanitizer, no swap)", async () => {
    const h = home(), send = vi.fn();
    try {
      const rec = h.seed();
      const port = createSupervisorPort({ store: h.store, send, emailStore: true });
      const withPrev = { ...doc, prev: { b1: { token: "p", keyId: "key_prev" } }, retired: [{ token: "r", keyId: "key_ret" }] };
      await port.handle(save(1, 5, rec.gen, withPrev));
      expect(sent(send, "murage:email-secrets-saved")).toHaveLength(1);
      await port.handle(save(2, 5, rec.gen, { ...doc, prev: {}, retired: [{ token: "r", keyId: "key_ret" }] }));
      expect(sent(send, "murage:email-secrets-refused").map(m => m.reason)).toEqual(["would_drop_acked"]);
      // moving key_prev into another slot is allowed
      await port.handle(save(3, 5, rec.gen, { ...doc, prev: {}, retired: [{ token: "r", keyId: "key_ret" }, { token: "p", keyId: "key_prev" }] }));
      expect(sent(send, "murage:email-secrets-saved")).toHaveLength(2);
    } finally { h.done(); }
  });
});

describe("the record never leaves the sealed path; the boot field is checked", () => {
  it("3. serverCredentialProjection omits it, and cloud-credential-write cannot overwrite or clear it", async () => {
    expect(serverCredentialProjection({ fluxApiKey: "k", [BOT_EMAIL_SECRETS_KEY]: "{}" })).toEqual({ fluxApiKey: "k" });
    expect(isGenericCredentialPatch({ [BOT_EMAIL_SECRETS_KEY]: "" })).toBe(false);
    const h = home(), send = vi.fn();
    try {
      const rec = h.seed(), before = h.store.getAll()[BOT_EMAIL_SECRETS_KEY];
      await createSupervisorPort({ store: h.store, send }).handle({ type: "murage:cloud-credential-write", requestId: "r1", credentials: { [BOT_EMAIL_SECRETS_KEY]: "" } });
      expect(sent(send, "murage:cloud-refused")).toHaveLength(1);
      expect(h.store.getAll()[BOT_EMAIL_SECRETS_KEY]).toBe(before);
      expect(rec.gen).toBe(0);
    } finally { h.done(); }
  });
  it("boot: a home whose credential file holds the record still boots; the record is not in env, in credentials, or in the generic path", () => {
    const h = home();
    try {
      h.store.patch({ fluxApiKey: "k" }); h.seed();
      h.store.patch({ [BOT_EMAIL_SECRETS_KEY]: JSON.stringify({ ...readRecord(h.store.getAll())!, owner: { token: TOKEN_OWNER, keyId: "key_owner" }, doc: full }) });
      for (const emailStore of [false, true]) {
        const reopened = new SealedSecretStore(h.dir, MACHINE, KEY);
        expect(reopened.getAll()[BOT_EMAIL_SECRETS_KEY]).toBeTruthy();
        const session = createHomeSupervisorSession({ store: reopened, bootstrapSecret: "b".repeat(40), emailStore });
        const parsed = parseServerSecrets(session.envelope());
        expect(Object.keys(parsed.credentials)).toEqual(["fluxApiKey"]);
        expect(JSON.stringify(parsed.credentials)).not.toContain("CANARY");
        expect(parsed.emailStore).toBe(emailStore ? 1 : undefined);
        expect(Boolean(parsed.emailSecrets)).toBe(emailStore);
        session.close();
      }
      const env = homeServerEnvironment({ machineId: MACHINE, adminUrl: "https://a.example/", publicOrigin: "https://h.example", bootstrapSecret: "b".repeat(40) }, "UTC");
      expect(JSON.stringify(env)).not.toContain("CANARY");
      expect([...Object.keys(env), ...HOME_SERVER_ENV_KEYS, ...HOME_SERVER_OPTIONAL_ENV_KEYS].filter(k => /EMAIL/i.test(k))).toEqual([]);
    } finally { h.done(); }
  });
  it("4b. an envelope with emailSecrets parses and the server store loads it; no env var is read; tokens by fingerprint only", () => {
    const record = { storeId: "c".repeat(32), gen: 3, ownerRev: 2, owner: full.owner, doc: stripOwner(full) };
    const parsed = parseServerSecrets(JSON.stringify({ version: 1, bootstrapSecret: "b".repeat(40), credentials: {}, emailStore: 1, emailSecrets: record }));
    expect(cloudEmailBackend(parsed)).toBe("ack");
    const store = new EmailSecretStore();
    store.attachCloud(parsed.emailSecrets!);
    expect(store.storeId()).toBe("c".repeat(32)); expect(store.cloudGen()).toBe(3);
    expect(store.botKey("b1")).toMatchObject({ token: TOKEN_BOT, keyId: "key_b1", label: "bot-email:b1" });
    expect(store.owner()?.keyId).toBe("key_owner");
    expect(store.fingerprints().sort()).toEqual([TOKEN_BOT, TOKEN_OWNER, "bot-token-CANARY-3333"].map(credentialFingerprint).sort());
    const index = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    expect(index).toMatch(/if \(cloudEmailStore\) \{[^}]*delete process\.env\[EMAIL_SECRETS_ENV\][^}]*\} else emailRuntime\.secrets\.loadFromEnv\(\)/s);
  });
  it("a malformed emailSecrets drops the email fields only and the home still boots; a field without emailStore: 1 is dropped", () => {
    const base = { version: 1, bootstrapSecret: "b".repeat(40), credentials: { fluxApiKey: "k" } };
    const good = { storeId: "c".repeat(32), gen: 0, ownerRev: 0, doc: { bots: {} } };
    for (const bad of [{ ...good, storeId: "short" }, { ...good, gen: -1 }, { ...good, gen: 1.5 }, { ...good, ownerRev: "1" }, { ...good, doc: [] }, "x", null]) {
      const parsed = parseServerSecrets(JSON.stringify({ ...base, emailStore: 1, emailSecrets: bad }));
      expect(parsed.emailStore).toBeUndefined(); expect(parsed.emailSecrets).toBeUndefined(); expect(parsed.credentials.fluxApiKey).toBe("k");
      expect(cloudEmailBackend(parsed)).toBe("none");
    }
    expect(parseServerSecrets(JSON.stringify({ ...base, emailSecrets: good })).emailSecrets).toBeUndefined();
    expect(cloudEmailBackend(parseServerSecrets(JSON.stringify({ ...base, emailStore: 1 })))).toBe("none");
  });
  it("a write that would push the envelope past 768 KiB is refused with email_store_full and nothing is written", async () => {
    expect(EMAIL_ENVELOPE_LIMIT).toBe(786_432);
    const h = home(), send = vi.fn();
    try {
      const rec = h.seed(), before = h.store.getAll()[BOT_EMAIL_SECRETS_KEY];
      // many bots, each within the 4096-byte token cap, but under the 256 KiB doc bound so it is the envelope bound that refuses
      h.store.patch({ fluxApiKey: "x".repeat(0) });
      const filler = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`bot${i}`, { token: "t".repeat(3000), keyId: `key_${i}` }]));
      h.store.patch({ bigCredential: "z".repeat(EMAIL_ENVELOPE_LIMIT - 100_000) });
      await createSupervisorPort({ store: h.store, send, emailStore: true }).handle(save(1, 5, rec.gen, { bots: filler }));
      expect(sent(send, "murage:email-secrets-refused")[0]).toMatchObject({ reason: "email_store_full" });
      expect(h.store.getAll()[BOT_EMAIL_SECRETS_KEY]).toBe(before);
    } finally { h.done(); }
  });
});

describe("cloudBotEmail flag OFF is today's behaviour", () => {
  it("7. flag off: the supervisor refuses the save and the sign-in like any desktop message, and writes nothing", async () => {
    const h = home(), send = vi.fn(), patch = vi.spyOn(h.store, "patch"), durable = vi.spyOn(h.store, "patchDurable");
    try {
      const port = createSupervisorPort({ store: h.store, send });
      await port.handle(save());
      await port.handle({ type: "murage:email-owner-signin-start", requestId: "r", actor: { environmentId: "e1", deviceId: "d1" }, gen: 0 });
      expect(send.mock.calls.map(c => c[0])).toEqual([
        { type: "murage:cloud-refused", requestId: undefined, operation: "murage:email-secrets-save", error: cloudHomeCopy.thisDesktopOperationIsUnavailableOnThisCloudHome },
        { type: "murage:cloud-refused", requestId: "r", operation: "murage:email-owner-signin-start", error: cloudHomeCopy.thisDesktopOperationIsUnavailableOnThisCloudHome },
      ]);
      expect(patch).not.toHaveBeenCalled(); expect(durable).not.toHaveBeenCalled();
    } finally { h.done(); }
  });
  it("7b. flag off: no new boot field is sent, even with a record on disk; ON -> OFF leaves the record bytes unchanged", () => {
    const h = home();
    try {
      h.store.patch({ fluxApiKey: "k" }); h.seed();
      const bytes = h.store.getAll()[BOT_EMAIL_SECRETS_KEY];
      const session = createHomeSupervisorSession({ store: h.store, bootstrapSecret: "b".repeat(40) });
      expect(JSON.parse(session.envelope())).toEqual({ version: 1, bootstrapSecret: "b".repeat(40), credentials: { fluxApiKey: "k" } });
      expect(emailBootFields(h.store, false)).toEqual({});
      expect(h.store.getAll()[BOT_EMAIL_SECRETS_KEY]).toBe(bytes);
      session.close();
      expect(cloudBotEmailEnabled({})).toBe(false); expect(cloudBotEmailEnabled({ MURAGE_CLOUD_BOT_EMAIL: "1" })).toBe(true); expect(cloudBotEmailEnabled({ MURAGE_CLOUD_BOT_EMAIL: "true" })).toBe(false);
    } finally { h.done(); }
  });
  it("flag on with no record makes one durably (storeId, gen 0) and sends it; an unreadable record sends no email field", () => {
    const h = home();
    try {
      const fields = emailBootFields(h.store, true);
      expect(fields.emailStore).toBe(1);
      expect(fields.emailSecrets).toMatchObject({ v: 1, gen: 0, ownerRev: 0, doc: { bots: {} } });
      expect(fields.emailSecrets!.storeId).toMatch(/^[0-9a-f]{32}$/);
      expect(emailBootFields(h.store, true).emailSecrets!.storeId).toBe(fields.emailSecrets!.storeId);
      h.store.patch({ [BOT_EMAIL_SECRETS_KEY]: "{garbage" });
      expect(emailBootFields(h.store, true)).toEqual({});
    } finally { h.done(); }
  });
  it("the server saver counts revs, tags its epoch and gen, and counts only acks of its own epoch and gen", () => {
    const saver = createCloudEmailSaver(4, () => 42);
    expect(saver.saved()).toBe(true);
    expect(saver.message(full)).toMatchObject({ type: "murage:email-secrets-save", rev: 1, epoch: 42, gen: 4 });
    expect(saver.saved()).toBe(false);
    for (const bad of [{ rev: 1, epoch: 41, gen: 4 }, { rev: 1, epoch: 42, gen: 3 }]) { expect(saver.ack({ type: "murage:email-secrets-saved", keyIds: [], ...bad })).toBe(true); expect(saver.saved()).toBe(false); }
    expect(saver.ack({ type: "murage:email-secrets-saved", rev: 1, epoch: 42, gen: 4, keyIds: ["key_b1"] })).toBe(true);
    expect(saver.saved()).toBe(true);
  });
});
