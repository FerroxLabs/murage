import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { RoutineManager } from "./routines.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

it("persists an owner-cleared ceiling without treating damaged or legacy records as inherited", () => {
  const root = mkdtempSync(join(tmpdir(), "routine-inheritance-"));
  const file = join(root, "routines.json");
  const options = { file, botState: () => "ready" as const, createTask: () => ({ threadId: "fixture-thread" }), startTurn: async () => {} };
  const managers: RoutineManager[] = [];
  const load = () => { const manager = new RoutineManager(options); managers.push(manager); return manager; };
  try {
    const manager = load();
    const routine = manager.create({ name: "Brief", prompt: "Report", botId: "fixture-bot", enabled: false, permissionMode: "full", schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() } });
    manager.inheritAllPermissions();
    expect(load().routineById(routine.id)?.permissionMode).toBeUndefined();
    const edited = load();
    edited.update(routine.id, { permissionMode: "ask" });
    expect(load().routineById(routine.id)?.permissionMode).toBe("ask");
    edited.update(routine.id, { permissionMode: "inherit" });
    const disk = JSON.parse(readFileSync(file, "utf8"));
    delete disk.routines[0].permissionMode;
    writeFileSync(file, JSON.stringify(disk));
    expect(load().routineById(routine.id)?.permissionMode).toBe("ask");
  } finally {
    for (const manager of managers) manager.stop();
    removeTempDirSync(root);
  }
});
