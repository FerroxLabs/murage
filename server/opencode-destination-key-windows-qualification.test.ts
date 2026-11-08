// Opt-in qualification decides whether retention may ever be enabled on Windows.
// A failure does not reject the shipped open-per-read implementation.
import { expect, it } from "vitest";
import { mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { OpenCodeDestinationKey } from "./opencode-destination-key.ts";

it.skipIf(process.platform !== "win32" || process.env.MURAGE_X4_WIN_QUALIFY !== "1")("D8 Windows retention qualification permits held-handle replace and delete", () => {
  const root = mkdtempSync(join(tmpdir(), "x4-win-qualify-"));
  const path = join(root, "account.db"), cli = join(root, "cli");
  const key = new OpenCodeDestinationKey();
  let held: DatabaseSync | undefined;
  try {
    writeFileSync(cli, "fixture");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE control_account(active INTEGER); INSERT INTO control_account VALUES(0)"); db.close();
    const env = { HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, OPENCODE_TEST_MANAGED_CONFIG_DIR: root, OPENCODE_DB: path };
    expect(key.read(env, root, cli).cacheable).toBe(true);
    held = new DatabaseSync(path, { readOnly: true });
    held.prepare("SELECT * FROM control_account").get();
    const next = join(root, "next"), replacement = new DatabaseSync(next);
    replacement.exec("CREATE TABLE control_account(active INTEGER); INSERT INTO control_account VALUES(1)"); replacement.close();
    renameSync(next, path);
    expect(key.read(env, root, cli).cacheable).toBe(false);
    held.close(); held = new DatabaseSync(path, { readOnly: true });
    held.prepare("SELECT * FROM control_account").get();
    unlinkSync(path);
    expect(key.read(env, root, cli).cacheable).toBe(true);
  } finally { held?.close(); key.close(); rmSync(root, { recursive: true, force: true }); }
});
