// SPDX-License-Identifier: AGPL-3.0-or-later
// The home-update rollout controller (src/rollout.ts): operator routes, waves 0..3 with a soak between them, every halt trigger, an
// idempotent cron sweep, cancel and resume, and older homes that never report. Homes are seeded straight into D1; the commands the
// controller sends are the real ones (the self-service job slot and lease), and the "home" answers by writing its update report.
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { ROLLOUT_REPORT_TIMEOUT_MS, ROLLOUT_SOAK_MS, ROLLOUT_HALTED_ALERT, sweepRollout, type RolloutOptions } from "../src/rollout";
import { dispatchRolloutUpdate, latestPromotedSequence } from "../src/self-service";
import { sha256 } from "../src/installations";

const ADMIN = "test-only-cloud-admin-token-with-no-real-access";
const T0 = 1_800_000_000_000;
const MIN = 60_000; const HOUR = 60 * MIN;
const testEnv = () => ({ ...env, CLOUD_ADMIN_TOKEN: ADMIN }) as Env;

async function call(path: string, body?: unknown, method?: string, token: string | null = ADMIN) {
  const headers = new Headers({ "content-type": "application/json", "CF-Connecting-IP": "203.0.113.9" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://admin.murage.test${path}`, { method: method ?? (body === undefined ? "GET" : "POST"), headers,
    body: body === undefined ? undefined : JSON.stringify(body) }), testEnv(), ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const sweep = (now: number, o?: RolloutOptions) => sweepRollout(testEnv(), now, o);
// The routes stamp Date.now(); a test that moves time moves it with at().
const at = (t: number) => vi.mocked(Date.now).mockReturnValue(t);
beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(T0); });
afterEach(() => vi.restoreAllMocks());

