import { removeTempDirSync } from "../../testing/cleanup.ts";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { wipeSignalData } from "./wipe.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => removeTempDirSync(root)));
function fixture() { const root = mkdtempSync(join(tmpdir(), "signal-wipe-")); roots.push(root); return root; }
function put(root: string, name: string) { const path = join(root, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "private"); return path; }

test("T-WIPE: auth scope preserves receipts; all removes keys, ingress, tombstones, outbox, sent set, logs and tmp (mutant: keep receipts)", async () => {
  for (const scope of ["auth", "all"] as const) {
    const root = fixture();
    const auth = put(root, "signal/auth/data/key");
    const files = ["signal/ingress/one.ndjson", "signal/ingress/one.tombstones.json", "signal/log/signal-cli.log", "signal/tmp/hs_err_1.log",
      "channels/signal/one/receipts.json", "channels/signal/one/outbox.json", "channels/signal/one/sent.json"].map(name => put(root, name));
    const other = put(root, "channels/signal/two/receipts.json"), barrier = put(root, "channels/signal/connection.json");
    await wipeSignalData(root, "one", scope);
    expect(existsSync(auth)).toBe(false);
    expect(files.map(existsSync)).toEqual(files.map(() => scope === "auth"));
    expect(existsSync(other)).toBe(true); expect(existsSync(barrier)).toBe(true);
  }
});

test("T-WIPE: reject traversal and linked ancestors; a leaf link is removed without following it (mutant: follow links)", async () => {
  const root = fixture(), outside = fixture(); const secret = put(outside, "key");
  await expect(wipeSignalData(root, "../outside", "all")).rejects.toThrow();
  mkdirSync(join(root, "channels")); symlinkSync(outside, join(root, "channels/signal"));
  await expect(wipeSignalData(root, "one", "all")).rejects.toThrow();
  expect(existsSync(secret)).toBe(true);
  const safe = fixture(); symlinkSync(outside, join(safe, "signal"));
  await wipeSignalData(safe, "one", "all");
  expect(existsSync(join(safe, "signal"))).toBe(false); expect(existsSync(secret)).toBe(true);
});
