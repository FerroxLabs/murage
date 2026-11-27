// N3 (fprod3 r3b section 8): the one place a hand-off's turn starts refuses an archived sender or target. The hand-off is in flight past the discard
// (it was claimed before the archive was admitted), so only the check right before the start can stop it.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { _resetPending, _drainingCount, drainDelegations, findDelegationReceipt, queueDelegation } from "./delegations.ts";
import { _resetOwnerMigration } from "./pending-delegations-schema.ts";
import { ownerWorld } from "./testing/handoff-worlds.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { settleTestHandles } from "./test-handle-registry.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const settle = async (): Promise<void> => { for (let i = 0; i < 2000 && _drainingCount() > 0; i++) await tick(); await tick(); await tick(); };

beforeEach(async () => { closeDatabase(); await settleTestHandles(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); _resetPending(); _resetOwnerMigration(); });
afterEach(async () => { _resetOwnerMigration(); _resetPending(); closeDatabase(); await settleTestHandles(); });

describe("N3: the hand-off start refuses a fenced sender or target", () => {
  for (const side of ["sender", "target"] as const) {
    it(`an archived ${side}: no turn starts, the hand-off ends cancelled with a receipt`, async () => {
      const w = ownerWorld("owner");
      const queued = queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: "do it", depth: 0 }, 2).id!;
      w.knobs.fenced = new Set([side === "sender" ? w.from.id : w.target.id]);
      drainDelegations(w.bus, w.approvalBus, w.from.threadId);
      await settle();
      expect(w.turns).toHaveLength(0);
      expect(findDelegationReceipt(queued)?.status).toBe("cancelled");
      expect(database().prepare("SELECT 1 FROM pending_delegations WHERE id=? AND phase='started' AND started_at IS NOT NULL").get(queued)).toBeUndefined();
    });
  }
  it("control: nothing fenced, the same hand-off starts", async () => {
    const w = ownerWorld("owner");
    const queued = queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: "do it", depth: 0 }, 2).id!;
    drainDelegations(w.bus, w.approvalBus, w.from.threadId);
    await settle();
    expect(w.turns.map(t => t.id)).toEqual([queued]);
  });
});
