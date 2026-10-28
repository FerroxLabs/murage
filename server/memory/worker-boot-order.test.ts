// Boot order: the memory worker's tick is started by the listen callback, after the port is open, and not
// at module level before it (index.ts is too large to import under test, so the order is read from the source).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const source = readFileSync(join(import.meta.dirname, "..", "index.ts"), "utf8");
it("memoryWorker.start() for boot is inside the server.listen callback", () => {
  const listen = source.indexOf('server.listen(PORT, "127.0.0.1", () => {');
  expect(listen).toBeGreaterThan(0);
  // A Cloud home starts it only while its execution gate is open, so the boot call may carry that one guard.
  const starts = [...source.matchAll(/^[ \t]*(?:if \(!homeExecutionGate \|\| homeExecutionGate\.open\(\)\) )?memoryWorker\.start\(\);/gm)].map(match => match.index!);
  // one at boot (in the listen callback, within its first lines) and the settings route's restart after "configure"
  // The settings route's restart (memory configured, any mode: off or paused boots the deletion-only worker) is a request handler,
  // not module level, and sits above listen in the file; only a start outside it would run before the port opens.
  const configureRoute = (at: number) => source.slice(Math.max(0, at - 600), at).includes('body.action==="configure"');
  expect(starts.filter(configureRoute)).toHaveLength(1);
  const before = starts.filter(at => at < listen && !configureRoute(at));
  expect(before).toEqual([]);
  const first = starts.find(at => at > listen)!;
  expect(first).toBeGreaterThan(listen);
  expect(source.slice(listen, first).split("\n").length, "within the listen callback's first lines").toBeLessThanOrEqual(12);
});
