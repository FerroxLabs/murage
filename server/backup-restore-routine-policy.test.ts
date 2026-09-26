// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.60 audit A-06: restore resets every bot and task to Ask with no
// "Always allow" grants, but kept each routine's own approval level and its
// "Always allow for this routine" grants. A message in a restored routine's
// conversation is judged at the routine's level even while the routine is
// paused, so a restored copy could run commands without asking. Routines now
// follow the same policy: back to following their bot (whose level is reset
// to Ask), with no routine grants, and the review before activation refuses
// a copy where any routine still has either.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { writeInstallationArchive } from "./installation-archive.ts";
import { restoreInstallation } from "./installation-restore.ts";
import { reviewInstallation } from "./installation-activation.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const routine = (id: string, extra: Record<string, unknown>) => ({ id, name: id, prompt: "Sweep the inbox", botId: "bot", target: "bot", runOn: "ember", enabled: true, schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] }, durationMinutes: 30, nextRunAt: 1, createdAt: 1, updatedAt: 1, ...extra });

async function restored() {
  const root = mkdtempSync(join(tmpdir(), "murage-routine-policy-")); roots.push(root);
  const source = join(root, "source"); mkdirSync(source);
  writeFileSync(join(source, "config.json"), "{}");
  writeFileSync(join(source, "bots.json"), JSON.stringify([{ id: "bot", threadId: "thread", name: "Mira", autoApprove: true, fullAccess: true, noLimits: true, alwaysAllow: ["Bash:ls"] }]));
  writeFileSync(join(source, "groups.json"), "[]");
  writeFileSync(join(source, "routines.json"), JSON.stringify({ version: 1, routines: [
    routine("unlimited-sweep", { permissionMode: "unlimited", alwaysAllow: ["exact:v1:rm -rf build"] }),
    routine("full-sweep", { permissionMode: "full" }),
    routine("follows-bot", {}),
  ], runs: [] }));
  const archive = join(root, "backup.zip"), saved = await writeInstallationArchive(source, archive);
  const target = join(root, "target");
  await restoreInstallation(target, archive, saved.sha256, { requireNew: true });
  return target;
}

it("a restored routine follows its bot again and keeps no routine grants", async () => {
  const target = await restored();
  const routines = JSON.parse(readFileSync(join(target, "routines.json"), "utf8")).routines;
  for (const value of routines) {
    expect(value.enabled, value.id).toBe(false);
    expect(value.permissionMode, value.id).toBeUndefined();
    expect(value.alwaysAllow, value.id).toEqual([]);
  }
  const bot = JSON.parse(readFileSync(join(target, "bots.json"), "utf8"))[0];
  expect({ autoApprove: bot.autoApprove, alwaysAllow: bot.alwaysAllow }).toEqual({ autoApprove: false, alwaysAllow: [] });
  expect(reviewInstallation(target).status).toBe("ready-for-review");
});

it.each([
  ["its own approval level", { permissionMode: "full" }],
  ["an Always allow for this routine grant", { alwaysAllow: ["exact:v1:ls"] }],
])("the review refuses a restored copy where a routine still has %s", async (_label, extra) => {
  const target = await restored();
  const file = join(target, "routines.json"), value = JSON.parse(readFileSync(file, "utf8"));
  value.routines[0] = { ...value.routines[0], ...extra };
  writeFileSync(file, JSON.stringify(value));
  expect(() => reviewInstallation(target)).toThrow(expect.objectContaining({ code: "RESTORE_WORK_NOT_PAUSED" }));
});
