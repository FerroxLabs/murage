import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { Store, canReach } from "./store.ts";
import { managedBotProfile, manageBot, mayInspectBot, organizationRevision } from "./bot-management.ts";

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
function setup() {
  const store = new Store(() => ({ instanceId: "fixture", model: "model" }));
  const chief = store.createBot({ name: "Chief", section: "Leadership" });
  const lead = store.createBot({ name: "Lead", section: "Studio" });
  const specialist = store.createBot({ name: "Specialist", section: "Studio" });
  const other = store.createBot({ name: "Other", section: "Other" });
  store.setChiefOfStaff(chief.id, undefined, "workspace"); store.setChiefOfStaff(lead.id, undefined, "section");
  store.patchBot(specialist.id, { composio: false, autoApprove: false });
  const options = { pendingWork: () => false, validateSelection: () => ({ instanceId: "fixture", model: "other-model" }), validateLeader: vi.fn(), revoke: vi.fn() };
  const request = (action: string, extra: object = {}) => ({ action, botId: specialist.id, revision: managedBotProfile(specialist).revision, ...extra });
  return { store, chief, lead, specialist, other, options, request };
}

it("lets the Chief inspect specialists without granting direct messaging or exposing credentials", () => {
  const { store, chief, lead, specialist, other, options } = setup();
  expect(canReach(chief, specialist)).toBe(false);
  expect(mayInspectBot(chief, specialist)).toBe(true);
  const result = manageBot(store, chief, { action: "get", botId: specialist.id }, options);
  expect(result.bot.id).toBe(specialist.id);
  expect(result.bot).not.toHaveProperty("composio");
  expect(result.bot).not.toHaveProperty("cwd");
  expect(() => manageBot(store, lead, { action: "get", botId: other.id }, options)).toThrow("permitted organization");
});

it("updates longer instructions for the next turn without interrupting current work or granting access", () => {
  const { store, lead, specialist, options, request } = setup();
  store.patchBot(specialist.id, { busy: true });
  const instructions = "Responsible specialist instructions. ".repeat(100);
  manageBot(store, lead, request("update", { instructions }), options);
  expect(specialist.description).toBe(instructions.trim());
  expect(specialist.busy).toBe(true);
  expect(specialist.composio).toBe(false); expect(specialist.autoApprove).toBe(false);
  const restored = new Store(() => specialist.modelSelection);
  expect(restored.bot(specialist.id)?.description).toBe(instructions.trim());
});

it("rejects stale revisions, oversized instructions, and attempted security-field changes", () => {
  const { store, chief, specialist, options, request } = setup();
  const stale = request("update", { role: "Changed role" });
  store.patchBot(specialist.id, { name: "New name" });
  expect(() => manageBot(store, chief, stale, options)).toThrow("This bot changed");
  expect(() => manageBot(store, chief, request("update", { autoApprove: true }), options)).toThrow("Security settings");
  expect(() => manageBot(store, chief, request("update", { instructions: "x".repeat(8001) }), options)).toThrow("Invalid bot-management");
  expect(() => manageBot(store, specialist, { action: "update", botId: chief.id, revision: managedBotProfile(chief).revision, role: "Overrule" }, options)).toThrow("owner controls");
});

it("archives and restores idle bots reversibly, preserving their history and access settings", () => {
  const { store, chief, specialist, options, request } = setup();
  const threadId = specialist.threadId;
  expect(() => manageBot(store, chief, request("archive"), { ...options, pendingWork: () => true })).toThrow("pending work");
  manageBot(store, chief, request("archive"), options); expect(specialist.hidden).toBe(true);
  manageBot(store, chief, request("restore"), options); expect(specialist.hidden).toBe(false);
  expect(specialist.threadId).toBe(threadId); expect(specialist.composio).toBe(false);
  expect(options.revoke).toHaveBeenCalledTimes(2);
});

it("requires Chief authority and current organization revision for moves and lead changes", () => {
  const { store, chief, lead, specialist, options, request } = setup();
  const threadId = specialist.threadId;
  expect(() => manageBot(store, lead, request("move", { section: "Other", organizationRevision: organizationRevision(store, lead) }), options)).toThrow("Only the Chief");
  const policyBefore = Number(database().prepare("SELECT policy_revision FROM memory_meta").get()!.policy_revision);
  manageBot(store, chief, request("move", { section: "Other", organizationRevision: organizationRevision(store, chief) }), options);
  expect(specialist.section).toBe("Other"); expect(specialist.threadId).toBe(threadId);
  expect(Number(database().prepare("SELECT policy_revision FROM memory_meta").get()!.policy_revision)).toBeGreaterThan(policyBefore);
  manageBot(store, chief, request("set-lead", { organizationRevision: organizationRevision(store, chief) }), options);
  expect(specialist.chiefOfStaff).toBe(true); expect(store.workspaceChief()?.id).toBe(chief.id);
});

it("checks model changes through the provider boundary and refuses them while busy", () => {
  const { store, chief, specialist, options, request } = setup();
  const change = { modelSelection: { instanceId: "fixture", model: "other-model" } };
  store.patchBot(specialist.id, { busy: true });
  expect(() => manageBot(store, chief, request("update", change), options)).toThrow("active or pending work");
  store.patchBot(specialist.id, { busy: false });
  manageBot(store, chief, request("update", change), options);
  expect(specialist.modelSelection.model).toBe("other-model");
  expect(options.revoke).toHaveBeenCalledWith(specialist.id);
});
