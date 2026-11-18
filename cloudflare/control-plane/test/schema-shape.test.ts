// SPDX-License-Identifier: AGPL-3.0-or-later
// The schema the migrations build is the schema the code reads. Staging once applied an older 0037 that was later
// edited in place (supabase_identities kept `email_iat NOT NULL` and lacked `email_conflict`); 0083 repairs it.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

type Col = { name: string; type: string; nn: number; dflt_value: string | null; pk: number };
const columns = async (table: string) =>
  (await env.DB.prepare(`SELECT name,type,"notnull" AS nn,dflt_value,pk FROM pragma_table_info('${table}') ORDER BY cid`).all<Col>()).results;
const migrations = () => (env as unknown as { TEST_MIGRATIONS: { name: string; queries: string[] }[] }).TEST_MIGRATIONS;

const BASE_IDENTITY_COLUMNS = ["sub", "user_id", "via", "created_at", "email_conflict", "email_revision", "contact_email"];
/** 0141 (FLUX-ENSURE-EMAIL-VERIFIED) adds the inbox proof: when, and for which address. */
const IDENTITY_COLUMNS = [...BASE_IDENTITY_COLUMNS, "email_verified_at", "email_verified_for", "win_token"];
const LINK_EVENT_COLUMNS = ["id", "sub", "user_id", "email", "kind", "at"];

