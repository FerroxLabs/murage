import { strict as assert } from "node:assert";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export async function permissionFixture(root: string): Promise<void> {
  assert.notEqual(process.getuid!(), 0, "fixture must have a real unprivileged uid");
  const { OpenCodeDestinationKey }: typeof import("../opencode-destination-key.ts") = await import(process.env.X4_PERMISSION_MODULE ?? "../opencode-destination-key.ts");
  const path = join(root, "account.db"), cli = join(root, "cli");
  const key = new OpenCodeDestinationKey();
  let writer: DatabaseSync | undefined;
  try {
    writer = new DatabaseSync(path);
    writeFileSync(cli, "fixture");
    writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE control_account(active INTEGER); INSERT INTO control_account VALUES(0)");
    const env = { HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, OPENCODE_TEST_MANAGED_CONFIG_DIR: root, OPENCODE_DB: path };
    const read = () => key.read(env, root, cli);
    const accounts = (key as unknown as { accounts: Map<string, { conn: DatabaseSync }> }).accounts;
    const handles = () => accounts.size;
    assert.equal(read().cacheable, true);
    assert.equal(handles(), 1);
    const held = accounts.get(path)!.conn;
    chmodSync(path, 0);
    // remote=true is exposed by read() as cacheable=false.
    assert.equal(read().cacheable, false);
    assert.equal(handles(), 0);
    assert.throws(() => held.prepare("SELECT 1"));
    chmodSync(path, 0o600);
    assert.equal(read().cacheable, true);
    writer.exec("UPDATE control_account SET active=1");
    assert.equal(read().cacheable, false);
  } finally {
    try { key.close(); } finally { writer?.close(); }
  }
}
