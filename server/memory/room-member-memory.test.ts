// A room member is the same bot it is in a direct chat: when only the owner
// (and the owner's bots) can read the room, the member recalls its own bot
// memory and its team's memory beside the room's. Anyone else in the audience
// — a linked channel person — keeps the room-only boundary. Owner-private
// continuity never enters a room, and a notebook the prompt already carries
// whole is not recalled a second time.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { ensureWorkspace } from "../workspace.ts";
import { bindHumanThread, linkHumanBinding, observeVerifiedHuman, resolveHumanBinding } from "../human-principals.ts";
import { ensureScope, memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { ownerMemoryTicket, pinMemory } from "./authority.ts";
import { writeBotIdentity } from "./identity.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { searchMemory, type MemorySearchBridge } from "./search.ts";
import { commitMemoryImport, notebookSourceIds, previewMemoryImport } from "./import.ts";

const roster: MemoryRoster = {
  bots: [{ id: "a", threadId: "private-a", section: "alpha" }, { id: "b", threadId: "private-b", section: "beta" }],
  groups: [{ id: "room", threadId: "room-thread", memberIds: ["a", "b"] }],
};
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });

function access(thread: string, humanPrincipal?: ReturnType<typeof resolveHumanBinding>) {
  reconcileMemoryRoster(roster);
  const registry = new InternalCapabilities(); registry.begin("a", thread, "generation", humanPrincipal);
  const token = registry.mint({ botId: "a", threadId: thread, generation: "generation", depth: 0, kind: "memory", skillAuthoring: false, ...humanPrincipal ? { humanPrincipal } : {} });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
}
const bridge = (hits: Array<{ id: string; version: number }>): MemorySearchBridge => ({
  async search() { return { hits: hits.map(hit => ({ ...hit, score: 1, lexical: true })), vectorRows: 0, coverageComplete: false }; },
});
function importNotebook(text: string) {
  writeFileSync(join(ensureWorkspace("a"), "MEMORY.md"), text);
  const ticket = ownerMemoryTicket();
  const preview = previewMemoryImport(ticket, [{ kind: "bot", botId: "a" }], roster);
  return commitMemoryImport(ticket, preview.previewId, roster).recordIds;
}

it("gives a member its own bot and team scopes in an owner room, never a teammate's", () => {
  const scopes = access("room-thread").scopeIds;
  expect(scopes).toContain(ensureScope("room", "room"));
  expect(scopes).toContain(ensureScope("bot", "a"));
  expect(scopes).toContain(ensureScope("team", "alpha"));
  expect(scopes).not.toContain(ensureScope("bot", "b"));
  expect(scopes).not.toContain(ensureScope("team", "beta"));
  expect(scopes).not.toContain(ensureScope("conversation", "private-a"));
});

it("keeps a room with a linked channel person to the room boundary", () => {
  reconcileMemoryRoster(roster);
  const binding = observeVerifiedHuman({ platform: "slack", connectionId: "fixture", authorityId: "team", userId: "guest" });
  linkHumanBinding(ownerMemoryTicket(), { bindingId: binding, expectedRevision: 1, as: "person" });
  bindHumanThread("room-thread", resolveHumanBinding(binding));
  const scopes = access("room-thread", resolveHumanBinding(binding)).scopeIds;
  expect(scopes).toContain(ensureScope("room", "room"));
  expect(scopes).not.toContain(ensureScope("bot", "a"));
  expect(scopes).not.toContain(ensureScope("team", "alpha"));
});

it("keeps owner-private continuity out of an owner room even when it is pinned", async () => {
  reconcileMemoryRoster(roster);
  const ticket = ownerMemoryTicket();
  const record = writeBotIdentity(ticket, { action: "identity-write", botId: "a", kind: "continuity-brief", key: "core", expectedVersion: 0, text: "Private harbour continuity", basis: "fiction", audience: "owner-private" }, roster) as { id: string; version: number };
  const direct = await buildMemoryBundle("harbour", access("private-a"), bridge([]));
  expect(direct.text).toContain("Private harbour continuity");
  pinMemory(ticket, record.id, record.version, true);
  const room = access("room-thread");
  const bundle = await buildMemoryBundle("harbour continuity", room, bridge([record]));
  expect(bundle.text).not.toContain("Private harbour continuity");
  const found = await searchMemory("harbour continuity", room, bridge([record]));
  expect(found.hits.map(hit => hit.id)).not.toContain(record.id);
});

it("does not recall a notebook that the prompt already carries whole", async () => {
  reconcileMemoryRoster(roster);
  const ids = importNotebook("The greenhouse sensor id is gh-7.");
  const direct = access("private-a");
  const hits = ids.map(id => ({ id, version: 1 }));
  const recalled = await buildMemoryBundle("greenhouse sensor id", direct, bridge(hits));
  expect(recalled.text).toContain("gh-7");
  const excluded = await buildMemoryBundle("greenhouse sensor id", direct, bridge(hits), { excludeSourceIds: Object.values(notebookSourceIds("a", "alpha")) });
  expect(excluded.text).not.toContain("gh-7");
});
