// SPDX-License-Identifier: AGPL-3.0-or-later
// KMS signing design 12.5 H3: a home already BOUND (checking) to a rejected or retired warm-pool server that never enrolled is put back on the
// normal provisioning path: same resource generation, same volume, a new dispatch, the old enrollment revoked, the delete confirmed first.
// Real workerd + D1 with the fake provider (the fake's destroy is made to behave like a real one: the server row is gone, the volume detached).
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorker } from "../src/index";
import { fakeProvider, type ProviderAdapter } from "../src/b3-provider";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const ADMIN = "test-only-pool-recovery-admin-no-real-access";
const IMAGE = `sha256:${"a".repeat(64)}`;
const HOME = "recover-home";
const config = { reservationMs: 60_000, graceMs: 60_000, retentionMs: 120_000, imageDigest: IMAGE, quarantineRelayIP: "192.0.2.20",
  engineSubscriptionGates: { claudeAgent: true, codex: false, grokAgent: false, kimiAgent: false, opencodeGo: true },
  capacity: [{ id: "recover-slot", projectId: "test-project", location: "fsn1", serverType: "cpx32", outcome: "available" }] };
const fixtureEnv = (): Env => ({ ...env, CLOUD_B3_MODE: "fake", CLOUD_B3_CONFIG: JSON.stringify(config), CLOUD_ADMIN_TOKEN: ADMIN, CLOUD_KEK_V1: btoa("x".repeat(32)) } as Env);
const noNetwork = async () => { throw new Error("unexpected fixture network"); };
type Make = (db: D1Database) => ProviderAdapter;

