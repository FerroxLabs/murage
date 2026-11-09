import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { bootDataRoots } from "../data-roots.ts";
import { SendStore } from "../send-store.ts";
import { PhoneReceipts, reclaimShareOrphans } from "./receipts.ts";

it("S5 site 16 migrates receipt files atomically while basename cleanup remains unchanged", () => {
  mkdirSync(DATA_DIR, { recursive: true });
  const old = join(DATA_DIR, "previous");
  writeFileSync(join(DATA_DIR, ".murage-root.json"), JSON.stringify({ schema: 1, root: old, previous: [] }));
  bootDataRoots();
  const db = new DatabaseSync(":memory:");
  try {
    const sends = new SendStore(() => db), receipts = new PhoneReceipts(db, sends);
    const name = "12345678-1234-1234-1234-123456789abc.png";
    const path = join(old, "attachments", name), next = join(DATA_DIR, "attachments", name);
    receipts.receive({ deviceId: "d", kind: "share", id: "r", fingerprint: "f", generation: 1 });
    receipts.setFiles("d", "share", "r", [{ kind: "image", path, mime: "image/png" }]);
    const moved = new PhoneReceipts(db, sends);
    expect(moved.get("d", "share", "r")?.files?.[0].path).toBe(next);
    expect(JSON.parse(db.prepare("SELECT files FROM phone_receipts").get()!.files as string)[0].path).toBe(next);
    mkdirSync(join(DATA_DIR, "attachments"), { recursive: true });
    writeFileSync(next, "fixture");
    const deleted: string[] = [];
    const cleanup = () => reclaimShareOrphans(db, { attachmentsDir: join(DATA_DIR, "attachments"), messageNames: () => false, remove: p => { deleted.push(p); return { ok: true }; } });
    expect(cleanup().deleted).toBe(1);
    receipts.setFiles("d", "share", "r", [{ kind: "image", path, mime: "image/png" }]);
    expect(cleanup().deleted).toBe(1);
    expect(deleted).toEqual([next, next]);
    const refused = JSON.stringify([{ kind: "image", path: join(old, "wrong", name), mime: "image/png" }]);
    db.prepare("UPDATE phone_receipts SET files=?").run(refused);
    new PhoneReceipts(db, sends);
    expect(db.prepare("SELECT files FROM phone_receipts").get()!.files).toBe(refused);
  } finally { db.close(); }
});
