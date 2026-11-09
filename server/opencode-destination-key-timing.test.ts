import { expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { OpenCodeDestinationKey } from "./opencode-destination-key.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

it.skipIf(process.env.MURAGE_X4_TEST_TIMING !== "1")("D6 200 warm WAL reads have p50 below 2 ms", () => {
  const root = mkdtempSync(join(tmpdir(), "x4-timing-"));
  const path = join(root, "account.db"), cli = join(root, "cli");
  const writer = new DatabaseSync(path), key = new OpenCodeDestinationKey();
  try {
    writeFileSync(cli, "fixture");
    writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE account_state(id INTEGER PRIMARY KEY, active_account_id TEXT, active_org_id TEXT); INSERT INTO account_state VALUES(1, NULL, NULL)");
    const env = { HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, OPENCODE_TEST_MANAGED_CONFIG_DIR: root, OPENCODE_DB: path };
    const warm = key.read(env, root, cli);
    expect(warm.cacheable).toBe(true);
    expect(warm.key).toMatch(/^[a-f0-9]{64}$/);
    const accounts = (key as unknown as { accounts: Map<string, { statements: Map<string, unknown> }> }).accounts;
    const assertQueryUsed = () => {
      if (process.platform !== "win32") {
        expect(accounts.get(path)?.statements.has("SELECT active_org_id FROM account_state WHERE id=1 AND active_account_id IS NOT NULL")).toBe(true);
      }
    };
    assertQueryUsed();
    const times: number[] = [];
    for (let i = 0; i < 200; i++) {
      const start = performance.now();
      const answer = key.read(env, root, cli);
      times.push(performance.now() - start);
      expect(answer.cacheable).toBe(true);
      expect(answer.key).toBe(warm.key);
      assertQueryUsed();
    }
    times.sort((a, b) => a - b);
    const p50 = times[99], p95 = times[189];
    console.info(`D6 WAL read n=200 p50=${p50.toFixed(3)} ms p95=${p95.toFixed(3)} ms platform=${process.platform}`);
    expect(p50).toBeLessThan(2);
  } finally { key.close(); writer.close(); removeTempDirSync(root); }
});