async function reconcile(provider: Make) {
  const ctx = createExecutionContext();
  const response = await createWorker(noNetwork, noNetwork, { provider }).fetch(new Request("https://admin.murage.test/v1/fake-b3/reconcile", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN}`, "CF-Connecting-IP": "203.0.113.10" }, body: "{}",
  }), fixtureEnv(), ctx);
  await waitOnExecutionContext(ctx); return response;
}
const at = (minutes: number) => vi.mocked(Date.now).mockReturnValue(NOW + minutes * MIN);
const row = <T = Record<string, unknown>>(table: string) => env.DB.prepare(`SELECT * FROM ${table} WHERE ${table === "cloud_homes" || table === "cloud_machines" ? "id" : "home_id"}=?`).bind(HOME).first<T>();
const live = async (role: "home" | "volume") => (await env.DB.prepare("SELECT * FROM cloud_fake_resources WHERE role=? AND state<>'destroyed'").bind(role).all<{ id: string }>()).results;
const serverCalls = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_resource_dispatch_calls WHERE home_id=? AND role='server'").bind(HOME).first<{ n: number }>())!.n;
interface Intent { resource_generation: number; volume_id: string; volume_phase: string; server_id: string | null; server_phase: string; server_claim: string | null; state: string; token_hash: string }

/** The fake with a real provider's delete: the server is gone and its volume is detached. `remove` false: the delete is accepted but the server stays listed. */
const provider = (log: string[] = [], remove = true): Make => (db) => {
  const p = fakeProvider(db);
  return { ...p,
    async destroy(id, signal) {
      log.push(`destroy:${id}`);
      if (!remove) return;
      await db.prepare("DELETE FROM cloud_fake_resources WHERE id=? AND role='home'").bind(id).run();
      await db.prepare("UPDATE cloud_fake_resources SET state='detached',attachment_server_id=NULL WHERE role='volume' AND attachment_server_id=?").bind(id).run();
    },
    async start(id) { log.push(`start:${id}`); return p.start(id); },
    async reboot(id) { log.push(`reboot:${id}`); return p.reboot!(id); },
    async power_off(id) { log.push(`power_off:${id}`); return p.power_off(id); },
    async stop(id) { log.push(`stop:${id}`); return p.stop(id); },
  };
};

/** A paid home bound to its server by the ordinary path, then (as the claim path leaves it) tied to a warm-pool row and a pool choice. */
async function boundToPoolServer(poolState: "failed" | "retired" = "failed") {
  at(0); await reconcile(provider());
  expect((await row<{ desired_state: string }>("cloud_homes"))?.desired_state).toBe("checking");
  const intent = (await row<Intent>("cloud_provision_intents"))!;
  await env.DB.prepare(`INSERT INTO provision_choices (home_id,resource_generation,provider,server_type,location,arch,image,tried,created_at,pool_id)
    VALUES (?,1,'hetzner','cpx32','fsn1','x86',?,'[]',?,'pool-1') ON CONFLICT(home_id,resource_generation) DO UPDATE SET pool_id='pool-1'`).bind(HOME, IMAGE, NOW).run();
  await env.DB.prepare(`INSERT INTO warm_pool (id,env,class,provider,server_type,arch,location,image_id,image_digest,state,phase,server_id,create_call_id,monthly_cents,vcpus,created_at,home_id,resource_generation,fail_reason)
    VALUES ('pool-1','staging','starter','hetzner','cpx32','x86','fsn1','img','dig',?,NULL,?,'call-1',500,4,?,?,1,'claim_image_rejected')`).bind(poolState, intent.server_id, NOW, HOME).run();
  await env.DB.prepare("INSERT INTO warm_pool_deliveries (pool_id,home_id,resource_generation,token_hash,payload_wrapped,created_at) VALUES ('pool-1',?,1,?, 'wrapped',?)").bind(HOME, intent.token_hash, NOW).run();
  return intent;
}

beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  await env.DB.prepare(`INSERT INTO cloud_homes
    (id,installation_id,owner_id,desired_state,observed_state,entitlement,payment_version,generation,resource_generation,image_digest,home_key,created_at,updated_at)
    VALUES (?,'recover-installation','recover-owner','provisioning','reserved','paid',1,1,1,?,'synthetic-home-key',?,?)`).bind(HOME, IMAGE, NOW, NOW).run();
  await env.DB.prepare("INSERT INTO cloud_capacity (id,project_id,location,server_type,home_id,outcome) VALUES ('recover-slot','test-project','fsn1','cpx32',?,'available')").bind(HOME).run();
  await env.DB.prepare(`INSERT INTO cloud_outbox (id,home_id,generation,owner_id,kind,payload,created_at)
    VALUES ('recover-reserved',?,1,'recover-owner','reserved','{"publicOrigin":"https://recover-home.murage.test"}',?)`).bind(HOME, NOW).run();
  await env.DB.prepare(`INSERT INTO cloud_outbox (id,home_id,generation,owner_id,kind,payload,created_at)
    VALUES ('payment:evt-recover',?,1,'recover-owner','payment_paid',?,?)`).bind(HOME, JSON.stringify({ eventId: "evt-recover", homeId: HOME, version: 1, status: "paid", paymentId: "in_recover_1" }), NOW).run();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await env.DB.batch(["warm_pool", "warm_pool_deliveries", "warm_pool_events"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});

describe("a rejected or retired pool server and an already-bound home (12.5 H3)", () => {
  for (const poolState of ["failed", "retired"] as const) {
    it(`pool row ${poolState}: the same generation and volume come back on the normal path with a new dispatch, the old enrollment revoked and no intent conflict`, async () => {
      const before = await boundToPoolServer(poolState);
      const dispatches = await serverCalls();
      const log: string[] = [];
      at(1); await reconcile(provider(log));
      // The delete was by exact id; nothing was ever started, rebooted or powered.
      expect(log).toEqual([`destroy:${before.server_id}`]);
      expect(await live("home")).toHaveLength(0);
      // One batch later: the home is provisioning again, the intent pending, SAME generation and SAME volume.
      expect(await row("cloud_homes")).toMatchObject({ desired_state: "provisioning", resource_generation: 1, generation: 1 });
      expect(await row<Intent>("cloud_provision_intents")).toMatchObject({ resource_generation: before.resource_generation, volume_id: before.volume_id,
        volume_phase: "created", server_phase: "pending", server_id: null, server_claim: null, state: "pending", token_hash: before.token_hash });
      // The old enrollment authorization is revoked; the machine is unbound.
      expect((await env.DB.prepare("SELECT used_at FROM cloud_enrollment_tokens WHERE hash=?").bind(before.token_hash).first<{ used_at: number | null }>())?.used_at).not.toBeNull();
      expect(await row("cloud_machines")).toMatchObject({ state: "pending_binding", server_id: null, bound_ips: null, credential_hash: null });
      // The choice is never deleted: only the pool association goes, the provider and location stay.
      expect(await row("provision_choices")).toMatchObject({ provider: "hetzner", location: "fsn1", pool_id: null });
      expect(await env.DB.prepare("SELECT state,destroyed_at,secret_hash FROM warm_pool WHERE id='pool-1'").first()).toMatchObject({ state: "failed", secret_hash: null });
      expect((await env.DB.prepare("SELECT destroyed_at FROM warm_pool WHERE id='pool-1'").first<{ destroyed_at: number | null }>())?.destroyed_at).not.toBeNull();
      expect(await env.DB.prepare("SELECT payload_wrapped FROM warm_pool_deliveries WHERE pool_id='pool-1'").first()).toEqual({ payload_wrapped: null });
      // Next pass: the normal path creates a NEW server on the SAME volume, within the budget, with a fresh token.
      at(2); await reconcile(provider(log));
      expect(await row("cloud_homes")).toMatchObject({ desired_state: "checking", resource_generation: 1 });
      const after = (await row<Intent>("cloud_provision_intents"))!;
      expect(after).toMatchObject({ state: "bound", volume_id: before.volume_id, resource_generation: 1, volume_phase: "created", server_phase: "created" });
      expect(after.server_id).not.toBeNull(); expect(after.token_hash).not.toBe(before.token_hash);
      expect(await serverCalls()).toBe(dispatches + 1);
      expect(await row("provision_attempts")).toMatchObject({ gave_up_at: null, last_error: null });
      expect(await live("home")).toHaveLength(1);
      expect(await live("volume")).toEqual([expect.objectContaining({ id: before.volume_id })]);
      expect(log.filter((l) => !l.startsWith("destroy:"))).toEqual([]);
    });
  }

  it("the batch is NOT applied while the server is still listed: nothing of the intent moves, and the next pass finishes once the delete is confirmed", async () => {
    const before = await boundToPoolServer();
    const log: string[] = [];
    at(1); await reconcile(provider(log, false));
    expect(log).toEqual([`destroy:${before.server_id}`]);
    expect(await live("home")).toHaveLength(1);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "checking" });
    expect(await row<Intent>("cloud_provision_intents")).toMatchObject({ state: "bound", server_id: before.server_id, server_phase: "created", volume_id: before.volume_id });
    expect((await env.DB.prepare("SELECT used_at FROM cloud_enrollment_tokens WHERE hash=?").bind(before.token_hash).first<{ used_at: number | null }>())?.used_at).not.toBeNull(); // claimed before the delete
    expect(await row("cloud_machines")).toMatchObject({ state: "active", server_id: before.server_id });
    expect((await env.DB.prepare("SELECT destroyed_at FROM warm_pool WHERE id='pool-1'").first<{ destroyed_at: number | null }>())?.destroyed_at).toBeNull();
    // Only the pool association was cleared, and the choice still stands.
    expect(await row("provision_choices")).toMatchObject({ provider: "hetzner", location: "fsn1", pool_id: null });
    at(2); await reconcile(provider(log));
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "provisioning" });
    expect(await row<Intent>("cloud_provision_intents")).toMatchObject({ state: "pending", server_id: null, volume_id: before.volume_id });
  });

  it("a server that already enrolled is an established home: it is never destroyed or reset", async () => {
    const before = await boundToPoolServer();
    await env.DB.prepare("UPDATE cloud_machines SET credential_hash='established' WHERE id=?").bind(HOME).run();
    const log: string[] = [];
    at(1); await reconcile(provider(log));
    expect(log).toEqual([]);
    expect(await live("home")).toHaveLength(1);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "checking" });
    expect(await row<Intent>("cloud_provision_intents")).toMatchObject({ state: "bound", server_id: before.server_id });
  });

  it("an enrollment landing between the enrolled check and the claim wins: the server is not deleted and the home stays enrolled", async () => {
    const before = await boundToPoolServer();
    const log: string[] = [];
    let fired = false;
    // Enrollment (token consumed + credential issued, one batch as in enroll()) runs just before recovery's claim statement executes.
    const real = env.DB.prepare.bind(env.DB);
    const spy = vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      if (!fired && sql.startsWith("UPDATE cloud_enrollment_tokens SET used_at=? WHERE machine_id=?")) {
        fired = true;
        const stmt = real(sql); const bind = stmt.bind.bind(stmt);
        stmt.bind = ((...a: unknown[]) => { const b = bind(...a); const run = b.run.bind(b);
          b.run = (async () => { await env.DB.batch([
            real("UPDATE cloud_enrollment_tokens SET used_at=? WHERE hash=? AND used_at IS NULL").bind(NOW, before.token_hash),
            real("UPDATE cloud_machines SET credential_hash='enrolled-in-race' WHERE id=? AND credential_hash IS NULL").bind(HOME)]); return run(); }) as typeof b.run;
          return b; }) as typeof stmt.bind;
        return stmt;
      }
      return real(sql);
    });
    at(1); await reconcile(provider(log));
    spy.mockRestore();
    expect(fired).toBe(true);
    expect(log).toEqual([]);
    expect(await live("home")).toHaveLength(1);
    expect(await row("cloud_machines")).toMatchObject({ credential_hash: "enrolled-in-race", server_id: before.server_id });
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "checking" });
    expect(await row<Intent>("cloud_provision_intents")).toMatchObject({ state: "bound", server_id: before.server_id });
  });

  it("a pool row that is not rejected leaves a bound home alone", async () => {
    const before = await boundToPoolServer();
    await env.DB.prepare("UPDATE warm_pool SET state='claimed' WHERE id='pool-1'").run();
    const log: string[] = [];
    at(1); await reconcile(provider(log));
    expect(log).toEqual([]);
    expect(await row<Intent>("cloud_provision_intents")).toMatchObject({ state: "bound", server_id: before.server_id });
  });

  it("a stale recovery that resumes after a newer recovery and a replacement bind revokes and destroys nothing of the replacement (Astra, High)", async () => {
    const before = await boundToPoolServer();
    const aLog: string[] = [];
    const innerLog: string[] = [];
    let fired = false;
    // Recovery A has read the pool row and the intent and paused just before its claim. Meanwhile: its lease lapses, recovery B completes (the
    // intent goes back to pending, the pool row destroyed), and normal provisioning binds a replacement with a fresh token, same resource generation.
    const real = env.DB.prepare.bind(env.DB);
    const spy = vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      if (!fired && sql.startsWith("UPDATE cloud_enrollment_tokens SET used_at=? WHERE machine_id=?")) {
        fired = true;
        const stmt = real(sql); const bind = stmt.bind.bind(stmt);
        stmt.bind = ((...a: unknown[]) => { const b = bind(...a); const run = b.run.bind(b);
          b.run = (async () => {
            await env.DB.prepare("UPDATE provision_attempts SET next_at=0 WHERE home_id=?").bind(HOME).run(); // A's lease lapsed
            at(2); await reconcile(provider(innerLog)); // B
            at(3); await reconcile(provider(innerLog)); // provisioning binds the replacement
            at(1);
            return run();
          }) as typeof b.run;
          return b; }) as typeof stmt.bind;
        return stmt;
      }
      return real(sql);
    });
    at(1); await reconcile(provider(aLog));
    spy.mockRestore();
    expect(fired).toBe(true);
    const after = (await row<Intent>("cloud_provision_intents"))!;
    expect(after).toMatchObject({ state: "bound", server_phase: "created" });
    expect(after.token_hash).not.toBe(before.token_hash); // the fake reuses the server id: the fresh token tells the replacement apart
    expect(innerLog).toEqual([`destroy:${before.server_id}`]); // B's own delete of the rejected server
    expect(aLog).toEqual([]); // A destroyed nothing
    expect(await live("home")).toEqual([expect.objectContaining({ id: after.server_id })]); // the replacement survives
    expect((await env.DB.prepare("SELECT used_at FROM cloud_enrollment_tokens WHERE hash=?").bind(after.token_hash).first<{ used_at: number | null }>())?.used_at).toBeNull();
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "checking" });
  });
});
