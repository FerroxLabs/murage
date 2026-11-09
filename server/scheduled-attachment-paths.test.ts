import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { bootDataRoots } from "./data-roots.ts";
import { RoutineManager } from "./routines.ts";
import { CalendarCallManager } from "./calendar-calls.ts";

const old = join(DATA_DIR, "previous");
const path = join(old, "attachments", "brief.pdf");
const next = join(DATA_DIR, "attachments", "brief.pdf");
const attachment = { id: "a", name: "Brief", kind: "file" as const, path, size: 10 };
const routineFile = join(DATA_DIR, "routines.json");
const calendarFile = join(DATA_DIR, "calendar-calls.json");
const routines = () => new RoutineManager({ file: routineFile, botState: () => "ready", createTask: () => ({ threadId: "t" }), startTurn: async () => {} });
const calendar = () => new CalendarCallManager({ file: calendarFile, botExists: () => true });
function setup(previous = true) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, ".murage-root.json"), JSON.stringify({ schema: 1, root: previous ? old : DATA_DIR, previous: [] }));
  bootDataRoots();
}

it("S5 site 17 migrates routines.json structured paths and preserves prompt history and unknown fields", () => {
  setup();
  const first = routines();
  first.create({ name: "Brief", prompt: path, botId: "bot", target: "bot", runOn: "ember", enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 60000 }, attachments: [attachment] });
  const raw = JSON.parse(readFileSync(routineFile, "utf8"));
  raw.extra = { text: path };
  writeFileSync(routineFile, JSON.stringify(raw));
  const moved = routines().listRoutines()[0]!;
  expect(moved.attachments?.[0].path).toBe(next);
  expect(moved.prompt).toBe(path);
  expect(JSON.parse(readFileSync(routineFile, "utf8"))).toMatchObject({ extra: { text: path }, routines: [{ attachments: [{ path: next }] }] });
});

it("S5 site 17 migrates calendar-calls.json structured paths and preserves description history", () => {
  setup();
  calendar().create({ name: "Brief", description: path, botIds: ["bot"], durationMinutes: 30, schedule: { type: "once", at: Date.now() + 60000 }, attachments: [attachment] });
  expect(calendar().list()[0]).toMatchObject({ description: path, attachments: [{ path: next }] });
  expect(JSON.parse(readFileSync(calendarFile, "utf8")).calls[0].attachments[0].path).toBe(next);
});

it("S5 site 17 keeps refused and unrecorded scheduler stores byte-identical", () => {
  setup();
  const calls = calendar();
  calls.create({ name: "Refused", description: path, botIds: ["bot"], durationMinutes: 30, schedule: { type: "once", at: Date.now() + 60000 }, attachments: [{ ...attachment, path: join(old, "other", "brief.pdf") }] });
  const before = readFileSync(calendarFile, "utf8");
  calendar();
  expect(readFileSync(calendarFile, "utf8")).toBe(before);
  setup(false);
  const first = routines();
  first.create({ name: "Unrecorded", prompt: path, botId: "bot", target: "bot", runOn: "ember", enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 60000 }, attachments: [attachment] });
  const bytes = readFileSync(routineFile, "utf8");
  routines();
  expect(readFileSync(routineFile, "utf8")).toBe(bytes);
});
