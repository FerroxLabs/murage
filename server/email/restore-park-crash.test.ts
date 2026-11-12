// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Restore park crash harness (r3.1 section 10): each case spawns server/testing/email-crash-child.ts, which runs one act on a real data dir and SIGKILLs itself at the
// checkpoint; this process then opens the same files with a new DatabaseSync, EmailRuntime and fake Flux, boots through the real start path, and asserts the invariants:
// no DELETE the owner did not authorize, Keep wins, nothing auto-unparked. Covers C4-C10 and C12-C14 (C1-C3 are the Cloud swap and restore consumer, C11 is Batch B).
// Also T23, T26, T27 (the crash rows of the test plan).
import { removeTempDirSync } from "../testing/cleanup.ts";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EmailRuntime } from "./runtime.ts";
import { prepareRestoredEmail } from "./restore.ts";
import { FakeFlux, fluxError } from "../testing/fake-flux-email.ts";
import type { BotRecord } from "../store.ts";

const CHILD = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "email-crash-child.ts");
const CAPS = { object: "email.capabilities", enabled: true, available: true, account_state: "active", terms_version: "v1", limits: {} };
const CLOCK = 1_800_000_000_000;
let dir: string;
let db: DatabaseSync;
let runtime: EmailRuntime;
let fake: FakeFlux;

const binding = { botId: "b1", inboxId: "ibx_1", address: "juniper@murage.email", username: "juniper", displayName: "Juniper", emailKeyRef: "key_old", fluxAccountId: null, step: null, opId: "op1", opStartedAt: null, policy: "auto", failure: null, updatedAt: 0 };
const make = (orphan: boolean) => new EmailRuntime({
  accountKey: () => "sk-flux-account-fixture", database: () => db, transaction: fn => fn(), fetch: fake.fetch, apiBase: "https://api.flux.test", appBase: "https://app.flux.test",
  now: () => CLOCK, workspaceRoot: () => undefined, deletionProof: () => true,
  bot: id => (orphan ? undefined : ({ id, name: "Juniper", threadId: `t-${id}` } as unknown as BotRecord)),
  persistSecrets: doc => writeFileSync(join(dir, "secrets.json"), JSON.stringify(doc)),
});
const svc = () => runtime.services()!;
/** The backup on disk: the data dir with a restored binding in `state` (and optionally no binding at all: an intent-only park), secrets saved to secrets.json. */
const setup = async (state: string, noBinding = false) => {
  fake = new FakeFlux().always("GET", /^\/v1\/email\/capabilities$/, { status: 200, body: CAPS });
  db = new DatabaseSync(join(dir, "db.sqlite"));
  runtime = make(false);
  runtime.secrets.setOwner({ token: "owner-fixture", keyId: "key_owner" });
  runtime.secrets.setBotKey("b1", { token: "bot-key", keyId: "key_old" });
  await runtime.probe.refresh();
  runtime.stop();
  svc().store.insertBinding({ ...binding, state } as never);
  prepareRestoredEmail(db);
  if (noBinding) svc().store.deleteBindingGeneration(svc().store.getBinding("b1")!);
  db.close();
};
/** Run the child to its checkpoint; it must die by SIGKILL. */
const crash = (scenario: string, at: string) => {
  const env: NodeJS.ProcessEnv = { HOME: tmpdir(), EMAIL_CRASH_DIR: dir, EMAIL_CRASH_CHILD: "1", EMAIL_CRASH_NOW: String(CLOCK) };
  if (process.env.PATH) env.PATH = process.env.PATH;
  const child = spawnSync(process.execPath, [CHILD, scenario, at], { cwd: join(dirname(CHILD), "..", ".."), env, encoding: "utf8", timeout: 60_000 });
  expect(child.stdout.includes("NOT_REACHED") ? `${scenario}@${at} never reached its checkpoint:\n${child.stdout}\n${child.stderr}` : "").toBe("");
  expect({ signal: child.signal, stderr: child.stderr }).toMatchObject({ signal: "SIGKILL" });
};
const childCalls = () => (existsSync(join(dir, "calls.log")) ? readFileSync(join(dir, "calls.log"), "utf8").split("\n").filter(Boolean) : []);
const childDeletes = () => childCalls().filter(line => /^DELETE \/v1\/email\/inboxes\//.test(line)).length;
const childKeyRevokes = () => childCalls().filter(line => /^DELETE .*bot-keys/.test(line)).length;
const deletes = () => fake.calls("DELETE", /\/v1\/email\/inboxes\//);
/** A new process: the same files, a fresh runtime and fake, no restore preparation. `before` runs after the probe and before start() (an event that arrives first). */
const reopen = async (orphan: boolean, script: (flux: FakeFlux) => void, before?: () => Promise<void>) => {
  fake = new FakeFlux().always("GET", /^\/v1\/email\/capabilities$/, { status: 200, body: CAPS });
  script(fake);
  db = new DatabaseSync(join(dir, "db.sqlite"));
  runtime = make(orphan);
  runtime.secrets.replaceAll(JSON.parse(readFileSync(join(dir, "secrets.json"), "utf8")));
  await runtime.probe.refresh();
  await before?.();
  await runtime.start();
  runtime.stop();
  for (let i = 0; i < 3; i += 1) { await svc().bindings.reap(); await svc().bindings.resumeRemovals(); }
};
const closingFlux = (flux: FakeFlux) => flux.always("GET", /\/inboxes\/ibx_1$/, { status: 200, body: { id: "ibx_1", state: "closing" } }).always("POST", /\/inboxes\/ibx_1\/restore$/, { status: 200, body: { id: "ibx_1", state: "active" } });
const removeFlux = (flux: FakeFlux) => flux.always("GET", /\/inboxes\/ibx_1$/, { status: 200, body: { id: "ibx_1", state: "deleted" } }).always("DELETE", /\/inboxes\/ibx_1$/, { status: 202, body: { state: "closing" } }).always("DELETE", /bot-keys\/key_old$/, { status: 204 });

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "park-crash-")); });
afterEach(() => { runtime?.stop(); try { db?.close(); } catch { /* already closed */ } removeTempDirSync(dir); });

