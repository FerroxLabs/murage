import { parseConfigPatch, type BrowserProfile } from "./config.ts";
import type { JsonValue } from "./schema.ts";

/** Check the caller's read snapshot before any config or partition mutation. */
export function assertBrowserProfilePrecondition(expected: unknown, current: readonly BrowserProfile[]): void {
  if (expected === undefined) throw Object.assign(new Error("Refresh browser profiles before saving. Older clients must update and include expectedBrowserProfiles."), { status: 409 });
  // Reuse the writable projection's validator: no partition routing or extra fields.
  const parsed = parseConfigPatch({ browserProfiles: expected } as JsonValue).browserProfiles;
  const snapshot = current.map(({ id, name }) => ({ id, name }));
  if (JSON.stringify(parsed) !== JSON.stringify(snapshot)) {
    throw Object.assign(new Error("Browser profiles changed elsewhere. Refresh profiles and review your change before saving again."), { status: 409 });
  }
}
