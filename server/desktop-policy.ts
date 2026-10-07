/** Direct administration requires the renderer's per-launch proof.
 *
 * Until 0.1.61 this file was a denylist of the routes that needed it, and
 * every route missing from the list was open to any process on the computer.
 * The decision now lives in route-policy.ts, where a route with no entry is
 * desktop-only by construction; this stays as the question the feature
 * modules and their tests ask. */
import { routeClass } from "./route-policy.ts";

export function requiresDesktopAuthority(method: string, path: string): boolean {
  return routeClass(method, path) === "desktop";
}
