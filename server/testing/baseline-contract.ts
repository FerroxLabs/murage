import { existsSync } from "node:fs";
import { expect } from "vitest";

/** Load the version under review, never a replacement implementation. An absent
 * module/export fails inside the individual case at its first contract use,
 * rather than aborting collection. Ordinary baseline APIs run unchanged. */
export async function baselineModule<T extends object>(url: URL, reason: string): Promise<T> {
  const actual = existsSync(url) ? await import(url.href) as T : undefined;
  return new Proxy({} as T, {
    get(_target, name) {
      if (name === "then") return undefined;
      const value = actual?.[name as keyof T];
      if (value !== undefined) return value;
      return function missingBaselineContract() {
        expect(value, `${reason}: ${String(name)} must exist`).toBeDefined();
      };
    },
  });
}
// Baseline-compatible observation of real adapter writes. No missing export is
// replaced with a pretend implementation: BASE uses its shipped beforeSubmit.
import { vi } from "vitest";
const releaseProbe = vi.hoisted(() => ({ marker: "scopes7c_sentinel", writes: 0, atWrite: undefined as undefined | (() => void) }));
vi.mock("../procs.ts", async original => {
  const actual = await original<typeof import("../procs.ts")>();
  return { ...actual, spawnCli: (...args: Parameters<typeof actual.spawnCli>) => {
    const child = actual.spawnCli(...args);
    if (child.stdin) {
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = ((...values: Parameters<typeof child.stdin.write>) => {
        const bytes = String(values[0]);
        if (bytes.includes(releaseProbe.marker)) {
          releaseProbe.atWrite?.();
          releaseProbe.writes++;
        }
        return write(...values);
      }) as typeof child.stdin.write;
    }
    return child;
  } };
});

export { releaseProbe };
