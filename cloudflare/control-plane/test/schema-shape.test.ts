// SPDX-License-Identifier: AGPL-3.0-or-later
// The schema the migrations build is the schema the code reads. Staging once applied an older 0037 that was later
// edited in place (supabase_identities kept `email_iat NOT NULL` and lacked `email_conflict`); 0083 repairs it.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

type Col = { name: string; type: string; nn: number; dflt_value: string | null; pk: number };
const columns = async (table: string) =>
  (await env.DB.prepare(`SELECT name,type,"notnull" AS nn,dflt_value,pk FROM pragma_table_info('${table}') ORDER BY cid`).all<Col>()).results;
const migrations = () => (env as unknown as { TEST_MIGRATIONS: { name: string; queries: string[] }[] }).TEST_MIGRATIONS;

const IDENTITY_COLUMNS = ["sub", "user_id", "via", "created_at", "email_conflict", "email_revision", "contact_email"];
const LINK_EVENT_COLUMNS = ["id", "sub", "user_id", "email", "kind", "at"];

describe("migrated schema shape", () => {
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
    expect((await columns("supabase_identities")).map((c) => c.name)).toEqual(IDENTITY_COLUMNS);
    expect(await env.DB.prepare("SELECT sub,user_id,via,created_at,email_conflict,email_revision,contact_email FROM supabase_identities").first()).toEqual({
      sub: "shape-s", user_id: "shape-u", via: "created", created_at: 5, email_conflict: null, email_revision: 3, contact_email: "shape@example.test",
    });
    await env.DB.prepare("UPDATE supabase_identities SET email_conflict='x@example.test' WHERE sub='shape-s'").run();
  });
});
