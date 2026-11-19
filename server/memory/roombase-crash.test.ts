// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// W13 (docs/designs/1019-roombase-pinned/DESIGN.md 7, rules C1 and C6, edges E3 and E4, invariants I1-I3): a child process on
// this test's file database is killed with SIGKILL inside the E3 transaction (reply + receipt link + capture job) and inside a
// capture step's publishing transaction. After the restart: E3 left all or none; the owner's ask keeps its job; the leased job
// of the dead process is claimable at once (not after lease_until) and completes; a live lease of this process is not taken.
import { fork } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage, closeMessageDb } from "../message-db.ts";
import { useOutsideStoreFixture } from "../testing/outside-store-fixture.ts";
import { captureWork } from "./chunks.ts";
import { claimMemoryJob, publishMemoryWork, releaseDeadProcessLeases, resetProcessLeaseOwnersForTests } from "./jobs.ts";
import { person, receipt, resetWorld } from "./testing/xthread-world.ts";

useOutsideStoreFixture();

async function crashAt(cut: "e3" | "e4") {
  closeMessageDb(); closeDatabase();
  const reached = join(DATA_DIR, "fixture-cut.json");
  const child = fork(join(import.meta.dirname, "testing/roombase-crash-child.ts"), [cut, reached], {
    execArgv: ["--experimental-strip-types", "--no-warnings"], env: { ...process.env, MURAGE_DATA_DIR: DATA_DIR }, stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = ""; child.stderr!.on("data", chunk => { stderr += String(chunk); });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 30_000);
  const [code, signal] = await once(child, "exit").finally(() => clearTimeout(deadline));
  expect({ code, signal }, stderr).toEqual({ code: null, signal: "SIGKILL" });
  const trace = JSON.parse(readFileSync(reached, "utf8")) as { cut: string; jobId?: string };
  expect(trace.cut).toBe(cut);
  return trace;
}

function world() {
  resetWorld();
  resetProcessLeaseOwnersForTests();
  receipt("b1", "t1");
  appendMessage("t1", person("ask", "what is the side gate code?"));
  appendMessage("t1", person("ask2", "and the back gate?", { parentId: "ask" }));
}
const jobOf = (id: string) => database().prepare("SELECT status,lease_owner FROM memory_jobs WHERE source_id=? ORDER BY rowid DESC").get(`message:t1:${id}`);

it("W13 SIGKILL inside the E3 transaction leaves reply, receipt link and capture job all absent; the asks keep their jobs", async () => {
  world();
  await crashAt("e3");
  const db = database();
  expect({
    reply: Boolean(db.prepare("SELECT 1 FROM messages WHERE thread_id='t1' AND id='reply'").get()),
    receipt: Boolean(db.prepare("SELECT 1 FROM memory_disclosures, json_each(output_message_ids) o WHERE bundle_id='b1' AND o.value='reply'").get()),
    job: Boolean(db.prepare("SELECT 1 FROM memory_jobs WHERE source_id='message:t1:reply'").get()),
  }).toEqual({ reply: false, receipt: false, job: false });
  // I3: no durable message without its job
  expect(Number(db.prepare("SELECT count(*) AS n FROM messages m WHERE m.thread_id='t1' AND m.role='user' AND NOT EXISTS (SELECT 1 FROM memory_jobs j WHERE j.source_id='message:t1:'||m.id)").get()!.n)).toBe(0);
  expect(jobOf("ask")).toMatchObject({ status: "pending" });
});

it("W13 SIGKILL inside a capture step: at start the dead lease is released at once, a live lease is kept, and the job completes", async () => {
  world();
  const { jobId } = await crashAt("e4");
  const db = database();
  const dead = db.prepare("SELECT status,lease_owner,lease_until,attempts,source_id FROM memory_jobs WHERE id=?").get(jobId!) as { status: string; lease_owner: string; lease_until: number; attempts: number; source_id: string };
  // the step's transaction rolled back whole: the job is still leased by the dead process, its lease far from expiry
  expect(dead).toMatchObject({ status: "leased", lease_owner: "dead-worker", attempts: 0 });
  expect(dead.lease_until).toBeGreaterThan(Date.now() + 10_000);
  // this process takes the other ask's job: a live lease
  const live = claimMemoryJob("live-worker")!;
  expect(live.id).not.toBe(jobId);
  expect(releaseDeadProcessLeases()).toBe(1);
  expect(db.prepare("SELECT status,lease_owner FROM memory_jobs WHERE id=?").get(live.id)).toEqual({ status: "leased", lease_owner: "live-worker" });
  // I3: no leased job owned by a dead process after start
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_jobs WHERE status='leased' AND lease_owner IS NOT 'live-worker'").get()!.n)).toBe(0);
  // claimable at once, well before the dead lease's lease_until, and it completes
  const resumed = claimMemoryJob("live-worker", Date.now());
  expect(resumed?.id).toBe(jobId);
  publishMemoryWork(resumed!, "live-worker", captureWork(resumed!));
  publishMemoryWork(live, "live-worker", captureWork(live));
  expect(db.prepare("SELECT status,attempts FROM memory_jobs WHERE id=?").get(jobId!)).toEqual({ status: "complete", attempts: 0 });
  expect(db.prepare("SELECT status FROM memory_jobs WHERE id=?").get(live.id)).toEqual({ status: "complete" });
});
