import { describe, expect, it } from "vitest";
import { migrated } from "./d1";

describe("the relay schema", () => {
  it("deleting a device takes its bindings and their events", async () => {
    const db = migrated();
    await db.prepare("INSERT INTO relay_devices (id,platform,environment,push_token,token_hash,secret_hash,created_at,last_seen_at) VALUES ('d','ios','production','t','th','sh',1,1)").run();
    await db.prepare("INSERT INTO relay_bindings (id,device_id,grant_hash,grant_expires_at,created_at) VALUES ('b','d','g',9,1)").run();
    await db.prepare("INSERT INTO relay_events (binding_id,event_ref,revision,payload,admitted_at,expires_at,next_attempt_at) VALUES ('b','r',1,'{}',1,9,1)").run();
    await db.prepare("DELETE FROM relay_devices WHERE id='d'").run();
    expect(await db.prepare("SELECT COUNT(*) AS n FROM relay_events").first<{ n: number }>()).toEqual({ n: 0 });
  });
  it("holds no account, name or content column", () => {
    const db = migrated();
    const columns = (db.raw.prepare("SELECT sql FROM sqlite_master WHERE type='table'").all() as Array<{ sql: string }>).map((r) => r.sql).join("\n");
    expect(columns).not.toMatch(/user_id|account|title|body|thread_id|bot_id|request_id|name TEXT/i);
  });
  it("batch is all or nothing", async () => {
    const db = migrated();
    await expect(db.batch([
      db.prepare("INSERT INTO relay_settings (key,value) VALUES ('paused','0')"),
      db.prepare("INSERT INTO relay_settings (key,value) VALUES ('paused','1')"),
    ])).rejects.toThrow();
    expect(await db.prepare("SELECT COUNT(*) AS n FROM relay_settings").first<{ n: number }>()).toEqual({ n: 0 });
  });
});