describe("restore park crash harness: Keep (C4 C5 C6, T23)", () => {
  for (const at of ["C4", "C5", "C6"]) {
    it(`${at}: a Keep killed here ends kept after the restart: restored_unverified, park gone, 0 DELETEs, nothing auto-unparked`, async () => {
      await setup("removing");
      crash("keep", at);
      // A3 keep guard: the restart polls the kept inbox; where Keep had already finished Flux says active, so the guard sends nothing
      await reopen(false, at === "C6" ? (flux => flux.always("GET", /\/inboxes\/ibx_1$/, { status: 200, body: { id: "ibx_1", state: "active" } })) : closingFlux);
      expect(svc().store.getPark("b1")).toBeNull();
      expect(svc().store.getBinding("b1")).toMatchObject({ state: "restored_unverified", step: "restored" });
      expect(svc().store.tombstones().filter(tomb => tomb.state !== "removed")).toHaveLength(0);
      expect(childDeletes() + deletes().length).toBe(0);
      expect(childKeyRevokes() + fake.calls("DELETE", /bot-keys/).length).toBe(0);
      if (at === "C6") expect(fake.calls("POST", /\/restore$/)).toHaveLength(0); // already done: the restart sends nothing
      else expect(childCalls().filter(line => line.startsWith("POST")).length + fake.calls("POST", /\/restore$/).length).toBeGreaterThanOrEqual(1);
    });
  }

  it("T23: a crash at C5 and a deleted event recorded after it: the restart moves keep_pending to parked with 0 inbox or key calls, evidence kept", async () => {
    await setup("removing");
    crash("keep", "C5");
    await reopen(false, closingFlux, async () => {
      expect(svc().store.getPark("b1")).toMatchObject({ state: "keep_pending" });
      await svc().bindings.applyLifecycle({ type: "email.inbox.deleted", inbox_id: "ibx_1" });
    });
    expect(svc().store.getPark("b1")).toMatchObject({ state: "parked_evidence", keepOp: null, remoteDeletedAt: CLOCK });
    expect(svc().store.getBinding("b1")?.state).toBe("removal_parked");
    expect(fake.requests.filter(request => /inboxes|bot-keys/.test(request.path)).map(request => `${request.method} ${request.path}`)).toEqual([]);
    expect(await svc().bindings.keep("b1")).toMatchObject({ ok: false, code: "inbox_gone" });
  });
});

