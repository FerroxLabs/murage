// Boot order: the memory worker's tick is started by the listen callback, after the port is open, and not
// at module level before it (index.ts is too large to import under test, so the order is read from the source).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const source = readFileSync(join(import.meta.dirname, "..", "index.ts"), "utf8");
it("memoryWorker.start() for boot is inside the server.listen callback", () => {
  const listen = source.indexOf('server.listen(PORT, "127.0.0.1", () => {');
  expect(listen).toBeGreaterThan(0);
  const starts = [...source.matchAll(/^\s*memoryWorker\.start\(\);/gm)].map(match => match.index!);
  // one at boot (in the listen callback, within its first lines) and the settings route's restart after "configure"
  const before = starts.filter(at => at < listen);
  expect(before).toEqual([]);
  const first = starts.find(at => at > listen)!;
  expect(first - listen).toBeLessThan(600);
});
