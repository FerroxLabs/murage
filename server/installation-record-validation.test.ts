import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { assertInstallationRecords } from "./installation-record-validation.ts";
import { writeInstallationArchive } from "./installation-archive.ts";
import { prepareInstallationRestore } from "./installation-restore-preparation.ts";
import { RoutineManager } from "./routines.ts";
import { CalendarCallManager } from "./calendar-calls.ts";
import { WebhookManager } from "./webhooks.ts";

const receipt = { requestId: "request", messageId: "message", botId: "deleted-bot", threadId: "old-thread", action: "delete", fingerprintVersion: 1, fingerprint: "b".repeat(64), resultId: "deleted-routine", appliedAt: 1 };
const routines = { version: 1, routines: [], runs: [], routineRequestReceipts: [receipt] };
const webhooks = { version: 1, webhooks: [], deliveries: [{ key: "old-endpoint:external-delivery", runId: "pruned-run", at: 1 }] };
const delegations = [{ id: "ack", sourceThreadId: "old-thread", toBotId: "deleted-bot", toBotName: "Historical peer", status: "done", result: "Completed once", finishedAt: 1 }];
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("preserves valid terminal evidence even when live definitions no longer exist", () => {
  for (const [path, value] of [["routines.json", routines], ["webhooks.json", webhooks], ["delegation-receipts.json", delegations]] as const) {
    const before = JSON.stringify(value);
    expect(() => assertInstallationRecords(path, value)).not.toThrow();
    expect(JSON.stringify(value)).toBe(before);
  }
});

const invalid: Array<[string, string, unknown]> = [
  ["future section context version", "section-contexts.json", { version: 2, contexts: {} }],
  ["malformed section context", "section-contexts.json", { version: 1, contexts: { General: { text: 1, updatedAt: 1 } } }],
  ["nonfinite section timestamp", "section-contexts.json", { version: 1, contexts: { General: { text: "brief", updatedAt: Infinity } } }],
  ["oversized UTF-8 section context", "section-contexts.json", { version: 1, contexts: { General: { text: "界".repeat(8001), updatedAt: 1 } } }],
  ["section keys that normalize to one identity", "section-contexts.json", { version: 1, contexts: { Team: { text: "one", updatedAt: 1 }, " Team ": { text: "two", updatedAt: 2 } } }],
  ["confirmation without fingerprint", "routines.json", { ...routines, routineRequestReceipts: [{ ...receipt, fingerprint: undefined }] }],
  ["unknown fingerprint version", "routines.json", { ...routines, routineRequestReceipts: [{ ...receipt, fingerprintVersion: 2 }] }],
  ["duplicate request identity", "routines.json", { ...routines, routineRequestReceipts: [receipt, { ...receipt, resultId: "conflicting-result" }] }],
  ["invalid action", "routines.json", { ...routines, routineRequestReceipts: [{ ...receipt, action: "execute-anything" }] }],
  ["malformed scheduler definition", "routines.json", { ...routines, routines: [{ id: "r", enabled: true }] }],
  ["duplicate webhook delivery key", "webhooks.json", { ...webhooks, deliveries: [webhooks.deliveries[0], { ...webhooks.deliveries[0], runId: "second-run" }] }],
  ["display ID instead of deduplication key", "webhooks.json", { ...webhooks, deliveries: [{ deliveryId: "wrong-field", runId: "r", at: 1 }] }],
  ["unknown delegation outcome", "delegation-receipts.json", [{ ...delegations[0], status: "queued" }]],
  ["duplicate delegation identity", "delegation-receipts.json", [...delegations, ...delegations]],
  ["malformed calendar call", "calendar-calls.json", { version: 1, calls: [{ id: "call" }] }],
];
it.each(invalid)("refuses %s without rewriting it", (_name, path, value) => {
  const before = JSON.stringify(value);
  expect(() => assertInstallationRecords(path, value)).toThrowError(expect.objectContaining({ code: "INVALID_INSTALLATION_RECORDS" }));
  expect(JSON.stringify(value)).toBe(before);
});

it("the archive writer refuses malformed receipt data without publishing a backup or changing original bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "murage-receipt-validation-")); roots.push(root);
  const data = join(root, "source"), target = join(root, "backup.zip"); mkdirSync(data);
  const file = join(data, "routines.json"), bytes = JSON.stringify({ ...routines, routineRequestReceipts: [receipt, receipt] });
  writeFileSync(file, bytes);
  await expect(writeInstallationArchive(data, target)).rejects.toMatchObject({ code: "INVALID_INSTALLATION_RECORDS" });
  expect(readFileSync(file, "utf8")).toBe(bytes);
  expect(existsSync(target)).toBe(false);
});

