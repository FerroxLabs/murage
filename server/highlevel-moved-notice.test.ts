// 1.0.20 hlstrip: an owner who had Murage's own HighLevel set up sees one plain line once; nobody else ever does, and the
// stored HighLevel files are never opened or changed.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { HIGHLEVEL_MOVED_LINE, hadBuiltInHighLevel, takeHighLevelMovedLine } from "./highlevel-moved-notice.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const dirs: string[] = [];
const fresh = () => { const dir = mkdtempSync(join(tmpdir(), "hl-moved-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) removeTempDirSync(dir); });

it("HLM1 the line is the agreed sentence", () => {
  expect(HIGHLEVEL_MOVED_LINE).toBe("HighLevel now connects through Connected apps (Composio) or your own MCP server.");
});

it("HLM2 an install that never had it set up never sees the line", () => {
  const dataDir = fresh();
  expect(takeHighLevelMovedLine({ dataDir, privateToken: "", bots: [{}, { highlevelAccess: { grants: [] } }] })).toBeNull();
  expect(takeHighLevelMovedLine({ dataDir, bots: [] })).toBeNull();
});

it("HLM3 the HighLevel folder: the line once, then never again, and the folder's file is untouched", () => {
  const dataDir = fresh();
  mkdirSync(join(dataDir, "highlevel"));
  const file = join(dataDir, "highlevel", "connection.json");
  writeFileSync(file, '{"fixture":"left untouched"}\n');
  expect(takeHighLevelMovedLine({ dataDir, bots: [] })).toBe(HIGHLEVEL_MOVED_LINE);
  expect(takeHighLevelMovedLine({ dataDir, bots: [] })).toBeNull();
  expect(takeHighLevelMovedLine({ dataDir, bots: [] })).toBeNull();
  expect(readFileSync(file, "utf8")).toBe('{"fixture":"left untouched"}\n');
});

it("HLM4 a saved token or a bot's stored grant counts as set up", () => {
  expect(hadBuiltInHighLevel({ dataDir: fresh(), privateToken: "pit-fixture", bots: [] })).toBe(true);
  expect(hadBuiltInHighLevel({ dataDir: fresh(), bots: [{ highlevelAccess: { grants: [{ botId: "b" }] } }] })).toBe(true);
  expect(hadBuiltInHighLevel({ dataDir: fresh(), privateToken: "  ", bots: [{ highlevelAccess: null }] })).toBe(false);
});

it("HLM5 a marker that cannot be written shows nothing (never twice)", () => {
  if (process.getuid?.() === 0) return; // root writes through the read-only mode
  const dataDir = fresh();
  mkdirSync(join(dataDir, "highlevel"));
  chmodSync(dataDir, 0o500);
  try { expect(takeHighLevelMovedLine({ dataDir, bots: [] })).toBeNull(); }
  finally { chmodSync(dataDir, 0o700); }
});
