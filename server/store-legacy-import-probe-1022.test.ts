// q1022-startup item 7: a start finds the pending legacy transcripts (messages-<thread>.json) with one listing of the data folder, not
// one existsSync probe per known thread; a pending file is still imported. Driven through the Store constructor (the boot load).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { Store } from "./store.ts";
import { threadHasRows } from "./message-db.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
// node's own fs.existsSync, swapped on the CommonJS object and synced into every ESM `import { existsSync } from "node:fs"` binding
const require = createRequire(import.meta.url);
const fs = require("node:fs") as typeof import("node:fs");
function countingLegacyProbes<T>(run: () => T): { probes: number; value: T } {
  const real = fs.existsSync;
  let probes = 0;
  fs.existsSync = ((path: Parameters<typeof real>[0]) => { if (/messages-[^/\\]*\.json$/.test(String(path))) probes++; return real(path); }) as typeof real;
  syncBuiltinESMExports();
  try { const value = run(); return { probes, value }; }
  finally { fs.existsSync = real; syncBuiltinESMExports(); }
}

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
beforeEach(() => removeTempDirSync(DATA_DIR));

it("W-LEGACY-PROBE a start with 25 known threads probes no legacy transcript one by one, and still imports the pending one", () => {
  const store = new Store(selection);
  const bots = Array.from({ length: 25 }, () => store.createBot({}, { seedMessages: false }));
  writeFileSync(join(DATA_DIR, `messages-${bots[7]!.threadId}.json`), JSON.stringify([{ id: "m1", role: "user", kind: "text", text: "hi", at: 1 }]));
  const boot = countingLegacyProbes(() => new Store(selection));
  const reloaded = boot.value;
  expect(boot.probes, "existsSync probes of messages-<thread>.json during the start").toBe(0);
  expect(threadHasRows(bots[7]!.threadId), "the start itself imported the pending file (not a later lazy open)").toBe(true); void reloaded;
});
