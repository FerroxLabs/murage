import { createHash } from "node:crypto";
import type { UnifiedBrowserController } from "./browser-control.ts";
/** The server derives all three fields from authenticated launch/companion
 * authority and current bot configuration, never from a browser request body. */
export type BrowserOwnerAuthority = { owner: string; profileKey: string; active: () => boolean; canReclaim?: boolean };
export function browserOwnerId(realmOrKind: string, legacyRealm?: string): string {
  return createHash("sha256").update(`${legacyRealm ?? realmOrKind}:owner`).digest("hex").slice(0, 32);
}
/** Inputs are server authentication results, never fields in a request body.
 * Cloud browser scopes do not acquire browser-control authority through the
 * broader desktop surface or companion read gates. */
export function browserOwnerPrincipal(proof: { realm: string; cloudHome: boolean; desktop: boolean; companion: boolean; scope?: string }): { owner: string; canReclaim: boolean } | null {
  if (proof.cloudHome ? proof.scope !== "owner-desktop" && proof.scope !== "owner-phone" : !proof.desktop && !proof.companion) return null;
  return { owner: browserOwnerId(proof.realm), canReclaim: proof.cloudHome ? proof.scope === "owner-desktop" : proof.desktop };
}
export function migrateBrowserOwner(owner: unknown, realm: string, cloudHome: boolean): unknown {
  const legacy = (kind: string) => createHash("sha256").update(`${realm}:${kind}`).digest("hex").slice(0, 32);
  return owner === legacy("desktop") || (!cloudHome && owner === legacy("companion")) ? browserOwnerId(realm) : owner;
}
export async function browserOwnerRequest(controller: UnifiedBrowserController, authority: BrowserOwnerAuthority | null, method: string, body: Record<string, unknown> = {}, frameGeneration?: number) {
  // Distinct `code` from the door's own 401 two lines up in server/index.ts
  // (`"desktop_only"`): this one fires whenever `authority.active()` goes
  // false mid-session on an already-authenticated caller — a profile
  // switch, "Use my Chrome" toggled, the bot removed, or the built-in
  // browser disabled while a request is in flight — never a device-auth
  // problem, so a client must not tell it apart from that with status alone.
  const valid = () => { if (!authority?.active()) throw Object.assign(new Error("Browser owner authentication required"), { status: 401, code: "browser_inactive" }); };
  valid(); const { owner, profileKey } = authority!;
  if (method === "GET") {
    if (frameGeneration !== undefined) return controller.frame(profileKey, frameGeneration);
    // Answered at once, even while the browser cannot connect, so the panel
    // always has the current hold and generation to hand control back with.
    const status = await controller.refresh(profileKey); valid(); return { ...status, owned: status.owner === owner, canReclaim: authority!.canReclaim === true };
  }
  if (method !== "POST") throw Object.assign(new Error("Browser route requires GET or POST"), { status: 405 });
  if (JSON.stringify(body).length > 16_384) throw Object.assign(new Error("Browser input exceeds its bound"), { status: 413 });
  const generation = body.generation;
  const control = Number.isSafeInteger(body.control) ? body.control as number : undefined;
  if (body.action !== "take" && body.action !== "restart" && body.action !== "retry" && !(body.action === "release" && control !== undefined) && !Number.isSafeInteger(generation)) throw Object.assign(new Error("A current browser generation is required"), { status: 400 });
  switch (body.action) {
    case "reclaim": if (!authority!.canReclaim) throw Object.assign(new Error("Only the desktop owner may reclaim control"), { status: 403 }); await controller.reclaim(profileKey, owner); break;
    case "take": await controller.take(profileKey, owner); break;
    case "release": await controller.release(profileKey, owner, generation as number, control); break;
    // "Use my Chrome": one new attach after a failed one (no timer retries).
    case "retry": await controller.retry(profileKey); break;
    case "navigate": if (typeof body.url !== "string") throw new Error("A browser address is required"); await controller.navigate(profileKey, owner, generation as number, body.url); break;
    case "input": if (!body.event || typeof body.event !== "object" || Array.isArray(body.event)) throw new Error("A browser input event is required"); await controller.input(profileKey, owner, generation as number, body.event as Record<string, unknown>); break;
    case "reopen": await controller.reopen(profileKey, owner, generation as number); break;
    // The browser is not running: start it again. No hold needed, and the page lock is untouched.
    case "restart": await controller.restart(profileKey, owner); break;
    default: throw Object.assign(new Error("Unknown browser action"), { status: 400 });
  }
  valid(); const status = controller.status(profileKey); return { ...status, owned: status.owner === owner, canReclaim: authority!.canReclaim === true };
}

/** A Cloud home's owner browsers each hold on their own: the hold is bound to the device, so one device's control never
 * opens the page for another device that merely carries a live door proof. */
export function cloudBrowserOwnerId(realm: string, deviceId: string): string {
  return browserOwnerId("companion", `${realm}:cloud-device:${deviceId}`);
}
export interface CloudHoldDevice { id: string; scope: string; factor: "passkey" | "remembered-owner" | null; factorExpiresAt?: number }
/** Releases the holds of Cloud devices that are no longer a live owner browser (revoked, demoted to chat only, factor expired).
 * Desktop and phone holds are never touched. Returns how many holds were handed back. */
export function releaseDeadCloudHolds(controller: Pick<UnifiedBrowserController, "releaseHeldWhere">, realm: string, devices: readonly CloudHoldDevice[], now = Date.now()): number {
  const live = new Set(devices.filter(d => d.scope === "browser" && d.factor !== null && (d.factorExpiresAt === undefined || d.factorExpiresAt > now)).map(d => cloudBrowserOwnerId(realm, d.id)));
  const kept = new Set([browserOwnerId("desktop", realm), browserOwnerId("companion", realm)]);
  return controller.releaseHeldWhere(owner => !kept.has(owner) && !live.has(owner));
}
