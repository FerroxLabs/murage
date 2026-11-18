// SPDX-License-Identifier: AGPL-3.0-or-later
// Cloud token custody G2: every use of a home's disk key and every provider rescue / console / password action is audited before it
// proceeds, the owner is told in plain words, and a failed audit write stops the key from being unwrapped.
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCESS_EVENT_RETENTION_MS, BOOT_MATCH_WINDOW_MS, NOTICE_TEMPLATES, PROVIDER_ACCESS_COMMANDS, ROUTINE_LINE, accessNoticeText, sweepAccessNotices, sweepProviderAccess } from "../src/access-audit";
import { auditedKeyUse, recordAccessEvent, recordOwnProviderAction, type AccessKind } from "../src/access-events";
import type { HostingAdapter } from "../src/b5-provisioner";
import { PROVIDER_ACTION_UNEXPECTED_ALERT } from "../src/alert-tiers";
import { bindStepUpOp } from "../src/step-up-op";
import worker from "../src/index";
import shapes from "./fixtures/cp0-shapes.json";

const ADMIN = "test-only-cloud-admin-token-with-no-real-access";
const KEK = btoa("x".repeat(32));
const IP = "203.0.113.9";
const OWNER = "owner-g2";
const OWNER_EMAIL = "owner@example.test";
const SUB = "sub-owner-g2";
const HOUR = 3_600_000;
const testEnv = () => ({ ...env, CLOUD_ADMIN_TOKEN: ADMIN, CLOUD_KEK_V1: KEK, CLOUD_CP0_STAGING: "1", EMAIL_FROM: "murage@example.test" }) as unknown as Env;
async function call(path: string, body: unknown, token?: string, ip?: string) {
  const headers = new Headers({ "content-type": "application/json" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (ip) headers.set("CF-Connecting-IP", ip);
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://admin.murage.test${path}`, { method: "POST", headers, body: JSON.stringify(body) }), testEnv(), ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
async function enrolled(homeId = "home-g2", ip = IP) {
  const created = await call("/v1/machines", { ...shapes.createRequest, serverId: "server-1", boundIps: [ip], homeId }, ADMIN);
  expect(created.status).toBe(201);
  const machine = await created.json<typeof shapes.createResponse>();
  const response = await call(`/v1/machines/${homeId}/enroll`, { token: machine.enrollmentToken }, undefined, ip);
  expect(response.status).toBe(200);
  return response.json<typeof shapes.enrollResponse>();
}
const unwrap = (id: string, credential: string, ip = IP) => call(`/v1/machines/${id}/unwrap`, { generation: 1 }, credential, ip);
async function seedOwnerAndHome(homeId = "home-g2") {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified",image,"createdAt","updatedAt") VALUES (?,?,?,1,NULL,?,?)')
      .bind(OWNER, OWNER_EMAIL, `cloud-${OWNER}@cloud-account.invalid`, now, now),
    env.DB.prepare("INSERT INTO supabase_identities (sub,user_id,via,created_at,contact_email) VALUES (?,?,'created',?,?)").bind(SUB, OWNER, Date.now(), OWNER_EMAIL),
    env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,generation,created_at,updated_at)
      VALUES (?,?,?,'ready','ready','sha256:x','k',1,?,?)`).bind(homeId, "inst-g2", OWNER, Date.now(), Date.now()),
  ]);
}
const sent: { to: string; subject: string; text: string }[] = [];
const emailSender = () => ({ async send(m: { to: string; subject: string; text: string }) { sent.push({ to: m.to, subject: m.subject, text: m.text }); } });
const reader = { async emailGen(sub: string) { return { id: sub, email: OWNER_EMAIL, updatedAt: "2026-10-01T00:00:00Z" }; } };
const noticeDeps = { emailSender, reader } as never;
const breakAuditWrites = () => env.DB.exec("CREATE TRIGGER g2_no_audit BEFORE INSERT ON cloud_access_events BEGIN SELECT RAISE(ABORT, 'audit down'); END");
const fixAuditWrites = () => env.DB.exec("DROP TRIGGER IF EXISTS g2_no_audit");
type Row = Record<string, unknown>;
const events = async () => (await env.DB.prepare("SELECT * FROM cloud_access_events ORDER BY at, rowid").all<Row>()).results;

beforeEach(async () => {
  sent.length = 0;
  await fixAuditWrites();
  for (const t of ["cloud_access_events", "cloud_access_cursor", "cloud_unwrap_log", "cloud_alerts", "provision_choices", "cloud_enrollment_tokens", "cloud_home_keys",
    "cloud_home_jobs", "selfservice_audit", "cloud_resource_dispatch_calls", "warm_pool", "cloud_machines", "cloud_homes", "supabase_identities", "announcement_rate_limits"]) {
    try { await env.DB.prepare(`DELETE FROM ${t}`).run(); } catch { /* table absent in this schema */ }
  }
  await env.DB.prepare('DELETE FROM "user" WHERE id=?').bind(OWNER).run();
});
afterEach(async () => { await fixAuditWrites(); vi.restoreAllMocks(); });

describe("G2 audit entry for every disk-key unwrap", () => {
  it("an unwrap writes who, what, when, which home and why, and never the key", async () => {
    const machine = await enrolled();
    const before = Date.now();
    const response = await unwrap("home-g2", machine.machineCredential);
    expect(response.status).toBe(200);
    const keys = await response.json<{ volumeKey: string; dataKey: string; bootstrapSecret: string }>();
    const [row] = await events();
    expect(row).toMatchObject({ home_id: "home-g2", generation: 1, kind: "disk_key_unlock", actor: "home", source_ip: IP, outcome: "ok", notice_state: "pending" });
    expect(Number(row.at)).toBeGreaterThanOrEqual(before);
    expect(String(row.reason).length).toBeGreaterThan(10);
    const dump = JSON.stringify(row);
    for (const secret of [keys.volumeKey, keys.dataKey, keys.bootstrapSecret]) expect(dump).not.toContain(secret);
  });

  it("a refused unwrap (wrong credential, wrong IP) writes no audit entry", async () => {
    const machine = await enrolled();
    expect((await unwrap("home-g2", "wrong")).status).toBe(401);
    expect((await call("/v1/machines/home-g2/unwrap", { generation: 1 }, machine.machineCredential, "203.0.113.8")).status).toBe(403);
    expect(await events()).toEqual([]);
  });

  it("the operator backup-password route audits an operator action", async () => {
    await enrolled();
    const response = await call("/v1/machines/home-g2/backup-password", {}, ADMIN);
    expect(response.status).toBe(200);
    expect(await events()).toMatchObject([{ home_id: "home-g2", kind: "backup_key_use", actor: "operator", outcome: "ok" }]);
  });
});

const DAY = 24 * HOUR;
/** A start the control plane recorded for the home: a customer or watchdog power action. */
const powerJob = (homeId: string, createdAt: number, state = "done", id = crypto.randomUUID()) =>
  env.DB.prepare("INSERT INTO cloud_home_jobs (id,home_id,kind,ref,generation,state,created_at) VALUES (?,?,'power','start',1,?,?)").bind(id, homeId, state, createdAt).run();
const serverCreate = (homeId: string, at: number, outcome = "created") =>
  env.DB.prepare("INSERT INTO cloud_resource_dispatch_calls (id,home_id,resource_generation,role,dispatched_at,deadline_at,outcome) VALUES (?,?,1,'server',?,?,?)")
    .bind(crypto.randomUUID(), homeId, at, at + 60_000, outcome).run();

/** A warm-pool server claimed for the home: it powers on an existing server, so no power job and no server create exist. */
const poolClaim = (homeId: string, at: number) =>
  env.DB.prepare(`INSERT INTO warm_pool (id,env,class,provider,server_type,arch,location,image_id,image_digest,state,server_id,create_call_id,monthly_cents,vcpus,created_at,claimed_at,home_id,resource_generation)
    VALUES (?,'staging','starter','hetzner','cx23','x86','fsn1','img','sha256:x','claimed','srv-pool',?,400,2,?,?,?,1)`).bind(crypto.randomUUID(), crypto.randomUUID(), at - HOUR, at, homeId).run();

describe("first start of a warm-pool home", () => {
  it("an unlock right after the home's pool claim sends no email, and the audit row stays", async () => {
    const IPX = "203.0.113.40";
    const machine = await enrolled("home-g2", IPX);
    await seedOwnerAndHome();
    await poolClaim("home-g2", Date.now() - 150_000);
    await unwrap("home-g2", machine.machineCredential, IPX);
    expect(await sweepAccessNotices(testEnv(), Date.now(), noticeDeps)).toBe(0);
    expect(sent).toHaveLength(0);
    expect((await events())[0]).toMatchObject({ kind: "disk_key_unlock", notice_state: "first_start" });
  });
  it("the rest of a new home's setup sends no email either: setup token, backup key, first start and the owner's first device", async () => {
    await seedOwnerAndHome();
    const now = Date.now();
    await serverCreate("home-g2", now - 200_000);
    await env.DB.prepare("UPDATE cloud_homes SET ready_at=? WHERE id='home-g2'").bind(now - 60_000).run();
    await recordAccessEvent(env.DB, { homeId: "home-g2", kind: "provision_token_use", actor: "system", reason: "setup", outcome: "ok", at: now - 190_000 });
    await recordAccessEvent(env.DB, { homeId: "home-g2", kind: "backup_key_use", actor: "system", reason: "setup", outcome: "ok", at: now - 189_000 });
    await recordAccessEvent(env.DB, { homeId: "home-g2", kind: "disk_key_unlock", actor: "home", reason: "boot", outcome: "ok", at: now - 150_000 });
    await recordAccessEvent(env.DB, { homeId: "home-g2", kind: "pairing_key_use", actor: "owner", reason: "device", outcome: "ok", at: now - 10_000 });
    expect(await sweepAccessNotices(testEnv(), now, noticeDeps)).toBe(0);
    expect(sent).toHaveLength(0);
    expect((await events()).map((e) => e.notice_state)).toEqual(["first_start", "first_start", "first_start", "first_start"]);
  });
  it("after setup the owner still hears: an operator's backup key use, a second device and a replacement server's unlock", async () => {
    await seedOwnerAndHome();
    const now = Date.now();
    await serverCreate("home-g2", now - 200_000);
    await env.DB.prepare("UPDATE cloud_homes SET ready_at=? WHERE id='home-g2'").bind(now - 2 * DAY).run();
    await recordAccessEvent(env.DB, { homeId: "home-g2", kind: "backup_key_use", actor: "operator", reason: "asked", outcome: "ok", at: now - 190_000 });
    await recordAccessEvent(env.DB, { homeId: "home-g2", kind: "disk_key_unlock", actor: "home", reason: "boot", outcome: "ok", at: now - 150_000 });
    await recordAccessEvent(env.DB, { homeId: "home-g2", kind: "pairing_key_use", actor: "owner", reason: "device", outcome: "ok", at: now - 10_000 });
    expect(await sweepAccessNotices(testEnv(), now, noticeDeps)).toBe(1);
    expect(sent[0].subject).toBe("Murage Cloud: your home's disk key was used");
    expect((await events()).map((e) => e.notice_state)).toEqual(["sent", "sent", "sent"]);
  });
  it("an unlock with no boot and no claim still sends the disk-key email", async () => {
    const IPX = "203.0.113.41";
    const machine = await enrolled("home-g2", IPX);
    await seedOwnerAndHome();
    await unwrap("home-g2", machine.machineCredential, IPX);
    expect(await sweepAccessNotices(testEnv(), Date.now(), noticeDeps)).toBe(1);
    expect(sent[0].subject).toBe("Murage Cloud: your home's disk key was used");
  });
  it("an unlock long after the claim still sends the disk-key email", async () => {
    const IPX = "203.0.113.42";
    const machine = await enrolled("home-g2", IPX);
    await seedOwnerAndHome();
    await poolClaim("home-g2", Date.now() - BOOT_MATCH_WINDOW_MS - 5 * 60_000);
    await unwrap("home-g2", machine.machineCredential, IPX);
    expect(await sweepAccessNotices(testEnv(), Date.now(), noticeDeps)).toBe(1);
    expect(sent[0].subject).toBe("Murage Cloud: your home's disk key was used");
  });
  it("a claim for a different home does not explain this home's unlock", async () => {
    const IPX = "203.0.113.43";
    const machine = await enrolled("home-g2", IPX);
    await seedOwnerAndHome();
    await poolClaim("other-home", Date.now() - 60_000);
    await unwrap("home-g2", machine.machineCredential, IPX);
    expect(await sweepAccessNotices(testEnv(), Date.now(), noticeDeps)).toBe(1);
    expect(sent[0].subject).toBe("Murage Cloud: your home's disk key was used");
  });
});

describe("G2 the owner is told in plain words", () => {
  it("an unlock with no boot of that home is told at once: what, who, when (UTC, labelled) and what to do", async () => {
    const machine = await enrolled();
    await seedOwnerAndHome();
    await unwrap("home-g2", machine.machineCredential);
    expect(await sweepAccessNotices(testEnv(), Date.now(), noticeDeps)).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(OWNER_EMAIL);
    expect(sent[0].subject).toBe("Murage Cloud: your home's disk key was used");
    expect(sent[0].text).toContain("Your home's disk was unlocked, and we did not see your home start just before.");
    expect(sent[0].text).toContain("Done by your home's own server, as far as we know.");
    expect(sent[0].text).toMatch(/ UTC: /);
    expect(sent[0].text).toContain("If you didn't expect this, reply to this email and we'll look into it.");
    expect(sent[0].text).not.toContain(ROUTINE_LINE);
    expect((await events())[0]).toMatchObject({ notice_state: "sent" });
    expect(await sweepAccessNotices(testEnv(), Date.now(), noticeDeps)).toBe(0);
  });

  it("an unlock right after the home's own start is routine: one daily digest with the exact line", async () => {
    const machine = await enrolled();
    await seedOwnerAndHome();
    await powerJob("home-g2", Date.now() - 30_000);
    await unwrap("home-g2", machine.machineCredential);
    expect(await sweepAccessNotices(testEnv(), Date.now(), noticeDeps)).toBe(1);
    expect(sent[0].subject).toBe("Murage Cloud: your home started");
    expect(sent[0].text.trim()).toBe("Your home unlocked its disk when it started. This happens every time it starts.");
    // The next routine unlock waits for the day; an hour later is still too early.
    await powerJob("home-g2", Date.now() - 10_000);
    await unwrap("home-g2", machine.machineCredential);
    expect(await sweepAccessNotices(testEnv(), Date.now() + HOUR + 60_000, noticeDeps)).toBe(0);
    expect(await sweepAccessNotices(testEnv(), Date.now() + DAY + 60_000, noticeDeps)).toBe(1);
    expect(sent).toHaveLength(2);
  });

  it("a replacement server (created after the home was first ready) makes its unlock routine", async () => {
    const machine = await enrolled();
    await seedOwnerAndHome();
    await env.DB.prepare("UPDATE cloud_homes SET ready_at=? WHERE id='home-g2'").bind(Date.now() - 2 * DAY).run();
    await serverCreate("home-g2", Date.now() - 120_000);
    await unwrap("home-g2", machine.machineCredential);
    await sweepAccessNotices(testEnv(), Date.now(), noticeDeps);
    expect(sent[0].text.trim()).toBe(ROUTINE_LINE);
  });

  it("the boot match is the named window, for the same home only, and a failed start does not count", async () => {
    expect(BOOT_MATCH_WINDOW_MS).toBe(10 * 60_000);
    const machine = await enrolled();
    await seedOwnerAndHome();
    const tooOld = Date.now() - BOOT_MATCH_WINDOW_MS - 30_000;
    await powerJob("home-g2", tooOld);
    await powerJob("other-home", Date.now() - 1000);
    await powerJob("home-g2", Date.now() - 1000, "failed");
    // A power job whose provider answer is still uncertain is not a boot we know ran.
    await powerJob("home-g2", Date.now() - 1000, "active");
    await env.DB.prepare("UPDATE cloud_home_jobs SET outcome='uncertain' WHERE state='active'").run();
    await serverCreate("home-g2", Date.now() - 1000, "failed");
    await unwrap("home-g2", machine.machineCredential);
    await sweepAccessNotices(testEnv(), Date.now(), noticeDeps);
    expect(sent[0].text).toContain("we did not see your home start just before");
    expect(sent[0].text).not.toContain(ROUTINE_LINE);
  });

  it("an uncertain power job counts as a boot when the provider gave an action id, and not when it never reached the provider", async () => {
    const machine = await enrolled("home-g2", "198.51.100.71");
    await seedOwnerAndHome();
    const withAction = crypto.randomUUID();
    await powerJob("home-g2", Date.now() - 1000, "active", withAction);
    await env.DB.prepare("UPDATE cloud_home_jobs SET outcome='uncertain', action_id='act-1' WHERE id=?").bind(withAction).run();
    await unwrap("home-g2", machine.machineCredential, "198.51.100.71");
    await sweepAccessNotices(testEnv(), Date.now(), noticeDeps);
    expect(sent[0].text.trim()).toBe(ROUTINE_LINE);
  });

  it("an uncertain power job with no action id is not a boot we know ran, so the unlock is alerted", async () => {
    const machine = await enrolled("home-g2", "198.51.100.72");
    await seedOwnerAndHome();
    const noAction = crypto.randomUUID();
    await powerJob("home-g2", Date.now() - 1000, "active", noAction);
    await env.DB.prepare("UPDATE cloud_home_jobs SET outcome='uncertain' WHERE id=?").bind(noAction).run();
    await unwrap("home-g2", machine.machineCredential, "198.51.100.72");
    await sweepAccessNotices(testEnv(), Date.now(), noticeDeps);
    expect(sent[0].text).toContain("we did not see your home start just before");
  });

  it("a restart the owner did themselves says so; our own work keeps the routine wording", () => {
    const at = Date.UTC(2026, 9, 22, 12, 0, 0);
    const mine = accessNoticeText([{ kind: "provider_power", actor: "owner", at, outcome: "ok", routine: true }]);
    expect(mine.text).toContain(": You restarted your home.");
    expect(mine.text).not.toContain("as part of routine work");
    expect(mine.text).not.toMatch(/\u2014|\u2013|safe|safety/i);
    const ours = accessNoticeText([{ kind: "provider_power", actor: "system", at, outcome: "ok", routine: true }]);
    expect(ours.text).toContain(NOTICE_TEMPLATES.ROUTINE_WORDS.provider_power!);
    expect(ours.text).not.toContain("You restarted your home.");
  });

  it("an audited key use inside a claimed step-up operation writes its entry on the raw binding, not the journaled one", async () => {
    await seedOwnerAndHome();
    const journaled = new Proxy(env.DB, { get(t, k) { if (k === "prepare" || k === "batch") throw new Error("journaled_binding_used"); const v = (t as any)[k]; return typeof v === "function" ? v.bind(t) : v; } }) as unknown as D1Database;
    bindStepUpOp(journaled, { intentId: "intent-g2", token: "tok", lease: { kind: "billing", homeId: "home-g2", holder: "h", generation: 1 } as any, db: env.DB });
    const out = await auditedKeyUse(journaled, { homeId: "home-g2", generation: 1, kind: "export_key_use", actor: "owner", reason: "test" }, async () => 7);
    expect(out).toBe(7);
    expect((await events()).map((r) => `${r.kind}:${r.outcome}`)).toEqual(["export_key_use:ok"]);
    await expect(recordAccessEvent(journaled, { homeId: "home-g2", kind: "key_reseal", actor: "system", reason: "t" })).resolves.toBeTruthy();
  });

  it("a routine unlock does not hold back an immediate one: both go out together, the routine line once", () => {
    const at = Date.UTC(2026, 9, 22, 12, 0, 0);
    const { text } = accessNoticeText([{ kind: "disk_key_unlock", actor: "home", at, outcome: "ok", routine: true },
      { kind: "backup_key_use", actor: "operator", at, outcome: "ok" }]);
    expect(text).toContain("The key for your home's backups was used. Done by Murage support, as far as we know.");
    expect(text.split(ROUTINE_LINE)).toHaveLength(2);
  });

  it("backup-password use is told at once, even right after a start", async () => {
    await enrolled();
    await seedOwnerAndHome();
    await powerJob("home-g2", Date.now() - 1000);
    expect((await call("/v1/machines/home-g2/backup-password", {}, ADMIN)).status).toBe(200);
    expect(await sweepAccessNotices(testEnv(), Date.now(), noticeDeps)).toBe(1);
    expect(sent[0].text).toContain("The key for your home's backups was used.");
    expect(sent[0].text).toContain("Done by Murage support, as far as we know.");
  });

  it("a failed send is retried with backoff and the notice stays owed", async () => {
    const machine = await enrolled();
    await seedOwnerAndHome();
    await unwrap("home-g2", machine.machineCredential);
    const failing = { emailSender: () => ({ async send() { throw new Error("provider down"); } }), reader } as never;
    expect(await sweepAccessNotices(testEnv(), Date.now(), failing)).toBe(0);
    expect((await events())[0]).toMatchObject({ notice_state: "pending", notice_attempts: 1 });
    expect(await sweepAccessNotices(testEnv(), Date.now() + 24 * HOUR, noticeDeps)).toBe(1);
  });

  it("a home with no owner row is marked, not emailed", async () => {
    const machine = await enrolled();
    await unwrap("home-g2", machine.machineCredential);
    expect(await sweepAccessNotices(testEnv(), Date.now(), noticeDeps)).toBe(0);
    expect((await events())[0]).toMatchObject({ notice_state: "no_owner" });
  });

  it("the words for each kind are plain", () => {
    const base = { actor: "provider_account", at: Date.UTC(2026, 9, 22, 12, 0, 0), outcome: "seen" };
    const { subject, text } = accessNoticeText([{ ...base, kind: "provider_rescue" }, { ...base, kind: "provider_console" }, { ...base, kind: "provider_password_reset" }]);
    expect(subject).toBe("Murage Cloud: someone worked on your home's server");
    expect(text).toContain("Rescue mode, or a different start-up disk, was switched on");
    expect(text).toContain("A console was opened on your home's server");
    expect(text).toContain("administrator password of your home's server was reset");
    expect(text).toContain("Done by your hosting provider's account, as far as we know.");
    expect(text).toContain("Thu, 22 Oct 2026 12:00:00 UTC");
    expect(text).toContain("If you didn't expect this, reply to this email and we'll look into it.");
  });

  it("no notice template has an em dash, or the words safe, unsafe or safety, or 'given out'", () => {
    const kinds = Object.keys(NOTICE_TEMPLATES.EVENT_WORDS) as AccessKind[];
    const actors = Object.keys(NOTICE_TEMPLATES.ACTOR_WORDS);
    const outcomes = Object.keys(NOTICE_TEMPLATES.OUTCOME_WORDS);
    const at = Date.UTC(2026, 9, 22, 12, 0, 0);
    const rendered: string[] = [];
    for (const kind of kinds) for (const actor of actors) for (const outcome of outcomes) {
      for (const routine of [false, true]) {
        const n = accessNoticeText([{ kind, actor, at, outcome, routine }, { kind: "disk_key_unlock", actor: "home", at, outcome: "ok", routine: true }]);
        rendered.push(n.subject, n.text);
      }
    }
    const raw = [...Object.values(NOTICE_TEMPLATES.EVENT_WORDS), ...Object.values(NOTICE_TEMPLATES.ROUTINE_WORDS), ...Object.values(NOTICE_TEMPLATES.ACTOR_WORDS), ...Object.values(NOTICE_TEMPLATES.OUTCOME_WORDS),
      NOTICE_TEMPLATES.ROUTINE_LINE, NOTICE_TEMPLATES.ACTION_LINE, NOTICE_TEMPLATES.INTRO];
    expect(rendered.length).toBeGreaterThan(100);
    for (const text of [...raw, ...rendered]) {
      expect(text).not.toMatch(/\u2014|\u2013/);
      expect(text).not.toMatch(/safe|safety/i);
      expect(text).not.toMatch(/given out/i);
    }
  });
});

describe("G2 fails closed", () => {
  it("when the audit write fails the disk key is not unwrapped and not returned", async () => {
    const machine = await enrolled();
    await breakAuditWrites();
    const decrypt = vi.spyOn(crypto.subtle, "decrypt");
    const response = await unwrap("home-g2", machine.machineCredential);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "audit_unavailable" });
    expect(decrypt).not.toHaveBeenCalled();
    await fixAuditWrites();
    expect(await events()).toEqual([]);
    expect((await unwrap("home-g2", machine.machineCredential)).status).toBe(200);
  });

  it("when the audit write fails the operator backup password is not derived", async () => {
    await enrolled();
    await breakAuditWrites();
    const response = await call("/v1/machines/home-g2/backup-password", {}, ADMIN);
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("password");
  });

  it("recordAccessEvent throws audit_unavailable", async () => {
    await breakAuditWrites();
    await expect(recordAccessEvent(env.DB, { homeId: "h", kind: "disk_key_unlock", actor: "home", reason: "test" })).rejects.toMatchObject({ status: 503 });
  });
});

describe("G2 provider rescue, console and password actions", () => {
  // Actions are dated after the machine is made, whenever in the run that is.
  let T = 0;
  beforeEach(() => { T = Date.now() + 60_000; });
  const hetzner = (actions: { id: string; command: string; startedAt: number }[]) =>
    ({ provider: "hetzner", listProviderActions: vi.fn(async () => actions) }) as unknown as HostingAdapter;
  const actions = () => [
    { id: "81", command: "request_console", startedAt: T },
    { id: "80", command: "enable_rescue", startedAt: T },
    { id: "79", command: "poweron", startedAt: T },
    { id: "78", command: "reset_password", startedAt: T },
  ];

  it("each rescue, console and password action is audited once and the owner is told at once", async () => {
    await enrolled();
    await seedOwnerAndHome();
    const adapter = hetzner(actions());
    expect(await sweepProviderAccess(testEnv(), T + 1000, { adapters: { hetzner: adapter } })).toBe(3);
    expect(adapter.listProviderActions).toHaveBeenCalledWith("server-1", expect.any(Number));
    const rows = await events();
    expect(rows.map((r) => r.kind).sort()).toEqual(["provider_console", "provider_password_reset", "provider_rescue"]);
    expect(rows.every((r) => r.actor === "provider_account" && r.home_id === "home-g2" && r.generation === 1 && r.outcome === "seen")).toBe(true);
    // Read again later: the same provider actions are not entered twice.
    expect(await sweepProviderAccess(testEnv(), T + 2 * HOUR, { adapters: { hetzner: adapter } })).toBe(0);
    expect(await events()).toHaveLength(3);
    expect(await sweepAccessNotices(testEnv(), T + 3000, noticeDeps)).toBe(1);
    expect(sent[0].subject).toBe("Murage Cloud: someone worked on your home's server");
    expect(sent[0].text).toContain("Done by your hosting provider's account, as far as we know.");
  });

  it("an audit write that fails is not marked as read: the next sweep enters it", async () => {
    await enrolled();
    await seedOwnerAndHome();
    const adapter = hetzner(actions());
    await breakAuditWrites();
    expect(await sweepProviderAccess(testEnv(), T + 1000, { adapters: { hetzner: adapter } })).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_access_cursor").first<{ n: number }>()).toEqual({ n: 0 });
    await fixAuditWrites();
    expect(await sweepProviderAccess(testEnv(), T + 2000, { adapters: { hetzner: adapter } })).toBe(3);
  });

  it("an alert insert that fails once loses neither the entry nor the page: the next sweep raises it exactly once", async () => {
    await enrolled();
    await seedOwnerAndHome();
    const adapter = hetzner([{ id: "80", command: "enable_rescue", startedAt: T }]);
    await env.DB.exec("CREATE TRIGGER g2_no_alert BEFORE INSERT ON cloud_alerts BEGIN SELECT RAISE(ABORT, 'alert down'); END");
    try {
      expect(await sweepProviderAccess(testEnv(), T + 1000, { adapters: { hetzner: adapter } })).toBe(0);
    } finally { await env.DB.exec("DROP TRIGGER IF EXISTS g2_no_alert"); }
    expect(await events()).toHaveLength(0);
    expect(await sweepProviderAccess(testEnv(), T + 2000, { adapters: { hetzner: adapter } })).toBe(1);
    expect(await sweepProviderAccess(testEnv(), T + 2 * HOUR, { adapters: { hetzner: adapter } })).toBe(0);
    expect(await events()).toHaveLength(1);
    const rows = await env.DB.prepare("SELECT kind FROM cloud_alerts WHERE home_id='home-g2'").all<{ kind: string }>();
    expect(rows.results.map((r) => r.kind)).toEqual([PROVIDER_ACTION_UNEXPECTED_ALERT]);
  });

  it("a second rescue, console or password action while the first page is open gets its own open alert", async () => {
    await enrolled("home-g2", "203.0.113.77");
    await seedOwnerAndHome();
    const adapter = hetzner([{ id: "80", command: "enable_rescue", startedAt: T }]);
    expect(await sweepProviderAccess(testEnv(), T + 1000, { adapters: { hetzner: adapter } })).toBe(1);
    const second = hetzner([{ id: "80", command: "enable_rescue", startedAt: T }, { id: "81", command: "request_console", startedAt: T + 10 }, { id: "78", command: "reset_password", startedAt: T + 20 }]);
    expect(await sweepProviderAccess(testEnv(), T + 2 * HOUR, { adapters: { hetzner: second } })).toBe(2);
    const open = await env.DB.prepare("SELECT subject FROM cloud_alerts WHERE home_id='home-g2' AND kind=? AND resolved_at IS NULL ORDER BY subject")
      .bind(PROVIDER_ACTION_UNEXPECTED_ALERT).all<{ subject: string }>();
    expect(open.results.map((r) => r.subject)).toEqual(["78", "80", "81"]);
    expect(await events()).toHaveLength(3);
  });

  it("a Vultr home, which has no action history, raises an ops alert instead of a silent gap", async () => {
    await enrolled();
    await seedOwnerAndHome();
    await env.DB.prepare(`INSERT INTO provision_choices (home_id,resource_generation,provider,server_type,location,arch,image,tried,created_at) VALUES ('home-g2',1,'vultr','x','y','x86','img','[]',0)`).run();
    await sweepProviderAccess(testEnv(), T, { adapters: { hetzner: hetzner([]) } });
    const alert = await env.DB.prepare("SELECT kind FROM cloud_alerts WHERE home_id='home-g2'").first<{ kind: string }>();
    expect(alert?.kind).toBe("access.unmonitored");
  });

  it("a Vultr home's owner is told once, in plain words, that provider-side actions are not tracked there", async () => {
    await enrolled();
    await seedOwnerAndHome();
    await env.DB.prepare(`INSERT INTO provision_choices (home_id,resource_generation,provider,server_type,location,arch,image,tried,created_at) VALUES ('home-g2',1,'vultr','x','y','x86','img','[]',0)`).run();
    const adapters = { adapters: { hetzner: hetzner([]) } };
    await sweepProviderAccess(testEnv(), T, adapters);
    expect(await events()).toMatchObject([{ id: "untracked:home-g2", kind: "provider_untracked", notice_state: "pending" }]);
    expect(await sweepAccessNotices(testEnv(), T + 1000, noticeDeps)).toBe(1);
    expect(sent[0].subject).toBe("Murage Cloud: a note about where your home runs");
    expect(sent[0].text).toContain("keeps no record of actions taken on the server from the provider's side");
    expect(sent[0].text).toContain("If you didn't expect this, reply to this email and we'll look into it.");
    // Read again later, and past the usual retention: no second notice (the event is the dedupe flag).
    await sweepProviderAccess(testEnv(), T + 2 * HOUR, adapters);
    await sweepProviderAccess(testEnv(), T + ACCESS_EVENT_RETENTION_MS + DAY, adapters);
    await sweepAccessNotices(testEnv(), T + ACCESS_EVENT_RETENTION_MS + DAY, noticeDeps);
    expect(await events()).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });
});

describe("G2 the other key uses are audited before the key service is called", () => {
  it("auditedKeyUse writes the entry first, closes it ok, and a failed use is closed failed", async () => {
    const seen: string[] = [];
    const out = await auditedKeyUse(env.DB, { homeId: "home-g2", generation: 1, kind: "pairing_key_use", actor: "owner", reason: "test" }, async () => {
      seen.push(String((await events()).map((r) => `${r.kind}:${r.outcome}`)));
      return 7;
    });
    expect(out).toBe(7);
    expect(seen).toEqual(["pairing_key_use:requested"]);
    await expect(auditedKeyUse(env.DB, { homeId: "home-g2", generation: 1, kind: "export_key_use", actor: "owner", reason: "test" }, async () => { throw new Error("kms down"); }))
      .rejects.toThrow("kms down");
    expect((await events()).map((r) => `${r.kind}:${r.actor}:${r.outcome}`)).toEqual(["pairing_key_use:owner:ok", "export_key_use:owner:failed"]);
  });

  it("when the audit write fails the key service is never called, for each of the three uses", async () => {
    await breakAuditWrites();
    const use = vi.fn(async () => 1);
    for (const [kind, actor] of [["pairing_key_use", "owner"], ["export_key_use", "owner"], ["provision_token_use", "system"]] as const) {
      await expect(auditedKeyUse(env.DB, { homeId: "home-g2", generation: 1, kind, actor, reason: "test" }, use)).rejects.toMatchObject({ status: 503 });
    }
    expect(use).not.toHaveBeenCalled();
  });

  it("pairing, export and provision-token uses are routine: one digest, each in its own plain words", async () => {
    await enrolled();
    await seedOwnerAndHome();
    for (const [kind, actor] of [["pairing_key_use", "owner"], ["export_key_use", "owner"], ["provision_token_use", "system"]] as const) {
      await auditedKeyUse(env.DB, { homeId: "home-g2", generation: 1, kind, actor, reason: "test" }, async () => 1);
    }
    expect(await sweepAccessNotices(testEnv(), Date.now(), noticeDeps)).toBe(1);
    expect(sent[0].subject).toBe("Murage Cloud: your home's keys were used");
    expect(sent[0].text).toContain(NOTICE_TEMPLATES.EVENT_WORDS.pairing_key_use);
    expect(sent[0].text).toContain(NOTICE_TEMPLATES.EVENT_WORDS.export_key_use);
    expect(sent[0].text).toContain(NOTICE_TEMPLATES.EVENT_WORDS.provision_token_use);
    expect(sent[0].text).not.toContain(ROUTINE_LINE);
    // A second routine use the same day waits for the next digest.
    await auditedKeyUse(env.DB, { homeId: "home-g2", generation: 1, kind: "pairing_key_use", actor: "owner", reason: "test" }, async () => 1);
    expect(await sweepAccessNotices(testEnv(), Date.now() + HOUR, noticeDeps)).toBe(0);
    expect(await sweepAccessNotices(testEnv(), Date.now() + DAY + 60_000, noticeDeps)).toBe(1);
  });

  it("a routine pairing use does not hold back an immediate event", () => {
    const at = Date.UTC(2026, 9, 22, 12, 0, 0);
    const { text } = accessNoticeText([{ kind: "pairing_key_use", actor: "owner", at, outcome: "ok", routine: true },
      { kind: "provider_rescue", actor: "provider_account", at, outcome: "seen" }]);
    expect(text).toContain(NOTICE_TEMPLATES.EVENT_WORDS.provider_rescue);
  });

  it("our own routine actions each get their own plain line and never the keys subject; only real key uses say the keys were used", () => {
    const at = Date.UTC(2026, 9, 22, 12, 0, 0);
    expect(NOTICE_TEMPLATES.ROUTINE_WORDS.provider_snapshot).toBe("We made a routine backup copy of your home.");
    expect(NOTICE_TEMPLATES.ROUTINE_WORDS.plan_change_power).toBe("We restarted your home as part of a plan change.");
    const own: AccessKind[] = ["provider_snapshot", "provider_backup", "provider_rebuild", "plan_change_power", "provider_power"];
    for (const kind of own) {
      const n = accessNoticeText([{ kind, actor: "system", at, outcome: "ok", routine: true }]);
      expect(n.subject).toBe("Murage Cloud: routine work on your home");
      expect(n.text).toContain(`: ${NOTICE_TEMPLATES.ROUTINE_WORDS[kind]}`);
      expect(n.text).not.toMatch(/keys were used|key was used/i);
    }
    const lines = new Set(own.map((k) => NOTICE_TEMPLATES.ROUTINE_WORDS[k]));
    expect(lines.size).toBe(own.length);
    for (const kind of ["pairing_key_use", "export_key_use", "provision_token_use"] as AccessKind[]) {
      expect(accessNoticeText([{ kind, actor: "owner", at, outcome: "ok", routine: true }]).subject).toBe("Murage Cloud: your home's keys were used");
    }
    // A snapshot and a restart of one plan change are two lines, once each, and the subject stays plain.
    const both = accessNoticeText([{ kind: "provider_snapshot", actor: "system", at, outcome: "ok", routine: true },
      { kind: "plan_change_power", actor: "system", at, outcome: "ok", routine: true }, { kind: "plan_change_power", actor: "system", at: at + 1, outcome: "ok", routine: true }]);
    expect(both.text.match(/We restarted your home as part of a plan change\./g)?.length).toBe(1);
    expect(both.text).toContain("We made a routine backup copy of your home.");
  });

  it("the new kinds render under the house rules, for every actor and outcome", () => {
    const at = Date.UTC(2026, 9, 22, 12, 0, 0);
    const fresh: AccessKind[] = ["provider_snapshot", "provider_backup", "provider_rebuild", "pairing_key_use", "export_key_use", "provision_token_use", "plan_change_power", "provider_power"];
    for (const kind of fresh) {
      expect(NOTICE_TEMPLATES.EVENT_WORDS[kind].length).toBeGreaterThan(20);
      for (const actor of Object.keys(NOTICE_TEMPLATES.ACTOR_WORDS)) for (const outcome of Object.keys(NOTICE_TEMPLATES.OUTCOME_WORDS)) for (const routine of [false, true]) {
        const n = accessNoticeText([{ kind, actor, at, outcome, routine }]);
        for (const text of [n.subject, n.text]) {
          expect(text).not.toMatch(/\u2014|\u2013/);
          expect(text).not.toMatch(/safe|safety/i);
        }
      }
    }
  });
});

describe("G2 a watchdog start never makes an unlock routine", () => {
  it("a power job whose intent was written by the watchdog does not count; the owner's does", async () => {
    const machine = await enrolled();
    await seedOwnerAndHome();
    const jobId = crypto.randomUUID();
    await powerJob("home-g2", Date.now() - 30_000, "done", jobId);
    await env.DB.prepare("INSERT INTO selfservice_audit (id,home_id,actor,account_id,action,outcome,detail,at) VALUES (?,?,?,?,?,?,?,?)")
      .bind(crypto.randomUUID(), "home-g2", "watchdog", null, "start", "intent", JSON.stringify({ reservation: jobId }), Date.now() - 30_000).run();
    await unwrap("home-g2", machine.machineCredential);
    await sweepAccessNotices(testEnv(), Date.now(), noticeDeps);
    expect(sent[0].text).toContain("we did not see your home start just before");
    expect(sent[0].text).not.toContain(ROUTINE_LINE);
  });
  it("an owner's power job (audit actor customer) still makes the unlock routine", async () => {
    const machine = await enrolled();
    await seedOwnerAndHome();
    const jobId = crypto.randomUUID();
    await powerJob("home-g2", Date.now() - 30_000, "done", jobId);
    await env.DB.prepare("INSERT INTO selfservice_audit (id,home_id,actor,account_id,action,outcome,detail,at) VALUES (?,?,?,?,?,?,?,?)")
      .bind(crypto.randomUUID(), "home-g2", "customer", OWNER, "start", "intent", JSON.stringify({ reservation: jobId }), Date.now() - 30_000).run();
    await unwrap("home-g2", machine.machineCredential);
    await sweepAccessNotices(testEnv(), Date.now(), noticeDeps);
    expect(sent[0].text.trim()).toBe(ROUTINE_LINE);
  });
});

describe("G2 the provider sweep reads everything, alerts on what it cannot read, and covers suspended homes", () => {
  let T = 0;
  beforeEach(() => { T = Date.now() + 60_000; });
  const hz = (fn: (s: string, stopBefore?: number) => Promise<{ id: string; command: string; startedAt: number }[]>) =>
    ({ provider: "hetzner", listProviderActions: vi.fn(fn) }) as unknown as HostingAdapter;
  const alerts = async () => (await env.DB.prepare("SELECT kind FROM cloud_alerts WHERE home_id='home-g2'").all<{ kind: string }>()).results.map((r) => r.kind);

  it("snapshot, backup and rebuild actions are audited with their own words", async () => {
    expect(Object.keys(PROVIDER_ACCESS_COMMANDS)).toEqual(expect.arrayContaining(["create_image", "enable_backup", "rebuild_server"]));
    await enrolled();
    await seedOwnerAndHome();
    const adapter = hz(async () => [{ id: "91", command: "create_image", startedAt: T }, { id: "92", command: "enable_backup", startedAt: T }, { id: "93", command: "rebuild_server", startedAt: T }]);
    expect(await sweepProviderAccess(testEnv(), T + 1000, { adapters: { hetzner: adapter } })).toBe(3);
    expect((await events()).map((r) => r.kind).sort()).toEqual(["provider_backup", "provider_rebuild", "provider_snapshot"]);
    await sweepAccessNotices(testEnv(), T + 2000, noticeDeps);
    expect(sent[0].subject).toBe("Murage Cloud: someone worked on your home's server");
    expect(sent[0].text).toContain(NOTICE_TEMPLATES.EVENT_WORDS.provider_snapshot);
  });

  const SNAP_REASON = "snapshot of the server taken at the hosting company";
  it("our own snapshot, recorded under the provider's action id, is routine and is not written twice", async () => {
    await enrolled();
    await seedOwnerAndHome();
    await recordOwnProviderAction(env.DB, { homeId: "home-g2", generation: 1, actionId: "501", kind: "provider_snapshot", actor: "system", reason: SNAP_REASON, at: T });
    const adapter = hz(async () => [{ id: "501", command: "create_image", startedAt: T }]);
    expect(await sweepProviderAccess(testEnv(), T + 1000, { adapters: { hetzner: adapter } })).toBe(0);
    expect((await events()).length).toBe(1);
    await sweepAccessNotices(testEnv(), T + 2000, noticeDeps);
    expect(sent[0].subject).toBe("Murage Cloud: routine work on your home");
    expect(sent[0].text).toContain("- ");
    expect(sent[0].text).toContain(": We made a routine backup copy of your home.\n");
    expect(sent[0].text).not.toMatch(/keys were used/);
    expect(sent[0].text).not.toContain("Done by");
  });

  it("a foreign snapshot inside our job's window alerts at once", async () => {
    await enrolled();
    await seedOwnerAndHome();
    await recordOwnProviderAction(env.DB, { homeId: "home-g2", generation: 1, actionId: "501", kind: "provider_snapshot", actor: "system", reason: SNAP_REASON, at: T });
    const adapter = hz(async () => [{ id: "502", command: "create_image", startedAt: T + 5 }]);
    expect(await sweepProviderAccess(testEnv(), T + 1000, { adapters: { hetzner: adapter } })).toBe(1);
    await env.DB.prepare("DELETE FROM cloud_access_events WHERE id=?").bind("provider:home-g2:501").run();
    await sweepAccessNotices(testEnv(), T + 2000, noticeDeps);
    expect(sent[0].text).toContain(NOTICE_TEMPLATES.EVENT_WORDS.provider_snapshot);
    expect(sent[0].text).not.toContain(ROUTINE_LINE);
  });

  it("our job that recorded no provider id leaves the snapshot to alert at once", async () => {
    await enrolled();
    await seedOwnerAndHome();
    await recordOwnProviderAction(env.DB, { homeId: "home-g2", generation: 1, actionId: null, kind: "provider_snapshot", actor: "system", reason: SNAP_REASON, at: T });
    expect((await events()).length).toBe(0);
    const adapter = hz(async () => [{ id: "503", command: "create_image", startedAt: T }]);
    expect(await sweepProviderAccess(testEnv(), T + 1000, { adapters: { hetzner: adapter } })).toBe(1);
    await sweepAccessNotices(testEnv(), T + 2000, noticeDeps);
    expect(sent[0].text).toContain(NOTICE_TEMPLATES.EVENT_WORDS.provider_snapshot);
  });

  it("an entry the sweep wrote first is re-attributed to our job when the job records the same id", async () => {
    await enrolled();
    await seedOwnerAndHome();
    const adapter = hz(async () => [{ id: "504", command: "create_image", startedAt: T }]);
    await sweepProviderAccess(testEnv(), T + 1000, { adapters: { hetzner: adapter } });
    await recordOwnProviderAction(env.DB, { homeId: "home-g2", generation: 1, actionId: "504", kind: "provider_snapshot", actor: "system", reason: SNAP_REASON, at: T });
    await sweepAccessNotices(testEnv(), T + 2000, noticeDeps);
    expect(sent[0].subject).toBe("Murage Cloud: routine work on your home");
    expect(sent[0].text).toContain("- ");
    expect(sent[0].text).toContain(": We made a routine backup copy of your home.\n");
    expect(sent[0].text).not.toMatch(/keys were used/);
    expect(sent[0].text).not.toContain("Done by");
  });

  it("a snapshot entry whose actor is the watchdog or an operator is not routine", async () => {
    await enrolled();
    await seedOwnerAndHome();
    await recordOwnProviderAction(env.DB, { homeId: "home-g2", generation: 1, actionId: "505", kind: "provider_snapshot", actor: "system", reason: SNAP_REASON, at: T });
    await env.DB.prepare("UPDATE cloud_access_events SET actor='operator' WHERE id='provider:home-g2:505'").run();
    await sweepAccessNotices(testEnv(), T + 2000, noticeDeps);
    expect(sent[0].text).toContain(NOTICE_TEMPLATES.EVENT_WORDS.provider_snapshot);
    expect(sent[0].text).not.toContain(ROUTINE_LINE);
  });

  it("an action whose start time cannot be read is alerted and still recorded, never skipped", async () => {
    await enrolled();
    await seedOwnerAndHome();
    const adapter = hz(async () => [{ id: "95", command: "enable_rescue", startedAt: Number.NaN }]);
    expect(await sweepProviderAccess(testEnv(), T, { adapters: { hetzner: adapter } })).toBe(1);
    expect((await events()).map((r) => r.kind)).toEqual(["provider_rescue"]);
    expect(await alerts()).toContain("access.action_time_unreadable");
  });

  it("hitting the page cap alerts and leaves the home unmarked", async () => {
    await enrolled();
    await seedOwnerAndHome();
    const adapter = hz(async () => { throw new Error("provider_actions_page_cap"); });
    await sweepProviderAccess(testEnv(), T, { adapters: { hetzner: adapter } });
    expect(await alerts()).toContain("access.history_too_long");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_access_cursor").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("a suspended home is read too", async () => {
    await enrolled();
    await seedOwnerAndHome();
    await env.DB.prepare("UPDATE cloud_homes SET desired_state='suspended' WHERE id='home-g2'").run();
    const adapter = hz(async () => [{ id: "96", command: "enable_rescue", startedAt: T }]);
    expect(await sweepProviderAccess(testEnv(), T + 1000, { adapters: { hetzner: adapter } })).toBe(1);
  });

  it("the read stops at the last full read, with an overlap, and the adapter is told where", async () => {
    await enrolled();
    await seedOwnerAndHome();
    const adapter = hz(async () => []);
    await env.DB.prepare("UPDATE cloud_machines SET created_at=? WHERE home_id='home-g2'").bind(T - 5 * HOUR).run();
    await sweepProviderAccess(testEnv(), T, { adapters: { hetzner: adapter } });
    await sweepProviderAccess(testEnv(), T + 2 * HOUR, { adapters: { hetzner: adapter } });
    const second = (adapter.listProviderActions as unknown as { mock: { calls: [string, number][] } }).mock.calls[1];
    expect(second[1]).toBe(T - HOUR);
    expect((adapter.listProviderActions as unknown as { mock: { calls: [string, number][] } }).mock.calls[0][1]).toBe(T - 5 * HOUR);
  });

  it("a run covers 400 homes inside its budget", async () => {
    const adapter = hz(async () => []);
    const t0 = Date.now();
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < 400; i++) {
      const id = `bulk-${i}`;
      stmts.push(env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,generation,created_at,updated_at)
        VALUES (?,?,?,'ready','ready','sha256:x','k',1,?,?)`).bind(id, `inst-${id}`, "nobody", t0, t0));
      stmts.push(env.DB.prepare(`INSERT INTO cloud_machines (id,home_id,generation,state,server_id,created_at,public_origin,admin_url) VALUES (?,?,1,'active',?,?,'https://h.test','https://a.test')`).bind(id, id, `hs-${1000 + i}`, t0));
    }
    for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
    await sweepProviderAccess(testEnv(), T, { adapters: { hetzner: adapter } });
    expect(adapter.listProviderActions).toHaveBeenCalledTimes(400);
  });
});
