// SPDX-License-Identifier: AGPL-3.0-or-later
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { completeFluxSubkey, peekFluxSubkey as takeFluxSubkey } from "./flux-subkey-delivery.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const OP = "renew:home-1:3:7";
const KEY = `sk-flux-home-${"k".repeat(30)}`;
const me = process.getuid!();
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) removeTempDirSync(r); });
function drop(content: string, dirMode = 0o770, fileMode = 0o640) {
  const root = mkdtempSync(join(tmpdir(), "subkey-")); roots.push(root);
  const dir = join(root, "d"); mkdirSync(dir); chmodSync(dir, dirMode);
  writeFileSync(join(dir, "key.json"), content, { mode: fileMode }); chmodSync(join(dir, "key.json"), fileMode);
  return dir;
}

describe("supervisor takes the Flux sub-key from the private hand-off", () => {
  it("finding 8: reading a good delivery leaves it in place; the receipt is written, and the hand-off removed, only on completion", () => {
    const dir = drop(JSON.stringify({ key: KEY, generation: 2, expiresAt: "2030-01-01T00:00:00Z", capUsd: 30, op_id: OP }));
    const delivery = takeFluxSubkey(dir, me);
    expect(delivery).toMatchObject({ key: KEY, generation: 2, op_id: OP });
    expect(existsSync(join(dir, "key.json"))).toBe(true);
    expect(existsSync(join(dir, "receipt.json"))).toBe(false);
    expect(takeFluxSubkey(dir, me)).not.toBeNull(); // a failed seal is simply read again next cycle
    completeFluxSubkey(delivery!, dir, me);
    expect(JSON.parse(readFileSync(join(dir, "receipt.json"), "utf8"))).toEqual({ op_id: OP, generation: 2 });
    expect(readFileSync(join(dir, "receipt.json"), "utf8")).not.toContain("sk-flux");
    expect(statSync(join(dir, "receipt.json")).mode & 0o777).toBe(0o640);
    expect(existsSync(join(dir, "key.json"))).toBe(false);
    expect(takeFluxSubkey(dir, me)).toBeNull();
  });
  it("finding 8: completing an older delivery never removes a newer hand-off", () => {
    const dir = drop(JSON.stringify({ key: KEY, generation: 2, expiresAt: "2030-01-01T00:00:00Z", capUsd: 30, op_id: OP }));
    const old = takeFluxSubkey(dir, me)!;
    writeFileSync(join(dir, "key.json"), JSON.stringify({ key: KEY, generation: 3, expiresAt: "2030-01-01T00:00:00Z", capUsd: 30, op_id: "renew:home-1:3:8" }), { mode: 0o640 });
    completeFluxSubkey(old, dir, me);
    expect(takeFluxSubkey(dir, me)).toMatchObject({ generation: 3 });
  });
  it("a malformed hand-off is removed so it cannot wedge the loop", () => {
    const dir = drop("not json");
    expect(takeFluxSubkey(dir, me)).toBeNull();
    expect(existsSync(join(dir, "key.json"))).toBe(false);
  });
  it("refuses a loose directory, a loose file, or a non-home key", () => {
    const good = JSON.stringify({ key: KEY, generation: 2, expiresAt: "2030-01-01T00:00:00Z", capUsd: 30, op_id: OP });
    expect(takeFluxSubkey(drop(good, 0o755), me)).toBeNull();
    expect(takeFluxSubkey(drop(good, 0o770, 0o644), me)).toBeNull();
    expect(takeFluxSubkey(drop(good, 0o770, 0o660), me)).toBeNull(); // group write on the key
    expect(takeFluxSubkey(drop(good, 0o700, 0o640), me)).toBeNull(); // the supervisor's group has no access to the directory
    expect(takeFluxSubkey(drop(good), me, process.getgid!() + 1)).toBeNull(); // not the supervisor's group
    expect(takeFluxSubkey(drop(good), me + 1)).toBeNull(); // not the poller's uid
    expect(takeFluxSubkey(drop(JSON.stringify({ key: `sk-flux-${"p".repeat(30)}`, generation: 1, expiresAt: "2030-01-01T00:00:00Z", capUsd: 1 })), me)).toBeNull();
  });
  it("hole 11: the old field names (key_alias, expires_at) are no longer a delivery", () => {
    expect(takeFluxSubkey(drop(JSON.stringify({ key: KEY, key_alias: "a", generation: 2, expires_at: "2030-01-01T00:00:00Z" })), me)).toBeNull();
  });
});
