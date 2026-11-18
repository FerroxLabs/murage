// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Child of server/team-identities-switch.test.ts (ACCEPTANCE.md E4): a normal start on a small filesystem, a bot whose sharing list names a team that no
// longer exists (the boot reconciliation must drop it and save the roster), the disk taken to zero before that step, then the production boot caller
// (reconcileTeamsAtBoot). Scenario "squeeze" fills the disk; scenario "again" is the next start with space. One JSON line out.
// Usage: team-switch-child.ts <squeeze|again> <ballast file>
import { dataDirOf, ballastTo, freeOf, sleep } from "./floor-state.ts";
const [scenario, ballast = ""] = process.argv.slice(2);
const dataDir = dataDirOf("TEAM_SWITCH_CHILD");
const { readFileSync, readdirSync } = await import("node:fs");
const { join } = await import("node:path");
const { closeDatabase, database } = await import("../database.ts");
const { isReadOnly, skippedAtStart, startMode } = await import("../read-only-start.ts");
const { initializeTeamIdentityTables } = await import("../team-identities.ts");
const { reconcileTeamsAtBoot } = await import("../team-lifecycle.ts");
const { Store } = await import("../store.ts");
const DEAD = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";
const rosterHasDead = () => readFileSync(join(dataDir, "bots.json"), "utf8").includes(DEAD);

const mode = startMode(dataDir);
initializeTeamIdentityTables(database());
const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
const out: Record<string, unknown> = { scenario, startMode: mode };
if (scenario === "squeeze") {
  const bot = store.createBot();
  store.patchBot(bot.id, { sharedWith: { mode: "list", teams: [{ id: DEAD, name: "Old Team" }] } });
  await sleep(1500); // a coalesced roster save lands
  out.fixtureSaved = rosterHasDead();
  // the log is folded back first: a write that truncates it later would hand space back and let the roster save through
  database().exec("PRAGMA wal_checkpoint(TRUNCATE)");
  ballastTo(dataDir, ballast, 0);
  out.freeAfterBallast = freeOf(dataDir);
  out.deadBeforeReconcile = rosterHasDead();
}
if (scenario === "squeeze") ballastTo(dataDir, ballast, 0);
out.freeBeforeReconcile = freeOf(dataDir);
const sharedBefore = JSON.stringify(store.bots.map(b => b.sharedWith));
const notes = reconcileTeamsAtBoot(store);
out.freeAfterReconcile = freeOf(dataDir); out.sharedBefore = sharedBefore; out.sharedAfter = JSON.stringify(store.bots.map(b => b.sharedWith)); out.files = readdirSync(dataDir).filter(f => /bots/.test(f));
Object.assign(out, {
  readOnly: isReadOnly(), skipped: [...skippedAtStart], notes: notes.length, bots: store.bots.length,
  rosterHasDead: rosterHasDead(), memoryHasDead: JSON.stringify(store.bots.map(b => b.sharedWith)).includes(DEAD),
});
closeDatabase();
process.stdout.write(`TEAMSWITCH ${JSON.stringify(out)}\n`);
process.exit(0);
