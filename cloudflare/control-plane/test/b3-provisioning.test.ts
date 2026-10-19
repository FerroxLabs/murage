// SPDX-License-Identifier: AGPL-3.0-or-later
// Protocol fixture: actual workerd D1, synthetic identities, no HTTP/provider credentials.
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createWorker } from "../src/index";
import { prepareB3Enrollment, bindB3Enrollment, type B3BindingInput } from "../src/cloud-machines";
import { fakeProvider, type CreateHomeInput, type ProviderAdapter, type VolumeDescriptor } from "../src/b3-provider";
import { sha256 } from "../src/installations";
import shapes from "./fixtures/cp0-shapes.json";
import sharedContract from "../../../shared/cloud-control-shapes.json";

// Frozen R7 check: real CP responses must satisfy the byte-identical shared
// contract used by root snapshot publication and the home consumer, recursively.
interface SharedShape {
  type?: string; const?: unknown; enum?: unknown[]; minimum?: number; maximum?: number;
  pattern?: string; maxLength?: number; additionalProperties?: boolean; required?: string[];
  properties?: Record<string, SharedShape>; anyOf?: SharedShape[];
}
function assertSharedContract(value: unknown, schema: SharedShape): void {
  if (schema.anyOf) {
    const branch = schema.anyOf.find((shape) => shape.type === (value === null ? "null" : typeof value));
    expect(branch).toBeDefined(); assertSharedContract(value, branch!); return;
  }
  if ("const" in schema) expect(value).toEqual(schema.const);
  if (schema.enum) expect(schema.enum).toContain(value);
  if (schema.type === "object") {
    expect(value).not.toBeNull(); expect(typeof value).toBe("object"); expect(Array.isArray(value)).toBe(false);
    const record = value as Record<string, unknown>;
    for (const name of schema.required ?? []) expect(Object.hasOwn(record, name)).toBe(true);
    if (schema.additionalProperties === false) expect(Object.keys(record).sort()).toEqual(Object.keys(schema.properties ?? {}).sort());
    for (const [name, shape] of Object.entries(schema.properties ?? {})) assertSharedContract(record[name], shape);
  } else if (schema.type === "null") expect(value).toBeNull();
  else if (schema.type) {
    expect(typeof value).toBe(schema.type === "integer" ? "number" : schema.type);
    if (typeof value === "number") {
      expect(Number.isFinite(value)).toBe(true);
      if (schema.type === "integer") expect(Number.isSafeInteger(value)).toBe(true);
      if (schema.minimum !== undefined) expect(value).toBeGreaterThanOrEqual(schema.minimum);
      if (schema.maximum !== undefined) expect(value).toBeLessThanOrEqual(schema.maximum);
    }
    if (typeof value === "string") {
      if (schema.pattern) expect(value).toMatch(new RegExp(schema.pattern));
      if (schema.maxLength !== undefined) expect(value.length).toBeLessThanOrEqual(schema.maxLength);
    }
  }
}

const NOW = 1_800_000_000_000;
const ADMIN = "test-only-b3-provision-admin-no-real-access";
const IMAGE = `sha256:${"a".repeat(64)}`;
const HOME = "provision-home";
const config = { reservationMs: 60_000, graceMs: 60_000, retentionMs: 120_000, imageDigest: IMAGE,
  quarantineRelayIP: "192.0.2.20",
  engineSubscriptionGates: { claudeAgent: true, codex: false, grokAgent: false, kimiAgent: false, opencodeGo: true },
  capacity: [{ id: "provision-slot", projectId: "test-project", location: "fsn1", serverType: "cpx32", outcome: "available" }],
};
const fixtureEnv = (): Env => ({ ...env, CLOUD_B3_MODE: "fake", CLOUD_B3_CONFIG: JSON.stringify(config),
  CLOUD_ADMIN_TOKEN: ADMIN, CLOUD_KEK_V1: btoa("x".repeat(32)) });
