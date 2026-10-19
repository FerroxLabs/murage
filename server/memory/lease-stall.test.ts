// SPDX-License-Identifier: AGPL-3.0-or-later
// A11: a lease must survive the server's loop stalling past it, while a takeover still fences the old holder.
import { mkdirSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { setMemoryMode } from "./repository.ts";
import { captureWork } from "./chunks.ts";
import { claimMemoryJob, heartbeatMemoryJob, publishMemoryWork, resetMemoryClaimCursor } from "./jobs.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture"); resetMemoryClaimCursor(); });
const source = (text = "Durable evidence") => appendMessage("thread", { id: "source", at: 1, role: "user", kind: "text", text });
const lease = () => database().prepare("SELECT status,lease_owner,lease_until,lease_generation FROM memory_jobs").get()!;

it("a beat that comes 45 s late (the loop was stalled) still renews a lease nobody took over, and the work publishes", () => {
  source();
  const work = claimMemoryJob("A", 1_000)!;
  expect(lease()).toMatchObject({ status: "leased", lease_owner: "A", lease_until: 31_000 });
  // The 10 s beat could not run: the server's thread was busy until t=46 s, past the 30 s lease.
  expect(heartbeatMemoryJob(work, "A", 46_000)).toBe(true);
  expect(lease()).toMatchObject({ status: "leased", lease_owner: "A", lease_until: 76_000, lease_generation: work.leaseGeneration });
  // A stall between the worker's result and its publication: still the holder's.
  publishMemoryWork(work, "A", captureWork(work), 120_000);
  expect(database().prepare("SELECT status FROM memory_jobs").get()?.status).toBe("complete");
  expect(Number(database().prepare("SELECT count(*) AS n FROM memory_records").get()?.n)).toBe(1);
});

it("a late beat never moves a lease backwards", () => {
  source();
  const work = claimMemoryJob("A", 1_000)!;
  expect(heartbeatMemoryJob(work, "A", 20_000)).toBe(true);
  expect(Number(lease().lease_until)).toBe(50_000);
  // a beat stamped with an older clock reading (a timer that ran out of order) keeps the later deadline
  expect(heartbeatMemoryJob(work, "A", 5_000)).toBe(true);
  expect(Number(lease().lease_until)).toBe(50_000);
});

it("fencing is kept: once another worker took the expired job over, the old holder can neither renew nor publish", () => {
  source();
  const a = claimMemoryJob("A", 1_000)!;
  const b = claimMemoryJob("B", 40_000)!;
  expect(b.leaseGeneration).toBeGreaterThan(a.leaseGeneration);
  expect(heartbeatMemoryJob(a, "A", 41_000)).toBe(false);
  expect(() => publishMemoryWork(a, "A", captureWork(a), 41_000)).toThrow("STALE_MEMORY_LEASE");
  expect(lease()).toMatchObject({ lease_owner: "B", lease_generation: b.leaseGeneration });
  publishMemoryWork(b, "B", captureWork(b), 41_000);
  expect(Number(database().prepare("SELECT count(*) AS n FROM memory_records").get()?.n)).toBe(1);
});

it("a stalled holder is still taken over once its lease has run out (a crashed holder is recovered)", () => {
  source();
  claimMemoryJob("A", 1_000);
  expect(claimMemoryJob("B", 20_000)).toBeNull();   // live lease
  expect(claimMemoryJob("B", 31_001)?.id).toBeTruthy(); // ran out
});