it("round trips section briefs including General and unknown metadata without loss", async () => {
  const root = mkdtempSync(join(tmpdir(), "murage-section-recovery-")); roots.push(root);
  const data = join(root, "source"), archive = join(root, "backup.zip"); mkdirSync(data);
  const value = { version: 1, provenance: { author: "user" }, contexts: {
    "": { text: "General brief", updatedAt: 1, revision: "keep" },
    Team: { text: "界".repeat(8000), updatedAt: -1 },
  } };
  const file = join(data, "section-contexts.json"), bytes = JSON.stringify(value, null, 2);
  writeFileSync(file, bytes);
  await writeInstallationArchive(data, archive);
  const restored = await prepareInstallationRestore(archive, root);
  expect(JSON.parse(readFileSync(join(restored.stateDirectory, "section-contexts.json"), "utf8"))).toEqual(value);
  expect(readFileSync(file, "utf8")).toBe(bytes);
  expect(restored.activationAvailable).toBe(false);
});

it("refuses invalid section briefs before backup publication and preserves damaged bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "murage-section-refusal-")); roots.push(root);
  const data = join(root, "source"), archive = join(root, "backup.zip"); mkdirSync(data);
  const file = join(data, "section-contexts.json"), bytes = '{ "version": 2, "contexts": {} }';
  writeFileSync(file, bytes);
  await expect(writeInstallationArchive(data, archive)).rejects.toMatchObject({ code: "INVALID_INSTALLATION_RECORDS", component: "section-contexts.json" });
  expect(readFileSync(file, "utf8")).toBe(bytes);
  expect(existsSync(archive)).toBe(false);
});

it("round trips actual manager-produced schedules and acknowledgements with no provider dispatch", async () => {
  const root = mkdtempSync(join(tmpdir(), "murage-real-records-")); roots.push(root);
  const data = join(root, "source"), archive = join(root, "backup.zip"); mkdirSync(data);
  const routines = new RoutineManager({ file: join(data, "routines.json"), botState: () => "ready", createTask: () => { throw new Error("unexpected task dispatch"); }, startTurn: async () => { throw new Error("unexpected provider dispatch"); } });
  const calendar = new CalendarCallManager({ file: join(data, "calendar-calls.json"), botExists: () => true });
  const webhooks = new WebhookManager({ file: join(data, "webhooks.json"), botState: () => "ready", enqueue: () => ({ id: "mock-terminal-run" }) });
  try {
    routines.create({ name: "Real stored routine", prompt: "Never run during test", botId: "bot", enabled: false, schedule: { type: "once", at: 1 } }, { ...receipt, action: "create", fingerprintVersion: 1 });
    calendar.create({ name: "Real stored call", botIds: ["bot"], schedule: { type: "once", at: 1 } });
    const hook = webhooks.create({ name: "Real stored webhook", prompt: "No provider", botId: "bot", enabled: true });
    const delivery = webhooks.receive(hook.webhook.endpointId, hook.secret, { payload: {}, deliveryId: "one-delivery" });
    expect(delivery.duplicate).toBe(false);
    expect(webhooks.receive(hook.webhook.endpointId, hook.secret, { payload: {}, deliveryId: "one-delivery" }).duplicate).toBe(true);
    const names = ["routines.json", "calendar-calls.json", "webhooks.json"];
    const before = new Map(names.map(path => [path, readFileSync(join(data, path), "utf8")]));
    await writeInstallationArchive(data, archive);
    const restored = await prepareInstallationRestore(archive, root);
    const read = (path: string) => JSON.parse(readFileSync(join(restored.stateDirectory, path), "utf8"));
    expect(read("routines.json").routineRequestReceipts).toEqual(JSON.parse(before.get("routines.json")!).routineRequestReceipts);
    expect(read("webhooks.json").deliveries).toEqual(JSON.parse(before.get("webhooks.json")!).deliveries);
    expect(read("webhooks.json").webhooks[0].enabled).toBe(false);
    expect(read("calendar-calls.json").calls[0].nextRunAt).toBeNull();
    for (const [path, bytes] of before) expect(readFileSync(join(data, path), "utf8")).toBe(bytes);
  } finally { routines.stop(); calendar.stop(); }
});