const noNetwork = async () => { throw new Error("unexpected fixture network"); };
async function call(path: string, input: unknown, provider?: (db: D1Database) => ProviderAdapter, ip = "203.0.113.10") {
  const ctx = createExecutionContext();
  const response = await createWorker(noNetwork, noNetwork, { provider }).fetch(new Request(`https://admin.murage.test${path}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN}`, "CF-Connecting-IP": ip },
    body: JSON.stringify(input),
  }), fixtureEnv(), ctx);
  await waitOnExecutionContext(ctx); return response;
}
const reconcile = (provider?: (db: D1Database) => ProviderAdapter) => call("/v1/fake-b3/reconcile", {}, provider);
const enroll = (token: string, ip = "203.0.113.10") => call(`/v1/machines/${HOME}/enroll`, { token }, undefined, ip);
const row = <T = Record<string, unknown>>(table: string) => env.DB.prepare(`SELECT * FROM ${table} WHERE ${table === "cloud_machines" || table === "cloud_homes" ? "id" : "home_id"}=?`).bind(HOME).first<T>();
function barrier() {
  let enter!: () => void; let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  return { entered, release, async pause() { enter(); await released; } };
}
// Pause the real pre-bind read; the following lifecycle mutation commits before
// the genuine D1 activation batch. No mock row/database or scheduler sleep.
function pauseBindingRead(gate: ReturnType<typeof barrier>) {
  const prepare = env.DB.prepare.bind(env.DB); let armed = true;
  vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    if (!sql.includes("JOIN cloud_homes h ON h.id=m.id JOIN cloud_provision_intents i ON i.home_id=m.id")) return statement;
    const bind = statement.bind.bind(statement);
    vi.spyOn(statement, "bind").mockImplementation((...values) => {
      const bound = bind(...values); const first = bound.first.bind(bound);
      vi.spyOn(bound, "first").mockImplementation(async <T = Record<string, unknown>>(): Promise<T | null> => {
        const result = await first<T>(); if (armed) { armed = false; await gate.pause(); } return result;
      });
      return bound;
    });
    return statement;
  });
}
beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  await env.DB.prepare(`INSERT INTO cloud_homes
    (id,installation_id,owner_id,desired_state,observed_state,entitlement,generation,resource_generation,image_digest,home_key,created_at,updated_at)
    VALUES (?,'provision-installation','provision-owner','provisioning','reserved','paid',1,1,?,'synthetic-home-key',?,?)`)
    .bind(HOME, IMAGE, NOW, NOW).run();
  await env.DB.prepare("INSERT INTO cloud_capacity (id,project_id,location,server_type,home_id,outcome) VALUES ('provision-slot','test-project','fsn1','cpx32',?,'available')")
    .bind(HOME).run();
  await env.DB.prepare(`INSERT INTO cloud_outbox (id,home_id,generation,owner_id,kind,payload,created_at)
    VALUES ('provision-reserved',?,1,'provision-owner','reserved','{"publicOrigin":"https://provision-home.murage.test"}',?)`).bind(HOME, NOW).run();
});
afterEach(() => vi.restoreAllMocks());
async function prepared() {
  const token = await prepareB3Enrollment(fixtureEnv(), { homeId: HOME, generation: 1, resourceGeneration: 1,
    publicOrigin: `https://${HOME}.murage.test`, adminUrl: "https://admin.murage.test", now: Date.now() });
  expect(token).toEqual(expect.any(String)); return token!;
}
async function bindFixture(providerName: VolumeDescriptor["provider"] = "hetzner") {
  const token = await prepared(); const p = fakeProvider(env.DB);
  await env.DB.prepare("UPDATE cloud_provision_intents SET volume_phase='claimed',volume_claim='fixture-volume-claim',server_phase='claimed',server_claim='fixture-server-claim' WHERE home_id=?").bind(HOME).run();
  const volume = await p.create_volume({ homeId: HOME, resourceGeneration: 1, provider: providerName, idempotencyKey: "fixture-volume" });
  const input: CreateHomeInput = { homeId: HOME, resourceGeneration: 1, idempotencyKey: "fixture-server", type: "cpx32", location: "fsn1",
    image: IMAGE, labels: { homeId: HOME, resourceGeneration: "1", role: "home" }, volume,
    userData: { machineId: HOME, enrollmentToken: token, controlPlaneOrigin: "https://admin.murage.test", generation: 1,
      volume: { provider: volume.provider, id: volume.id, device: volume.device, new: volume.new, generation: 1, homeId: HOME } } };
  const server = await p.create(input); const attached = await p.volume(volume.id);
  await env.DB.prepare(`UPDATE cloud_provision_intents SET volume_phase='created',server_phase='created',volume_id=?,server_id=?,volume_json=? WHERE home_id=?`)
    .bind(volume.id, server.id, JSON.stringify(attached), HOME).run();
  const binding: B3BindingInput = { homeId: HOME, generation: 1, resourceGeneration: 1, tokenHash: await sha256(token),
    serverId: server.id, volumeId: volume.id, ips: await p.public_ips(server.id), now: Date.now() };
  return { token, binding, p, volume: attached };
}