describe("restore park crash harness: owner Remove (C7 C8 C9, T27)", () => {
  for (const at of ["C7", "C8"]) {
    it(`${at}: a Remove killed here is replayed after the restart, ends removed, and the DELETEs are the owner's only`, async () => {
      await setup("removing");
      crash("remove", at);
      expect(childDeletes()).toBe(at === "C7" ? 0 : 1);
      await reopen(false, removeFlux);
      expect(svc().store.getPark("b1")).toBeNull();
      expect(svc().store.getBinding("b1")).toBeNull();
      expect(svc().store.getTombstone("b1", "ibx_1")).toMatchObject({ state: "removed" });
      expect(deletes().length).toBe(1); // exactly one DELETE after the restart (idempotent replay of the owner's Remove)
      expect(runtime.secrets.botKey("b1")).toBeNull();
    });
  }

  it("C9: a Remove killed after the key revoke answered, before the tombstone transaction, ends removed with the revoke repeated as a 404", async () => {
    await setup("removing");
    crash("remove", "C9");
    expect(childKeyRevokes()).toBe(1);
    await reopen(false, flux => flux.always("DELETE", /\/inboxes\/ibx_1$/, fluxError(404, "inbox_not_found")).always("DELETE", /bot-keys\/key_old$/, fluxError(404, "key_not_found")).always("GET", /bot-keys\/key_old$/, fluxError(404, "key_not_found")));
    expect(svc().store.getPark("b1")).toBeNull();
    expect(svc().store.getTombstone("b1", "ibx_1")).toMatchObject({ state: "removed" });
    expect(runtime.secrets.botKey("b1")).toBeNull();
  });

  it("T27: an orphan Remove crashed at C10 (authorized, before the DELETE): the restart replays exactly 1 DELETE and the park is gone at the end", async () => {
    await setup("removing", true);
    crash("orphan-remove", "C10");
    expect(childDeletes()).toBe(0);
    await reopen(false, removeFlux, async () => { expect(svc().store.getPark("b1")).toMatchObject({ state: "remove_authorized", authorizedBy: "orphan" }); });
    expect(deletes()).toHaveLength(1);
    expect(svc().store.getPark("b1")).toBeNull();
    expect(svc().store.getTombstone("b1", "ibx_1")).toMatchObject({ state: "removed" });
  });
});

describe("restore park crash harness: orphan key release (C12 C13 C14, T26)", () => {
  for (const at of ["C12", "C13", "C14"]) {
    it(`T26 ${at}: an orphan Keep killed here ends with the key revoked (once, or repeated as a 404), the secret cleared, the park gone and the inbox kept`, async () => {
      await setup("removing");
      crash("orphan-keep", at);
      await reopen(true, flux => { closingFlux(flux); flux.always("DELETE", /bot-keys\/key_old$/, at === "C12" ? { status: 204 } : fluxError(404, "key_not_found")); });
      expect(svc().store.getPark("b1")).toBeNull();
      expect(svc().store.getBinding("b1")).toBeNull();
      expect(runtime.secrets.botKey("b1")).toBeNull();
      expect(childDeletes() + deletes().length).toBe(0); // the inbox is kept
      expect(childKeyRevokes() + fake.calls("DELETE", /bot-keys/).length).toBeGreaterThanOrEqual(1);
      expect(fake.calls("DELETE", /bot-keys/).length).toBe(1);
    });
  }
});