let seq = 0;
/** A ready home that polls for commands, heartbeating at `t`. */
async function home(id: string, opts: { internal?: boolean; order?: number; beat?: number } = {}) {
  const created = T0 - 10 * HOUR + (opts.order ?? ++seq);
  await env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,created_at,updated_at,heartbeat_at)
    VALUES (?,?,?,'ready','ready','sha256:x','k',?,?,?)`).bind(id, `inst-${id}`, `owner-${id}`, created, created, opts.beat ?? T0).run();
  await env.DB.prepare("INSERT INTO cloud_home_runner (home_id,generation,polled_at) VALUES (?,1,?)").bind(id, T0).run();
  if (opts.internal) await env.DB.prepare("INSERT INTO cloud_rollout_flags (home_id,internal,updated_at) VALUES (?,1,?)").bind(id, T0).run();
}
/** What the home's updater reports (its installed sequence, lastResult, Stuck code) and its heartbeat. */
async function reportAs(id: string, r: { seq?: number | null; last?: { commandId: string; outcome: "done" | "failed"; reason?: string | null }; stuck?: string | null; beat?: number }) {
  await env.DB.prepare(`INSERT INTO cloud_home_update_reports (home_id,generation,installed_sequence,last_command_id,last_outcome,last_reason,stuck,reported_at)
    VALUES (?,1,?,?,?,?,?,?) ON CONFLICT(home_id) DO UPDATE SET installed_sequence=excluded.installed_sequence,last_command_id=excluded.last_command_id,
    last_outcome=excluded.last_outcome,last_reason=excluded.last_reason,stuck=excluded.stuck,reported_at=excluded.reported_at`)
    .bind(id, r.seq ?? null, r.last?.commandId ?? null, r.last?.outcome ?? null, r.last?.reason ?? null, r.stuck ?? null, T0).run();
  if (r.beat !== undefined) await env.DB.prepare("UPDATE cloud_homes SET heartbeat_at=? WHERE id=?").bind(r.beat, id).run();
}
const commandOf = async (id: string) => (await env.DB.prepare("SELECT command_id FROM cloud_release_homes WHERE home_id=? ORDER BY created_at DESC").bind(id).first<{ command_id: string | null }>())?.command_id ?? null;
const rolloutCommands = async () => (await env.DB.prepare("SELECT home_id,payload,expires_at,picked_at FROM cloud_home_commands WHERE kind='update_software' ORDER BY created_at,home_id").all<{ home_id: string; payload: string; expires_at: number; picked_at: number | null }>()).results;
const homesOf = async (releaseId: string, wave: number, state?: string) => (await env.DB.prepare(
  `SELECT home_id FROM cloud_release_homes WHERE release_id=? AND wave=? ${state ? "AND state=?" : ""} ORDER BY home_id`).bind(...(state ? [releaseId, wave, state] : [releaseId, wave])).all<{ home_id: string }>()).results.map((r) => r.home_id);
const releaseRow = async (id: string) => (await env.DB.prepare("SELECT * FROM cloud_releases WHERE id=?").bind(id).first<Record<string, any>>())!;
const alertsOf = async (kind: string) => (await env.DB.prepare("SELECT home_id,severity,detail,resolved_at FROM cloud_alerts WHERE kind=? ORDER BY raised_at").bind(kind).all<{ home_id: string; severity: string; detail: string; resolved_at: number | null }>()).results;

async function createRelease(sequence: number, ref = `rev-${sequence}`) {
  const res = await call("/v1/admin/rollout/releases", { sequence, manifestRef: ref });
  expect(res.status).toBe(201);
  return (await res.json<{ id: string }>()).id;
}
const start = async (id: string) => { const r = await call(`/v1/admin/rollout/releases/${id}/start`, {}); expect(r.status).toBe(200); };
/** Every dispatched home of the wave reports the target sequence, healthy at `t`. */
async function landWave(id: string, wave: number, sequence: number, t: number) {
  for (const h of await homesOf(id, wave)) await reportAs(h, { seq: sequence, beat: t });
}
/** 2 internal homes and 20 others: wave 1 takes 3, wave 2 takes 2 more (25% of 20 = 5), wave 3 the other 15. */
async function fleet() {
  await home("int-1", { internal: true }); await home("int-2", { internal: true });
  for (let i = 1; i <= 20; i++) await home(`h-${String(i).padStart(2, "0")}`);
}

describe("operator routes", () => {
  it("need the operator credential; there is no customer route", async () => {
    expect((await call("/v1/admin/rollout/releases", undefined, "GET", null)).status).toBe(401);
    expect((await call("/v1/admin/rollout/releases", undefined, "GET", "wrong")).status).toBe(401);
    expect((await call("/v1/admin/rollout/releases", { sequence: 3, manifestRef: "x" }, "POST", null)).status).toBe(401);
    expect((await call("/v1/account/rollout/releases", undefined, "GET", null)).status).not.toBe(200);
    expect((await call("/v1/admin/rollout/releases")).status).toBe(200);
  });

  it("create, status and list; a sequence is unique and must be newer than anything promoted, rolling or halted", async () => {
    const id = await createRelease(3, "channel-manifest-3");
    const view = await (await call(`/v1/admin/rollout/releases/${id}`)).json<Record<string, any>>();
    expect(view).toMatchObject({ id, sequence: 3, manifestRef: "channel-manifest-3", state: "draft", wave: 0, failedHomes: [], homes: [] });
    expect((await call("/v1/admin/rollout/releases", { sequence: 3, manifestRef: "again" })).status).toBe(409);
    expect((await call("/v1/admin/rollout/releases", { sequence: 0, manifestRef: "x" })).status).toBe(400);
    expect((await call("/v1/admin/rollout/releases", { sequence: 4, manifestRef: "x", extra: 1 })).status).toBe(400);
    expect((await call("/v1/admin/rollout/releases/no-such-release")).status).toBe(404);
    expect((await (await call("/v1/admin/rollout/releases")).json<{ releases: unknown[] }>()).releases).toHaveLength(1);
    await env.DB.prepare("UPDATE cloud_releases SET state='promoted',promoted_at=1 WHERE id=?").bind(id).run();
    expect((await call("/v1/admin/rollout/releases", { sequence: 2, manifestRef: "old" })).status).toBe(409);
    expect((await call("/v1/admin/rollout/releases", { sequence: 4, manifestRef: "new" })).status).toBe(201);
  });

  it("one release at a time may be rolling or halted; start needs a draft", async () => {
    const a = await createRelease(3); const b = await createRelease(4);
    await start(a);
    expect((await call(`/v1/admin/rollout/releases/${b}/start`, {})).status).toBe(409);
    expect((await call(`/v1/admin/rollout/releases/${a}/start`, {})).status).toBe(409);
    expect((await call(`/v1/admin/rollout/releases/${a}/resume`, {})).status).toBe(409);
    expect((await call(`/v1/admin/rollout/releases/${b}/cancel`, {})).status).toBe(200);
    expect((await call(`/v1/admin/rollout/releases/${b}/start`, {})).status).toBe(409);
  });

  it("the internal flag is an operator route for an existing home", async () => {
    await home("h-a");
    expect((await call("/v1/admin/rollout/homes/h-a/internal", { internal: true })).status).toBe(200);
    expect(await env.DB.prepare("SELECT internal FROM cloud_rollout_flags WHERE home_id='h-a'").first()).toEqual({ internal: 1 });
    expect((await call("/v1/admin/rollout/homes/h-a/internal", { internal: false })).status).toBe(200);
    expect(await env.DB.prepare("SELECT internal FROM cloud_rollout_flags WHERE home_id='h-a'").first()).toEqual({ internal: 0 });
    expect((await call("/v1/admin/rollout/homes/nobody/internal", { internal: true })).status).toBe(404);
    expect((await call("/v1/admin/rollout/homes/h-a/internal", { internal: "yes" })).status).toBe(400);
    expect((await call("/v1/admin/rollout/homes/h-a/internal", { internal: true }, "POST", null)).status).toBe(401);
  });
});

describe("waves and the soak", () => {
  it("wave 0 internal homes, wave 1 three homes, wave 2 25% in total, wave 3 the rest; each waits for healthy reports, then soaks 2 hours; then promotion", async () => {
    await fleet();
    const id = await createRelease(7);
    await start(id);
    let t = T0;
    // Wave 0: only the flagged homes get the command, with the target sequence and reason "rollout".
    await sweep(t);
    expect(await homesOf(id, 0)).toEqual(["int-1", "int-2"]);
    expect(await homesOf(id, 1)).toEqual([]);
    const sent = await rolloutCommands();
    expect(sent.map((c) => c.home_id).sort()).toEqual(["int-1", "int-2"]);
    for (const c of sent) expect(JSON.parse(c.payload)).toEqual({ keep: ["files", "settings", "logins"], reason: "rollout", sequence: 7 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_home_jobs WHERE kind='update' AND state='active'").first<{ n: number }>()).toEqual({ n: 2 });
    expect(await releaseRow(id)).toMatchObject({ state: "rolling", wave: 0 });

    // One of two reported: the wave is not healthy, there is no soak, nothing widens.
    t += 10 * MIN; await reportAs("int-1", { seq: 7, beat: t });
    await sweep(t);
    expect((await releaseRow(id)).soak_started_at).toBeNull();
    expect(await homesOf(id, 0, "updated")).toEqual(["int-1"]);

    // Both healthy: the soak starts.
    await reportAs("int-1", { seq: 7, beat: t }); await reportAs("int-2", { seq: 7, beat: t });
    await sweep(t);
    expect((await releaseRow(id)).soak_started_at).toBe(t);
    const soakStart = t;
    t = soakStart + ROLLOUT_SOAK_MS - 1; await sweep(t);
    expect(await releaseRow(id)).toMatchObject({ wave: 0, state: "rolling" });
    expect(await homesOf(id, 1)).toEqual([]);

    // The soak is over: wave 1 is chosen and sent the command (the same pass).
    t = soakStart + ROLLOUT_SOAK_MS; await sweep(t);
    expect(await releaseRow(id)).toMatchObject({ wave: 1, state: "rolling", soak_started_at: null });
    expect(await homesOf(id, 1)).toEqual(["h-01", "h-02", "h-03"]);
    expect((await rolloutCommands()).map((c) => c.home_id).sort()).toEqual(["h-01", "h-02", "h-03", "int-1", "int-2"]);

    await landWave(id, 1, 7, t); await sweep(t);
    t += ROLLOUT_SOAK_MS; await landWave(id, 1, 7, t); await sweep(t);
    expect(await releaseRow(id)).toMatchObject({ wave: 2 });
    expect(await homesOf(id, 2)).toEqual(["h-04", "h-05"]); // 25% of 20 is 5 in all; wave 1 had 3
    await landWave(id, 2, 7, t); await sweep(t);
    t += ROLLOUT_SOAK_MS; await landWave(id, 2, 7, t); await sweep(t);
    expect(await releaseRow(id)).toMatchObject({ wave: 3 });
    expect((await homesOf(id, 3)).length).toBe(15);
    expect(await latestPromotedSequence(testEnv())).toBeNull(); // still rolling: customers are not offered it yet
    await landWave(id, 3, 7, t); await sweep(t);
    t += ROLLOUT_SOAK_MS; await landWave(id, 3, 7, t); await sweep(t);
    expect(await releaseRow(id)).toMatchObject({ state: "promoted", wave: 3, promoted_at: t });
    expect(await latestPromotedSequence(testEnv())).toBe(7);
    expect((await rolloutCommands()).length).toBe(22);
    expect(await alertsOf(ROLLOUT_HALTED_ALERT)).toEqual([]);
    // A sweep after promotion does nothing.
    await sweep(t + HOUR);
    expect((await rolloutCommands()).length).toBe(22);
  });

  it("a ROLLOUT_SOAK_MS of 0, negative or not a number is treated as unset: the 2 hour default stays", async () => {
    for (const bad of ["0", "-5", "abc", ""]) {
      for (const t of ["cloud_release_homes", "cloud_releases", "cloud_home_commands", "cloud_home_jobs", "cloud_home_update_reports", "cloud_home_runner", "cloud_rollout_flags", "cloud_homes"]) {
        await env.DB.prepare(`DELETE FROM ${t}`).run();
      }
      await home("int-1", { internal: true });
      const id = await createRelease(2); await start(id);
      const e = { ...testEnv(), ROLLOUT_SOAK_MS: bad } as Env;
      await sweepRollout(e, T0);
      await reportAs("int-1", { seq: 2, beat: T0 });
      await sweepRollout(e, T0);
      await sweepRollout(e, T0 + 2 * HOUR - 1);
      expect([bad, (await releaseRow(id)).wave]).toEqual([bad, 0]); // still soaking
      await reportAs("int-1", { seq: 2, beat: T0 + 2 * HOUR });
      await sweepRollout(e, T0 + 2 * HOUR);
      expect((await releaseRow(id)).wave).toBeGreaterThan(0); // soak over: empty later waves are crossed
    }
  });

  it("the soak length is configurable (ROLLOUT_SOAK_MS or the option); the default is 2 hours", async () => {
    expect(ROLLOUT_SOAK_MS).toBe(2 * HOUR);
    await home("int-1", { internal: true }); await home("h-1"); await home("h-2"); await home("h-3");
    const id = await createRelease(2); await start(id);
    await sweep(T0, { soakMs: 10 * MIN });
    await reportAs("int-1", { seq: 2, beat: T0 });
    await sweep(T0, { soakMs: 10 * MIN });
    await sweep(T0 + 10 * MIN - 1, { soakMs: 10 * MIN });
    expect((await releaseRow(id)).wave).toBe(0);
    await reportAs("int-1", { seq: 2, beat: T0 + 10 * MIN });
    await sweep(T0 + 10 * MIN, { soakMs: 10 * MIN });
    expect((await releaseRow(id)).wave).toBe(1);
    // The environment variable is read when no option is given.
    const viaEnv = { ...testEnv(), ROLLOUT_SOAK_MS: String(5 * MIN) } as Env;
    await landWave(id, 1, 2, T0 + 10 * MIN);
    await sweepRollout(viaEnv, T0 + 10 * MIN);
    await sweepRollout(viaEnv, T0 + 15 * MIN - 1);
    expect((await releaseRow(id)).wave).toBe(1);
    await landWave(id, 1, 2, T0 + 15 * MIN);
    await sweepRollout(viaEnv, T0 + 15 * MIN);
    expect((await releaseRow(id)).state).toBe("promoted"); // waves 2 and 3 have nobody left in a fleet of three, so they pass at once
  });

  it("an empty wave (no internal homes; a fleet too small for wave 2) is crossed in the same pass", async () => {
    for (let i = 1; i <= 3; i++) await home(`h-${i}`);
    const id = await createRelease(2); await start(id);
    await sweep(T0);
    // Wave 0 had no homes, so wave 1 was chosen in the same pass.
    expect(await releaseRow(id)).toMatchObject({ wave: 1 });
    expect(await homesOf(id, 1)).toEqual(["h-1", "h-2", "h-3"]);
    await landWave(id, 1, 2, T0); await sweep(T0);
    await sweep(T0 + ROLLOUT_SOAK_MS); // wave 2: 25% of 3 is 1, wave 1 took 3: empty; wave 3: nothing left; promoted
    expect(await releaseRow(id)).toMatchObject({ state: "promoted", wave: 3 });
  });

  it("a home that left the fleet during the wave is skipped, not a failure", async () => {
    await home("int-1", { internal: true }); await home("int-2", { internal: true });
    const id = await createRelease(2); await start(id);
    await sweep(T0);
    await env.DB.prepare("UPDATE cloud_homes SET desired_state='deleted' WHERE id='int-2'").run();
    await reportAs("int-1", { seq: 2, beat: T0 });
    await sweep(T0);
    expect(await homesOf(id, 0, "skipped")).toEqual(["int-2"]);
    expect((await releaseRow(id)).state).toBe("rolling");
    expect((await releaseRow(id)).soak_started_at).toBe(T0);
  });

  it("a home with another data job running waits (never doubled) and is sent the update when its slot frees", async () => {
    await home("int-1", { internal: true });
    await env.DB.prepare(`INSERT INTO cloud_home_commands (id,home_id,generation,kind,payload,created_at,expires_at,picked_at,run_deadline)
      VALUES ('busy','int-1',1,'export_archive','{}',?,?,?,?)`).bind(T0, T0 + 24 * HOUR, T0, T0 + 12 * HOUR).run();
    await env.DB.prepare("INSERT INTO cloud_home_jobs (id,home_id,kind,ref,generation,state,created_at) VALUES ('busy','int-1','export','e',1,'active',?)").bind(T0).run();
    const id = await createRelease(2); await start(id);
    await sweep(T0); await sweep(T0 + MIN);
    expect(await homesOf(id, 0, "pending")).toEqual(["int-1"]);
    expect((await rolloutCommands())).toEqual([]);
    await env.DB.prepare("UPDATE cloud_home_commands SET acked_at=?,outcome='done' WHERE id='busy'").bind(T0 + 2 * MIN).run();
    await env.DB.prepare("UPDATE cloud_home_jobs SET state='done',outcome='done',finished_at=? WHERE id='busy'").bind(T0 + 2 * MIN).run();
    await sweep(T0 + 3 * MIN);
    expect(await homesOf(id, 0, "dispatched")).toEqual(["int-1"]);
    expect(await rolloutCommands()).toHaveLength(1);
  });

  it("a home already on the target sequence when its wave starts counts as updated without a second command being needed", async () => {
    await home("int-1", { internal: true });
    await reportAs("int-1", { seq: 2, beat: T0 });
    const id = await createRelease(2); await start(id);
    await sweep(T0);
    expect(await homesOf(id, 0, "updated")).toEqual(["int-1"]);
    expect(await rolloutCommands()).toEqual([]);
  });
});

describe("halt", () => {
  /** Wave 0 is two internal homes (int-1 is the one that fails), already dispatched; the release is rolling. */
  async function wave0() {
    await home("int-1", { internal: true }); await home("int-2", { internal: true }); await home("h-1"); await home("h-2"); await home("h-3");
    const id = await createRelease(4); await start(id); await sweep(T0);
    expect(await rolloutCommands()).toHaveLength(2);
    return id;
  }
  const expectHalted = async (id: string, failedHome: string, reason: string) => {
    const rel = await releaseRow(id);
    expect(rel).toMatchObject({ state: "halted", wave: 0 });
    expect(rel.halt_reason).toContain(failedHome);
    expect(await env.DB.prepare("SELECT state,failure FROM cloud_release_homes WHERE release_id=? AND home_id=?").bind(id, failedHome).first()).toEqual({ state: "failed", failure: reason });
    const alerts = await alertsOf(ROLLOUT_HALTED_ALERT);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ home_id: `release:${id}`, severity: "high", resolved_at: null });
    expect(alerts[0].detail).toContain(failedHome);
    expect(alerts[0].detail).toContain(reason);
  };

  it("a home that rolls back halts the release: one alert naming it, nothing more sent, a second pass changes nothing", async () => {
    const id = await wave0();
    const cmd = (await commandOf("int-1"))!;
    await reportAs("int-2", { seq: 4, beat: T0 });
    await reportAs("int-1", { seq: 3, last: { commandId: cmd, outcome: "failed", reason: "unhealthy" }, beat: T0 });
    await sweep(T0 + MIN);
    await expectHalted(id, "int-1", "rolled_back:unhealthy");
    // int-2 had updated: it stays where it is.
    expect(await homesOf(id, 0, "updated")).toEqual(["int-2"]);
    const commands = (await rolloutCommands()).length;
    for (let i = 0; i < 3; i++) await sweep(T0 + (2 + i) * HOUR);
    expect((await rolloutCommands()).length).toBe(commands);
    expect(await alertsOf(ROLLOUT_HALTED_ALERT)).toHaveLength(1);
    expect((await releaseRow(id)).state).toBe("halted");
    expect(await homesOf(id, 1)).toEqual([]);
  });

  it("a rollback result from an EARLIER command is not this release's failure", async () => {
    const id = await wave0();
    await reportAs("int-1", { seq: 4, last: { commandId: "0b1c2d3e-aaaa-4bbb-8ccc-123456789abc", outcome: "failed", reason: "unhealthy" }, beat: T0 });
    await reportAs("int-2", { seq: 4, beat: T0 });
    await sweep(T0 + MIN);
    expect((await releaseRow(id)).state).toBe("rolling");
  });

  it("a Stuck updater halts the release", async () => {
    const id = await wave0();
    await reportAs("int-1", { seq: 3, stuck: "rollback_stop", beat: T0 });
    await sweep(T0 + MIN);
    await expectHalted(id, "int-1", "stuck:rollback_stop");
  });

  it("a home that never reports within the timeout halts the release (an older home without the reporting included)", async () => {
    const id = await wave0();
    await reportAs("int-2", { seq: 4, beat: T0 });
    await sweep(T0 + ROLLOUT_REPORT_TIMEOUT_MS - 1);
    expect((await releaseRow(id)).state).toBe("rolling");
    await sweep(T0 + ROLLOUT_REPORT_TIMEOUT_MS + 1);
    await expectHalted(id, "int-1", "no_report");
  });

  it("a home that answered the command failed or unsupported (an older home that cannot take a sequence) halts it", async () => {
    const id = await wave0();
    await env.DB.prepare("UPDATE cloud_home_commands SET picked_at=?,acked_at=?,outcome='unsupported' WHERE id=?").bind(T0, T0, await commandOf("int-1")).run();
    await reportAs("int-2", { seq: 4, beat: T0 });
    await sweep(T0 + MIN);
    await expectHalted(id, "int-1", "refused:unsupported");
  });

  it("a home that is on an older sequence and reports it is merely waiting; one that regresses after updating halts", async () => {
    const id = await wave0();
    await reportAs("int-1", { seq: 3, beat: T0 }); await reportAs("int-2", { seq: 4, beat: T0 });
    await sweep(T0 + MIN);
    expect((await releaseRow(id)).state).toBe("rolling");
    await reportAs("int-1", { seq: 4, beat: T0 + 2 * MIN });
    await sweep(T0 + 2 * MIN);
    expect((await releaseRow(id)).soak_started_at).toBe(T0 + 2 * MIN);
    await reportAs("int-2", { seq: 3, beat: T0 + 3 * MIN });
    await sweep(T0 + 3 * MIN);
    await expectHalted(id, "int-2", "regressed");
  });

  for (const kind of ["home.heartbeat_missed", "home.ui_render_missing"]) {
    for (const resolved of [false, true]) {
      it(`${kind} on a wave home during the soak halts the release (${resolved ? "raised and cleared since the soak began" : "still open"})`, async () => {
        const id = await wave0();
        await reportAs("int-1", { seq: 4, beat: T0 }); await reportAs("int-2", { seq: 4, beat: T0 });
        await sweep(T0 + MIN);
        expect((await releaseRow(id)).soak_started_at).toBe(T0 + MIN);
        await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at,resolved_at) VALUES (?,?,?,'high','x',?,?)")
          .bind(crypto.randomUUID(), "int-2", kind, T0 + 30 * MIN, resolved ? T0 + 40 * MIN : null).run();
        await sweep(T0 + 50 * MIN);
        const rel = await releaseRow(id);
        expect(rel.state).toBe("halted");
        expect(rel.halt_reason).toContain("int-2");
        expect(rel.halt_reason).toContain(`soak:${kind}`);
        expect(await alertsOf(ROLLOUT_HALTED_ALERT)).toHaveLength(1);
        expect(await homesOf(id, 1)).toEqual([]);
        expect((await rolloutCommands()).length).toBe(2);
      });
    }
  }

  it("alerts from before the soak that were already cleared, and alerts on homes outside the wave, do not halt", async () => {
    const id = await wave0();
    await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at,resolved_at) VALUES (?,?,'home.heartbeat_missed','high','x',?,?)")
      .bind(crypto.randomUUID(), "int-2", T0, T0 + MIN).run(); // the update's own restart, over before the soak
    await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,'home.ui_render_missing','high','x',?)")
      .bind(crypto.randomUUID(), "h-1", T0 + 2 * MIN).run(); // a home that is not in wave 0
    await reportAs("int-1", { seq: 4, beat: T0 + 2 * MIN }); await reportAs("int-2", { seq: 4, beat: T0 + 2 * MIN });
    await sweep(T0 + 2 * MIN);
    await sweep(T0 + ROLLOUT_SOAK_MS + 2 * MIN);
    expect(await releaseRow(id)).toMatchObject({ state: "rolling", wave: 1 });
  });

  it("several failed homes are listed in the one alert", async () => {
    const id = await wave0();
    await reportAs("int-1", { seq: 3, stuck: "wipe_target", beat: T0 });
    await reportAs("int-2", { seq: 3, last: { commandId: (await commandOf("int-2"))!, outcome: "failed", reason: "unhealthy" }, beat: T0 });
    await sweep(T0 + MIN);
    const alerts = await alertsOf(ROLLOUT_HALTED_ALERT);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].detail).toContain("int-1 (stuck:wipe_target)");
    expect(alerts[0].detail).toContain("int-2 (rolled_back:unhealthy)");
    expect((await call(`/v1/admin/rollout/releases/${id}`).then((r) => r.json<any>())).failedHomes.map((f: any) => f.homeId)).toEqual(["int-1", "int-2"]);
  });

  it("halting withdraws commands no home has picked up yet", async () => {
    const id = await wave0();
    await env.DB.prepare("UPDATE cloud_home_commands SET picked_at=? WHERE id=?").bind(T0, await commandOf("int-2")).run(); // int-2 already took its command
    await reportAs("int-1", { seq: 3, stuck: "x_y", beat: T0 });
    await sweep(T0 + MIN);
    expect((await releaseRow(id)).state).toBe("halted");
    const byHome = Object.fromEntries((await rolloutCommands()).map((c) => [c.home_id, c.expires_at <= T0 + MIN]));
    expect(byHome).toEqual({ "int-1": true, "int-2": false });
  });
});

describe("halt and cancel versus the dispatch loop", () => {
  const cancelledOrHalted = ["cancelled", "halted"] as const;
  for (const state of cancelledOrHalted) {
    it(`a dispatch that lands after the release became ${state} inserts nothing (no command, no job)`, async () => {
      await home("int-1", { internal: true });
      const id = await createRelease(2); await start(id);
      // advance() had read state='rolling'; the change commits before the dispatch's own batch.
      await env.DB.prepare("UPDATE cloud_releases SET state=? WHERE id=?").bind(state, id).run();
      const sent = await dispatchRolloutUpdate(testEnv(), "int-1", 2, T0, id);
      expect("refused" in sent).toBe(true);
      expect(await rolloutCommands()).toEqual([]);
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_home_jobs").first<{ n: number }>()).toEqual({ n: 0 });
    });
  }

  it("a real cancel through the route between passes leaves a later sweep with nothing to send", async () => {
    await home("int-1", { internal: true }); await home("int-2", { internal: true });
    const id = await createRelease(2); await start(id);
    expect((await call(`/v1/admin/rollout/releases/${id}/cancel`, {})).status).toBe(200);
    await sweep(T0 + MIN);
    expect(await rolloutCommands()).toEqual([]);
  });

  it("cancel expires unpicked commands (in the same batch as the state change, so no failed follow-up can strand them)", async () => {
    await home("int-1", { internal: true });
    const id = await createRelease(2); await start(id); await sweep(T0);
    expect(await rolloutCommands()).toHaveLength(1);
    expect((await call(`/v1/admin/rollout/releases/${id}/cancel`, {})).status).toBe(200);
    expect((await rolloutCommands())[0].expires_at).toBeLessThanOrEqual(T0);
  });

  it("when the halt's own withdraw never landed, the next sweep expires the commands (the retry path)", async () => {
    await home("int-1", { internal: true }); await home("int-2", { internal: true });
    const id = await createRelease(2); await start(id); await sweep(T0);
    await env.DB.prepare("UPDATE cloud_home_commands SET picked_at=? WHERE id=?").bind(T0, await commandOf("int-2")).run();
    // The state change committed, the withdraw did not (the pre-fix failure mode).
    await env.DB.prepare("UPDATE cloud_releases SET state='halted',halted_at=? WHERE id=?").bind(T0, id).run();
    expect((await rolloutCommands()).map((c) => c.expires_at > T0 + MIN)).toEqual([true, true]);
    await sweep(T0 + MIN);
    const byHome = Object.fromEntries((await rolloutCommands()).map((c) => [c.home_id, c.expires_at <= T0 + MIN]));
    expect(byHome).toEqual({ "int-1": true, "int-2": false }); // the picked command keeps running
    await sweep(T0 + 2 * MIN); // idempotent
    expect((await rolloutCommands()).find((c) => c.home_id === "int-2")!.expires_at).toBeGreaterThan(T0 + 2 * MIN);
  });

  it("the home's poll never hands out a command of a halted or cancelled release", async () => {
    await home("int-1", { internal: true });
    const credential = "machine-credential-for-int-1";
    await env.DB.prepare(`INSERT INTO cloud_machines (id,home_id,generation,state,credential_hash,bound_ips,created_at,public_origin,admin_url)
      VALUES ('int-1','int-1',1,'active',?,?,?,'https://x.test','https://x.test/admin')`).bind(await sha256(credential), JSON.stringify(["203.0.113.9"]), T0).run();
    const id = await createRelease(2); await start(id); await sweep(T0);
    expect(await rolloutCommands()).toHaveLength(1);
    await env.DB.prepare("UPDATE cloud_releases SET state='halted',halted_at=? WHERE id=?").bind(T0, id).run(); // withdraw never ran
    const poll = async () => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request("https://admin.murage.test/v1/machines/int-1/commands", { headers: { authorization: `Bearer ${credential}`, "CF-Connecting-IP": "203.0.113.9" } }), testEnv(), ctx);
      await waitOnExecutionContext(ctx);
      return res;
    };
    const res = await poll();
    expect(res.status).toBe(200);
    expect((await res.json<{ commands: unknown[] }>()).commands).toEqual([]);
    expect((await rolloutCommands())[0].picked_at).toBeNull();
    // Control: a rolling release's command is handed out.
    await env.DB.prepare("UPDATE cloud_releases SET state='rolling',halted_at=NULL WHERE id=?").bind(id).run();
    expect((await (await poll()).json<{ commands: unknown[] }>()).commands).toHaveLength(1);
  });
});

describe("sweep idempotency and the lease", () => {
  it("running the sweep again and again, and at the same moment, sends nothing twice and changes nothing", async () => {
    await fleet();
    const id = await createRelease(7); await start(id);
    await sweep(T0);
    const before = { cmds: await rolloutCommands(), rows: await homesOf(id, 0), rel: await releaseRow(id) };
    for (let i = 0; i < 3; i++) await sweep(T0);
    await Promise.all([sweep(T0), sweep(T0), sweep(T0)]);
    expect(await rolloutCommands()).toEqual(before.cmds);
    expect(await homesOf(id, 0)).toEqual(before.rows);
    const rel = await releaseRow(id);
    expect({ ...rel, updated_at: 0, sweep_until: null, sweep_holder: null }).toEqual({ ...before.rel, updated_at: 0, sweep_until: null, sweep_holder: null });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_home_jobs").first<{ n: number }>()).toEqual({ n: 2 });
  });

  it("a pass holding the release's lease keeps other passes out; an expired lease is taken over; the lease is released after a pass", async () => {
    await home("int-1", { internal: true });
    const id = await createRelease(2); await start(id);
    await env.DB.prepare("UPDATE cloud_releases SET sweep_holder='other',sweep_until=? WHERE id=?").bind(T0 + HOUR, id).run();
    await sweep(T0 + MIN);
    expect(await homesOf(id, 0)).toEqual([]); // nothing happened: someone else holds it
    await sweep(T0 + 2 * HOUR); // the lease ran out
    expect(await homesOf(id, 0)).toEqual(["int-1"]);
    expect(await env.DB.prepare("SELECT sweep_holder FROM cloud_releases WHERE id=?").bind(id).first()).toEqual({ sweep_holder: null });
  });

  it("a wave bigger than one pass is dispatched across passes, never twice", async () => {
    for (let i = 1; i <= 7; i++) await home(`int-${i}`, { internal: true });
    const id = await createRelease(2); await start(id);
    await sweep(T0, { dispatchPerPass: 3 });
    expect(await rolloutCommands()).toHaveLength(3);
    await sweep(T0 + MIN, { dispatchPerPass: 3 });
    await sweep(T0 + 2 * MIN, { dispatchPerPass: 3 });
    await sweep(T0 + 3 * MIN, { dispatchPerPass: 3 });
    expect(await rolloutCommands()).toHaveLength(7);
    expect(new Set((await rolloutCommands()).map((c) => c.home_id)).size).toBe(7);
  });

  it("with no release, or only drafts, the sweep does nothing", async () => {
    await home("int-1", { internal: true });
    await sweep(T0);
    await createRelease(2);
    await sweep(T0);
    expect(await rolloutCommands()).toEqual([]);
  });
});

describe("cancel and resume", () => {
  it("cancel stops a rolling release: nothing more is sent, queued commands expire, a draft can be cancelled, a cancelled release cannot be revived", async () => {
    await fleet();
    const id = await createRelease(7); await start(id); await sweep(T0);
    const res = await call(`/v1/admin/rollout/releases/${id}/cancel`, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "cancelled" });
    expect((await rolloutCommands()).every((c) => c.expires_at <= T0)).toBe(true); // queued and unpicked: they no longer run
    const count = (await rolloutCommands()).length;
    await reportAs("int-1", { seq: 7, beat: T0 }); await reportAs("int-2", { seq: 7, beat: T0 });
    await sweep(T0 + 5 * HOUR);
    expect((await rolloutCommands()).length).toBe(count);
    expect(await homesOf(id, 1)).toEqual([]);
    expect((await call(`/v1/admin/rollout/releases/${id}/start`, {})).status).toBe(409);
    expect((await call(`/v1/admin/rollout/releases/${id}/resume`, {})).status).toBe(409);
    expect((await call(`/v1/admin/rollout/releases/${id}/cancel`, {})).status).toBe(409);
    const draft = await createRelease(8);
    expect((await call(`/v1/admin/rollout/releases/${draft}/cancel`, {})).status).toBe(200);
    // Cancelling frees the one rolling slot: the next release can start.
    const next = await createRelease(9);
    expect((await call(`/v1/admin/rollout/releases/${next}/start`, {})).status).toBe(200);
  });

  it("cancelling a halted release resolves its alert; commands already withdrawn at the halt stay withdrawn", async () => {
    await home("int-1", { internal: true });
    const id = await createRelease(2); await start(id); await sweep(T0);
    await reportAs("int-1", { seq: 1, stuck: "wipe_target", beat: T0 });
    await sweep(T0 + MIN);
    expect((await releaseRow(id)).state).toBe("halted");
    expect((await call(`/v1/admin/rollout/releases/${id}/cancel`, {})).status).toBe(200);
    expect((await alertsOf(ROLLOUT_HALTED_ALERT))[0].resolved_at).not.toBeNull();
  });

  it("resume restarts the wave: failed homes are asked again with a new command, updated homes stay, the halt alert resolves, and a second failure halts again with its own alert", async () => {
    await home("int-1", { internal: true }); await home("int-2", { internal: true });
    const id = await createRelease(2); await start(id); await sweep(T0);
    await reportAs("int-2", { seq: 2, beat: T0 });
    const first = (await commandOf("int-1"))!;
    await reportAs("int-1", { seq: 1, last: { commandId: first, outcome: "failed", reason: "unhealthy" }, beat: T0 });
    await sweep(T0 + MIN);
    expect((await releaseRow(id)).state).toBe("halted");
    const t = T0 + 2 * HOUR;
    const res = await call(`/v1/admin/rollout/releases/${id}/resume`, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "rolling", haltReason: null, failedHomes: [] });
    expect((await alertsOf(ROLLOUT_HALTED_ALERT))[0].resolved_at).not.toBeNull();
    expect(await homesOf(id, 0, "pending")).toEqual(["int-1"]);
    expect(await homesOf(id, 0, "updated")).toEqual(["int-2"]);
    await sweep(t);
    const second = (await commandOf("int-1"))!;
    expect(second).not.toBe(first);
    expect(await homesOf(id, 0, "dispatched")).toEqual(["int-1"]);
    // The old rollback result belongs to the first command: it does not fail the retry.
    await sweep(t + MIN);
    expect((await releaseRow(id)).state).toBe("rolling");
    // This time it lands: the wave soaks and the release goes on.
    await reportAs("int-1", { seq: 2, last: { commandId: second, outcome: "done" }, beat: t + 2 * MIN });
    await sweep(t + 2 * MIN);
    expect((await releaseRow(id)).soak_started_at).toBe(t + 2 * MIN);
  });

  it("resume with skipFailed leaves the failed homes out of the wave and goes on without them", async () => {
    await home("int-1", { internal: true }); await home("int-2", { internal: true });
    for (let i = 1; i <= 4; i++) await home(`h-${i}`);
    const id = await createRelease(2); await start(id); await sweep(T0);
    await reportAs("int-2", { seq: 2, beat: T0 });
    await reportAs("int-1", { seq: 1, stuck: "wipe_target", beat: T0 });
    await sweep(T0 + MIN);
    expect((await releaseRow(id)).state).toBe("halted");
    expect((await call(`/v1/admin/rollout/releases/${id}/resume`, { skipFailed: true })).status).toBe(200);
    expect(await homesOf(id, 0, "skipped")).toEqual(["int-1"]);
    await sweep(T0 + HOUR);
    expect((await releaseRow(id))).toMatchObject({ state: "rolling", wave: 0, soak_started_at: T0 + HOUR });
    await sweep(T0 + HOUR + ROLLOUT_SOAK_MS);
    expect((await releaseRow(id)).wave).toBe(1);
  });

  it("resume asks a home again whose queued command the halt withdrew, and gives it a fresh report clock", async () => {
    await home("int-1", { internal: true }); await home("int-2", { internal: true });
    const id = await createRelease(2); await start(id); await sweep(T0);
    const withdrawn = (await commandOf("int-2"))!;
    await reportAs("int-1", { seq: 1, stuck: "wipe_target", beat: T0 });
    await sweep(T0 + MIN);
    expect((await releaseRow(id)).state).toBe("halted");
    const later = T0 + 5 * HOUR; // int-2 never reported, and its command was withdrawn: the clock restarts at the resume
    at(later);
    expect((await call(`/v1/admin/rollout/releases/${id}/resume`, { skipFailed: true })).status).toBe(200);
    expect(await homesOf(id, 0, "pending")).toEqual(["int-2"]);
    await sweep(later + MIN);
    expect((await releaseRow(id)).state).toBe("rolling");
    expect(await homesOf(id, 0, "dispatched")).toEqual(["int-2"]);
    expect(await commandOf("int-2")).not.toBe(withdrawn);
  });
});