describe("B3 pending enrollment and durable provider handshake", () => {
  it("real lease, heartbeat and desired responses satisfy the shared root/home wire contract", async () => {
    const { token, binding } = await bindFixture();
    expect(await bindB3Enrollment(fixtureEnv(), binding)).toBe(true);
    const enrolled = await enroll(token); expect(enrolled.status).toBe(200);
    const { machineCredential, generation } = await enrolled.json<{ machineCredential: string; generation: number }>();
    const checks = { authenticatedUI: true, engineRoundTrip: true, sandboxedBrowser: true, writableState: true, schedulerHeartbeat: true };
    const canary = await call(`/v1/fake-b3/homes/${HOME}/canary`, { generation, imageDigest: IMAGE, checks });
    expect(canary.status).toBe(200); expect((await row("cloud_homes"))?.desired_state).toBe("ready");
    const signer = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const signedEnv = { ...fixtureEnv(), CLOUD_B3_SIGNING_JWK: JSON.stringify(await crypto.subtle.exportKey("jwk", signer.privateKey)) };
    const machineCall = async (operation: string, input?: unknown) => {
      const ctx = createExecutionContext();
      const response = await createWorker(noNetwork, noNetwork).fetch(new Request(`https://admin.murage.test/v1/machines/${HOME}/${operation}`, {
        method: input === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${machineCredential}`, "CF-Connecting-IP": "203.0.113.10" },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      }), signedEnv, ctx);
      await waitOnExecutionContext(ctx); expect(response.status).toBe(200); return response.json<Record<string, unknown>>();
    };
    const beforeLease = await machineCall("desired");
    assertSharedContract(beforeLease, sharedContract.$defs.desiredResponse);
    expect(beforeLease.lease).toBeNull(); expect(beforeLease.executionAllowed).toBe(false);
    const leaseRequest = { holder: HOME, generation };
    assertSharedContract(leaseRequest, sharedContract.$defs.leaseRequest);
    const lease = await machineCall("lease", leaseRequest);
    assertSharedContract(lease, sharedContract.$defs.leaseResponse);
    expect(lease.holder).toBe(HOME); expect(lease.generation).toBe(generation);
    const heartbeatRequest = { generation };
    assertSharedContract(heartbeatRequest, sharedContract.$defs.heartbeatRequest);
    assertSharedContract(await machineCall("heartbeat", heartbeatRequest), sharedContract.$defs.heartbeatResponse);
    const desired = await machineCall("desired");
    assertSharedContract(desired, sharedContract.$defs.desiredResponse);
    assertSharedContract(desired, sharedContract.$defs.controlSnapshot.properties.desired);
    expect(desired.lease).toEqual({ holder: HOME, generation, expiresAt: lease.expiresAt });
    expect(desired).toMatchObject({ homeId: HOME, generation, desiredState: "ready", executionAllowed: true, heartbeatFresh: true });
  });
  it("publishes exact nonconsuming pending only for the current unused token; no unbound credential", async () => {
    const token = await prepared();
    const response = await enroll(token);
    expect(response.status).toBe(409); const pending = await response.json();
    expect(pending).toEqual(shapes.b3EnrollmentPendingResponse);
    assertSharedContract(pending, sharedContract.$defs.enrollmentPendingResponse);
    expect((await env.DB.prepare("SELECT used_at FROM cloud_enrollment_tokens WHERE hash=?").bind(await sha256(token)).first())?.used_at).toBeNull();
    expect((await row("cloud_machines"))?.credential_hash).toBeNull();
    expect((await enroll("unknown-test-only-token")).status).toBe(401);
    await env.DB.prepare("UPDATE cloud_enrollment_tokens SET expires_at=?").bind(NOW).run();
    expect((await enroll(token)).status).toBe(401);
  });
  it("stale intent, used token and a pending machine without the exact intent never disclose pending", async () => {
    const token = await prepared();
    await env.DB.prepare("UPDATE cloud_provision_intents SET cp_generation=2").run();
    expect((await enroll(token)).status).toBe(401);
    await env.DB.prepare("UPDATE cloud_provision_intents SET cp_generation=1").run();
    await env.DB.prepare("UPDATE cloud_enrollment_tokens SET used_at=?").bind(NOW).run();
    expect((await enroll(token)).status).toBe(401);
    await env.DB.prepare("UPDATE cloud_enrollment_tokens SET used_at=NULL").run();
    await env.DB.prepare("DELETE FROM cloud_provision_intents").run();
    expect((await enroll(token)).status).toBe(401);
  });
  it("claims before volume/server calls, privately delivers the same token, then single-use enrolls", async () => {
    const gate = barrier(); let input!: CreateHomeInput;
    const provider = (db: D1Database) => { const p = fakeProvider(db); return { ...p,
      async create_volume(value: Parameters<ProviderAdapter["create_volume"]>[0]) {
        expect((await row("cloud_provision_intents"))?.volume_phase).toBe("claimed");
        return p.create_volume(value);
      },
      async create(value: CreateHomeInput) {
        input = value;
        expect((await row("cloud_provision_intents"))?.server_phase).toBe("claimed");
        expect((await row("cloud_machines"))?.state).toBe("pending_binding");
        expect((await row("cloud_provision_intents"))?.token_hash).toBe(await sha256(value.userData.enrollmentToken));
        await gate.pause(); return p.create(value);
      },
    }; };
    const running = reconcile(provider); await gate.entered;
    try {
      expect((await enroll(input.userData.enrollmentToken)).status).toBe(409);
      expect(Object.keys(input.userData.volume).sort()).toEqual(["device", "generation", "homeId", "id", "new", "provider"]);
      expect(input).toMatchObject({ type: "cpx32", location: "fsn1", image: IMAGE,
        labels: { homeId: HOME, resourceGeneration: "1", role: "home" } });
    } finally { gate.release(); }
    expect((await running).status).toBe(200);
    const responses = await Promise.all(Array.from({ length: 4 }, () => enroll(input.userData.enrollmentToken)));
    expect(responses.map((r) => r.status).sort()).toEqual([200, 401, 401, 401]);
    expect((await row("cloud_provision_intents"))?.state).toBe("bound");
    for (const table of ["cloud_provision_intents", "cloud_fake_resources", "cloud_outbox", "cloud_mutations", "cloud_enrollment_tokens"]) {
      expect(JSON.stringify((await env.DB.prepare(`SELECT * FROM ${table}`).all()).results)).not.toContain(input.userData.enrollmentToken);
    }
  });
  it("concurrent prepare creates one hash and key set; a loser cannot cancel the active preparer", async () => {
    const tokens = await Promise.all(Array.from({ length: 4 }, () => prepareB3Enrollment(fixtureEnv(), {
      homeId: HOME, generation: 1, resourceGeneration: 1, publicOrigin: `https://${HOME}.murage.test`, adminUrl: "https://admin.murage.test", now: NOW,
    })));
    expect(tokens.filter(Boolean)).toHaveLength(1);
    expect((await env.DB.prepare("SELECT * FROM cloud_home_keys").all()).results).toHaveLength(1);
    // The token is stored wrapped, so the sweep can deliver it even though the preparer's copy was never handed over.
    expect((await reconcile()).status).toBe(200);
    expect((await row("cloud_homes"))?.desired_state).toBe("checking");
    expect((await enroll(tokens.find(Boolean)!)).status).toBe(200);
    expect((await env.DB.prepare("SELECT * FROM cloud_fake_resources WHERE role='home'").all()).results).toHaveLength(1);
  });
  it("refuses a matching but unclaimed provider resource without manufacturing enrollment delivery", async () => {
    await fakeProvider(env.DB).create_volume({ homeId: HOME, resourceGeneration: 1, provider: "hetzner", idempotencyKey: "unclaimed-volume" });
    expect((await reconcile()).status).toBe(500);
    expect(await row("cloud_machines")).toBeNull(); expect(await row("cloud_provision_intents")).toBeNull();
    expect(await env.DB.prepare("SELECT * FROM cloud_fake_dns").first()).toBeNull();
  });
  it("lost server response and temporarily empty listing never reissue create; later exact adoption binds", async () => {
    let creates = 0; let hide = true; let token = "";
    const provider = (db: D1Database) => { const p = fakeProvider(db); return { ...p,
      async create(input: CreateHomeInput) { creates++; token = input.userData.enrollmentToken; await p.create(input); throw new Error("synthetic lost response"); },
      async list_by_tag(home: string, generation: number, role: "home" | "volume") {
        if (creates && role === "home" && hide) return []; return p.list_by_tag(home, generation, role);
      },
    }; };
    expect((await reconcile(provider)).status).toBe(500);
    const first = token;
    expect((await reconcile(provider)).status).toBe(200); // backing off: nothing is attempted
    expect(creates).toBe(1); expect((await row("cloud_homes"))?.desired_state).toBe("provisioning");
    // Retry while the listing still hides the server: the idempotent create finds its own server, never a second one.
    vi.mocked(Date.now).mockReturnValue(NOW + 5 * 60_000);
    await reconcile(provider);
    expect((await env.DB.prepare("SELECT * FROM cloud_fake_resources WHERE role='home'").all()).results).toHaveLength(1);
    expect(token).toBe(first); // the retry re-delivered the SAME token
    hide = false; vi.mocked(Date.now).mockReturnValue(NOW + 10 * 60_000);
    expect((await reconcile(provider)).status).toBe(200);
    expect((await env.DB.prepare("SELECT * FROM cloud_fake_resources WHERE role='home'").all()).results).toHaveLength(1);
    expect((await enroll(token)).status).toBe(200);
  });
  it("lost volume response reconciles the exact volume before any server create", async () => {
    let volumes = 0; let servers = 0;
    const provider = (db: D1Database) => { const p = fakeProvider(db); return { ...p,
      async create_volume(input: Parameters<ProviderAdapter["create_volume"]>[0]) { volumes++; await p.create_volume(input); throw new Error("lost volume response"); },
      async create(input: CreateHomeInput) { servers++; expect(volumes).toBe(1); expect((await row("cloud_provision_intents"))?.volume_phase).toBe("created"); return p.create(input); },
    }; };
    expect((await reconcile(provider)).status).toBe(200); expect(volumes).toBe(1); expect(servers).toBe(1);
  });
  it("unknown volume outcome with an empty list is retried by the next attempt without a second volume", async () => {
    let calls = 0; let hide = true;
    const provider = (db: D1Database) => { const p = fakeProvider(db); return { ...p,
      async create_volume(input: Parameters<ProviderAdapter["create_volume"]>[0]) { calls++; await p.create_volume(input); throw new Error("unknown volume outcome"); },
      async list_by_tag(home: string, gen: number, role: "home" | "volume") {
        if (calls && role === "volume" && hide) return []; return p.list_by_tag(home, gen, role);
      },
    }; };
    expect((await reconcile(provider)).status).toBe(500);
    expect((await reconcile(provider)).status).toBe(200); expect(calls).toBe(1); // backing off
    hide = false; vi.mocked(Date.now).mockReturnValue(NOW + 5 * 60_000);
    expect((await reconcile(provider)).status).toBe(200);
    expect((await env.DB.prepare("SELECT * FROM cloud_fake_resources WHERE role='volume'").all()).results).toHaveLength(1);
    expect((await row("cloud_homes"))?.desired_state).toBe("checking");
  });
  it("later-attach strategy cannot bind while exact attachment is pending; completion allows the same token", async () => {
    let pending = true; let token = "";
    const provider = (db: D1Database) => { const p = fakeProvider(db); return { ...p,
      async create(input: CreateHomeInput) { token = input.userData.enrollmentToken; const server = await p.create(input);
        await p.detach_volume(input.volume.id, server.id); return server; },
      async attach_volume(volumeId: string, serverId: string) {
        const v = await p.attach_volume(volumeId, serverId);
        return pending ? { ...v, attachment: { serverId, state: "attaching" as const } } : v;
      },
    }; };
    expect((await reconcile(provider)).status).toBe(200);
    expect((await enroll(token)).status).toBe(409); expect((await row("cloud_machines"))?.server_id).toBeNull();
    expect(await env.DB.prepare("SELECT * FROM cloud_fake_dns").first()).toBeNull();
    pending = false; expect((await reconcile(provider)).status).toBe(200); expect((await enroll(token)).status).toBe(200);
  });
  it("rejects a wrong-target attachment completion and wrong serial before binding", async () => {
    const provider = (db: D1Database) => { const p = fakeProvider(db); return { ...p,
      async attach_volume(volumeId: string, serverId: string) {
        const v = await p.attach_volume(volumeId, serverId); return { ...v, attachment: { serverId: "wrong-server", state: "attached" as const } };
      },
    }; };
    expect((await reconcile(provider)).status).toBe(500);
    expect((await row("cloud_machines"))?.state).toBe("pending_binding");
    expect(await env.DB.prepare("SELECT * FROM cloud_fake_dns").first()).toBeNull();
    const v = (await fakeProvider(env.DB).list_by_tag(HOME, 1, "volume"))[0];
    await env.DB.prepare("UPDATE cloud_fake_resources SET serial='wrong-serial' WHERE id=?").bind(v.id).run();
    vi.mocked(Date.now).mockReturnValue(NOW + 5 * 60_000); // past the backoff
    expect((await reconcile()).status).toBe(500);
    expect((await row("cloud_homes"))?.desired_state).toBe("provisioning");
  });
  it.each(["hetzner", "vultr"] as const)("%s fixture uses its exact device and target-pair idempotency", async (provider) => {
    const { p, volume, binding } = await bindFixture(provider);
    expect(volume.device).toBe(provider === "hetzner" ? `/dev/disk/by-id/scsi-0HC_Volume_${volume.id}` : `/dev/disk/by-id/virtio-${volume.serial}`);
    await expect(p.attach_volume(volume.id, "wrong-server")).rejects.toThrow();
    expect((await p.attach_volume(volume.id, binding.serverId)).attachment).toEqual({ serverId: binding.serverId, state: "attached" });
    await expect(p.detach_volume(volume.id, "wrong-server")).rejects.toThrow();
    expect((await p.detach_volume(volume.id, binding.serverId)).attachment.state).toBe("detached");
    expect((await p.detach_volume(volume.id, binding.serverId)).attachment.state).toBe("detached");
    await expect(p.detach_volume(volume.id, "wrong-server")).rejects.toThrow();
  });
  it("concurrent and later binders preserve the one issued credential", async () => {
    const { token, binding } = await bindFixture();
    expect(await Promise.all(Array.from({ length: 4 }, () => bindB3Enrollment(fixtureEnv(), binding)))).toEqual([true, true, true, true]);
    const response = await enroll(token); expect(response.status).toBe(200);
    const credential = await response.json<{ machineCredential: string }>();
    const before = (await row("cloud_machines"))?.credential_hash;
    expect(before).toBe(await sha256(credential.machineCredential));
    expect(await bindB3Enrollment(fixtureEnv(), binding)).toBe(true);
    expect((await row("cloud_machines"))?.credential_hash).toBe(before);
    expect((await enroll(token)).status).toBe(401);
  });
  it.each(["delete", "generation"])("%s racing bind cannot partially activate or publish DNS", async (action) => {
    const { token, binding } = await bindFixture(); const gate = barrier(); pauseBindingRead(gate);
    const bindingResult = bindB3Enrollment(fixtureEnv(), binding); await gate.entered;
    if (action === "delete") await env.DB.prepare("UPDATE cloud_homes SET desired_state='deleting' WHERE id=?").bind(HOME).run();
    else await env.DB.prepare("UPDATE cloud_homes SET generation=2 WHERE id=?").bind(HOME).run();
    gate.release(); await expect(bindingResult).rejects.toThrow();
    const machine = await row("cloud_machines");
    expect(machine?.state).toBe("pending_binding"); expect(machine?.server_id).toBeNull(); expect(machine?.bound_ips).toBeNull();
    expect((await row("cloud_provision_intents"))?.state).toBe("pending");
    expect(await env.DB.prepare("SELECT * FROM cloud_fake_dns").first()).toBeNull();
    expect((await enroll(token)).status).toBe(401);
  });
  it("a zero-row token mutation rolls back an earlier activation mutation in genuine D1", async () => {
    const { binding } = await bindFixture();
    // An AFTER machine update trigger simulates expiry inside the atomic batch,
    // proving the explicit token guard rather than an earlier read precondition.
    // D1.exec splits on newlines; prepare submits this compound trigger intact.
    await env.DB.prepare(`CREATE TRIGGER provision_fixture_token_loss AFTER UPDATE OF state ON cloud_machines
      WHEN NEW.state='active' BEGIN UPDATE cloud_enrollment_tokens SET used_at=1 WHERE machine_id=NEW.id; END;`).run();
    try {
      await expect(bindB3Enrollment(fixtureEnv(), binding)).rejects.toThrow();
      expect((await row("cloud_machines"))?.state).toBe("pending_binding");
      expect((await env.DB.prepare("SELECT used_at FROM cloud_enrollment_tokens").first())?.used_at).toBeNull();
      expect((await row("cloud_provision_intents"))?.state).toBe("pending");
      expect(await env.DB.prepare("SELECT * FROM cloud_fake_dns").first()).toBeNull();
    } finally { await env.DB.prepare("DROP TRIGGER provision_fixture_token_loss").run(); }
  });
});