describe("migrated schema shape", () => {
  it("0131: checkout_consents keeps the country Stripe collected for a refused order, nullable, and the migration adds only that column", async () => {
    const col = (await columns("checkout_consents")).find((c) => c.name === "rejected_collected_country");
    expect(col).toMatchObject({ type: "TEXT", nn: 0, dflt_value: null });
    const m = migrations().find((x) => x.name.startsWith("0131"))!;
    expect(m.name).toBe("0131_checkout_rejected_country.sql");
    expect(m.queries.map((q) => q.replace(/\s+/g, " ").trim())).toEqual(["ALTER TABLE checkout_consents ADD COLUMN rejected_collected_country TEXT"]);
  });

  it("0142: flux_first_key_retry holds a typed hold with failures 0, and a real failure still needs failures >= 1", async () => {
    expect((await columns("flux_first_key_retry")).map((c) => c.name)).toEqual(["home_id", "failures", "next_at", "updated_at", "hold"]);
    await env.DB.prepare("INSERT INTO flux_first_key_retry (home_id,failures,next_at,updated_at,hold) VALUES ('shape-h',0,1,1,'email_unverified')").run();
    await expect(env.DB.prepare("INSERT INTO flux_first_key_retry (home_id,failures,next_at,updated_at) VALUES ('shape-r',0,1,1)").run()).rejects.toThrow();
    await expect(env.DB.prepare("INSERT INTO flux_first_key_retry (home_id,failures,next_at,updated_at,hold) VALUES ('shape-x',1,1,1,'other')").run()).rejects.toThrow();
    await env.DB.prepare("DELETE FROM flux_first_key_retry WHERE home_id='shape-h'").run();
  });

  it("supabase_identities has exactly the expected columns, no email_iat", async () => {
    const cols = await columns("supabase_identities");
    expect(cols.map((c) => c.name)).toEqual(IDENTITY_COLUMNS);
    expect(cols.find((c) => c.name === "email_revision")).toMatchObject({ type: "INTEGER", nn: 1, dflt_value: "0" });
    expect(cols.find((c) => c.name === "email_conflict")).toMatchObject({ type: "TEXT", nn: 0 });
    expect(cols.find((c) => c.name === "sub")!.pk).toBe(1);
    const indexes = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='supabase_identities' AND sql IS NOT NULL").all<{ name: string }>()).results;
    expect(indexes.map((i) => i.name)).toEqual(["supabase_identities_contact_email"]);
  });

  it("account_link_events has the expected columns and accepts every kind the code writes", async () => {
    expect((await columns("account_link_events")).map((c) => c.name)).toEqual(LINK_EVENT_COLUMNS);
    for (const kind of ["created", "refused_email_taken", "email_updated", "email_conflict", "email_conflict_cleared"]) {
      await env.DB.prepare("INSERT INTO account_link_events (id,sub,user_id,email,kind,at) VALUES (?,?,?,?,?,?)").bind(`shape-${kind}`, "s", null, "a@example.test", kind, 1).run();
    }
  });

  it("0083 turns staging's drifted shape (email_iat, no email_conflict) into the expected one and keeps the rows", async () => {
    const repair = migrations().find((m) => m.name.startsWith("0083"))!;
    expect(repair).toBeTruthy();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES ('shape-u','n','shape@example.test',1,0,0)`),
      env.DB.prepare("DROP TABLE supabase_identities"),
      env.DB.prepare(`CREATE TABLE supabase_identities (sub TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES "user" ("id") ON DELETE CASCADE,
        via TEXT NOT NULL CHECK (via = 'created'), created_at INTEGER NOT NULL, email_iat INTEGER NOT NULL, email_revision INTEGER NOT NULL DEFAULT 0, contact_email TEXT)`),
      env.DB.prepare("CREATE UNIQUE INDEX supabase_identities_contact_email ON supabase_identities (contact_email)"),
      env.DB.prepare("INSERT INTO supabase_identities (sub,user_id,via,created_at,email_iat,email_revision,contact_email) VALUES ('shape-s','shape-u','created',5,99,3,'shape@example.test')"),
    ]);
    expect((await columns("supabase_identities")).map((c) => c.name)).toContain("email_iat");
    await env.DB.batch(repair.queries.map((q) => env.DB.prepare(q)));
    expect((await columns("supabase_identities")).map((c) => c.name)).toEqual(BASE_IDENTITY_COLUMNS);
    expect(await env.DB.prepare("SELECT sub,user_id,via,created_at,email_conflict,email_revision,contact_email FROM supabase_identities").first()).toEqual({
      sub: "shape-s", user_id: "shape-u", via: "created", created_at: 5, email_conflict: null, email_revision: 3, contact_email: "shape@example.test",
    });
    await env.DB.prepare("UPDATE supabase_identities SET email_conflict='x@example.test' WHERE sub='shape-s'").run();
  });
});

describe("0150 flux resume via the poller (8b)", () => {
  it("adds exactly the seven nullable INTEGER columns and the two partial indexes, and nothing else", async () => {
    const cols = (await columns("flux_home_keys")).filter((c) => ["pending_lifecycle_version", "acked_lifecycle_version", "acked_generation", "resume_lv",
      "resume_from_generation", "resume_at", "stop_checked_at"].includes(c.name));
    expect(cols.map((c) => c.name)).toEqual(["pending_lifecycle_version", "acked_lifecycle_version", "acked_generation", "resume_lv", "resume_from_generation", "resume_at", "stop_checked_at"]);
    for (const c of cols) expect(c).toMatchObject({ type: "INTEGER", nn: 0, dflt_value: null });
    const idx = (await env.DB.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND name IN ('flux_home_keys_resume_open','cloud_alerts_resume_open') ORDER BY name").all<{ name: string; sql: string }>()).results;
    expect(idx.map((i) => i.name)).toEqual(["cloud_alerts_resume_open", "flux_home_keys_resume_open"]);
    expect(idx[0].sql).toMatch(/WHERE kind='flux\.resume_undelivered' AND resolved_at IS NULL/);
    expect(idx[1].sql).toMatch(/WHERE resume_lv IS NOT NULL AND acked_lifecycle_version IS NOT resume_lv/);
    const m = migrations().find((x) => x.name.startsWith("0150"))!;
    expect(m.name).toBe("0150_flux_resume_via_poller.sql");
    expect(m.queries.filter((q) => /ALTER TABLE/.test(q))).toHaveLength(7);
    // fix r2: the only data write is the step 1 acked_* backfill on active rows (step 2, the owner-resumed repair, is gone).
    const writes = m.queries.filter((q) => /\b(UPDATE|INSERT|DELETE)\b/i.test(q.replace(/--[^\n]*/g, "")));
    expect(writes).toHaveLength(1);
    expect(writes[0].replace(/--[^\n]*/g, "").trim()).toMatch(/^UPDATE flux_home_keys SET acked_lifecycle_version=lifecycle_version, acked_generation=generation WHERE state='active';?$/);
    expect(m.queries.length).toBe(7 + 2 + 1);
  });
});

describe("0110 warm pool schema", () => {
  it("creates the pool tables, the control row (grabber off, claims off) and provision_choices.pool_id", async () => {
    expect((await columns("warm_pool")).map((c) => c.name)).toContain("create_call_id");
    for (const t of ["warm_pool_deliveries", "warm_pool_stock", "warm_pool_events", "warm_pool_control"]) expect((await columns(t)).length).toBeGreaterThan(0);
    expect(await env.DB.prepare("SELECT id,grabber,claims FROM warm_pool_control").all()).toMatchObject({ results: [{ id: "pool", grabber: "off", claims: 0 }] });
    expect((await columns("provision_choices")).find((c) => c.name === "pool_id")).toMatchObject({ type: "TEXT", nn: 0 });
  });
  it("enforces one claim per home generation and one row per provider server", async () => {
    const row = (id: string, call: string, home: string | null, gen: number | null, server: string | null) =>
      env.DB.prepare(`INSERT INTO warm_pool (id,env,class,provider,server_type,arch,location,image_id,image_digest,state,create_call_id,monthly_cents,vcpus,created_at,home_id,resource_generation,server_id)
        VALUES (?,'staging','starter','hetzner','cx23','x86','fsn1','1','d','ready',?,349,2,1,?,?,?)`).bind(id, call, home, gen, server).run();
    await row("wp_1", "c1", "home-a", 1, "s1");
    await expect(row("wp_2", "c2", "home-a", 1, "s2")).rejects.toThrow();
    await expect(row("wp_3", "c3", null, null, "s1")).rejects.toThrow();
    await row("wp_4", "c4", null, null, null);
    await row("wp_5", "c5", null, null, null);
    await expect(env.DB.prepare("UPDATE warm_pool_control SET grabber='bogus'").run()).rejects.toThrow();
    await expect(env.DB.prepare("INSERT INTO warm_pool_control (id) VALUES ('other')").run()).rejects.toThrow();
  });
});
