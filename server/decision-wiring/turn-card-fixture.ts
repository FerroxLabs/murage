// Add extracted production writers to the shared real Stop/browser-release rig.
import { stopCardFixture } from "../testing/turn-card-fixture.ts";
export function stopCardRig(extra = "", overrides: Record<string, unknown> = {}, options: Parameters<typeof stopCardFixture>[0] = {}) {
  const r = stopCardFixture(options);
  const writers = r.evaluate(`${extra}\n;globalThis.extra ?? {}`, overrides) as Record<string, (...args: any[]) => any>;
  return { ...r, built: { ...r.built, ...writers } };
}
