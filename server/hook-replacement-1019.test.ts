import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, symlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { dropCanon, type CanonSet } from "./hook-canon.ts";
import { writeHookFiles, hookEnvPathOf } from "./drivers/codex-hook.ts";
import { EventBus } from "./harness/bus.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const roots: string[] = [];
const sets: CanonSet[] = [];
afterEach(() => { for (const set of sets.splice(0)) dropCanon(set); for (const root of roots.splice(0)) removeTempDirSync(root); });
function fixture() {
  const native = join(DATA_DIR, "native"); mkdirSync(native, { recursive: true });
  const root = mkdtempSync(join(native, "hook-replacement-")); roots.push(root);
  const home = join(root, "codex-scope", "live");
  const env = hookEnvPathOf(home, "gate");
  const files = writeHookFiles(home, "/socket", "token", env); sets.push(files.canon);
  return { root, home, env, files, original: readFileSync(files.script, "utf8") };
}

it("A1: a replaced hook is restored before handoff without writing through its link", () => {
  const f = fixture();
  const outside = join(f.root, "outside"); writeFileSync(outside, "owner data");
  unlinkSync(f.files.script); symlinkSync(outside, f.files.script);
  writeHookFiles(f.home, "/socket", "token", f.env, undefined, f.files.canon);
  expect(readFileSync(outside, "utf8")).toBe("owner data");
  expect(readFileSync(f.files.script, "utf8")).toBe(f.original);
});

it("A1: another turn's completed tool restores a live hook through the shared fan-out", () => {
  const f = fixture(); writeFileSync(f.files.script, "tampered");
  const bus = new EventBus(() => undefined);
  bus.publish({ type: "item.completed", itemType: "tool", itemId: "cursor-tool", threadId: "other-thread", turnId: "other-turn", providerInstanceId: "cursor", eventId: "other-tool-event", provider: "acp", createdAt: new Date().toISOString(), ok: true });
  expect(readFileSync(f.files.script, "utf8")).toBe(f.original);
});
