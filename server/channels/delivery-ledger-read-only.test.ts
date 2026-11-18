// SPDX-License-Identifier: AGPL-3.0-or-later
// Boot tolerance A2 (docs/designs/boot-tolerance/ACCEPTANCE.md): a read-only process changes no data bytes, and that includes the channel receipt
// store. The real store and the real DurableDelivery run here: a ledger is first made by a normal process, then the process turns read-only (the same
// switch a low start or a low-disk boot step makes) and every open is refused before it touches a byte; a ledger that does not exist yet is not made.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { DiskFloorRefusal } from "../db-busy.ts";
import { enterReadOnly, isReadOnly } from "../read-only-start.ts";
import { DurableDelivery } from "./durable-delivery.ts";
import { LEDGER_DB, LedgerStore } from "./delivery-ledger-store.ts";

const root = mkdtempSync(join(tmpdir(), "murage-ledger-ro-"));
afterAll(() => removeTempDirSync(root));
const options = (file: string) => ({ file, bindingKey: "binding", recipient: "owner", isCurrent: () => true,
  runs: { enqueue: () => ({ id: "run" }), result: () => ({ status: "completed" as const, output: "answer" }) },
  send: async () => ({ recipient: "owner", messageId: "m1" }), now: () => 1_000_000_000 });
/** Every file under `dir` with its size, mode time and content hash (the -wal/-shm included: a read-only open must not make or grow them). */
function inventory(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
    const full = join(entry.parentPath, entry.name); const stat = statSync(full);
    return `${full.slice(dir.length)}:${stat.size}:${stat.mtimeMs}:${createHash("sha256").update(readFileSync(full)).digest("hex")}`;
  }).sort();
}

it("W-LEDGER-RO: a read-only process opens no channel receipt store; an existing one keeps its bytes and a missing one is not made", async () => {
  const existing = join(root, "channels", "slack", "conn-a.json");
  const normal = new DurableDelivery(options(existing));
  await normal.stop();
  const before = inventory(join(root, "channels"));
  expect(before.some(line => line.startsWith(`/slack/${LEDGER_DB}:`))).toBe(true);

  enterReadOnly("fixture-low-disk", 0);
  expect(isReadOnly()).toBe(true);
  expect(() => new LedgerStore(existing)).toThrow(DiskFloorRefusal);
  // The channel ledger constructor wraps the open; whatever it reports, it must not have written.
  try { await new DurableDelivery(options(existing)).stop(); } catch { /* refused */ }
  expect(inventory(join(root, "channels"))).toEqual(before);

  const fresh = join(root, "channels", "discord", "conn-b.json");
  expect(() => new LedgerStore(fresh)).toThrow(DiskFloorRefusal);
  try { await new DurableDelivery(options(fresh)).stop(); } catch { /* refused */ }
  expect(existsSync(join(root, "channels", "discord"))).toBe(false);
});
