import { createHash } from "node:crypto";
import type { UnifiedBrowserController } from "./browser-control.ts";
/** The server derives all three fields from authenticated launch/companion
 * authority and current bot configuration, never from a browser request body. */
export type BrowserOwnerAuthority = { owner: string; profileKey: string; active: () => boolean; canReclaim?: boolean };
export function browserOwnerId(launchKind: "desktop" | "companion", realm: string): string {
  return createHash("sha256").update(`${realm}:${launchKind}`).digest("hex").slice(0, 32);
}
export async function browserOwnerRequest(controller: UnifiedBrowserController, authority: BrowserOwnerAuthority | null, method: string, body: Record<string, unknown> = {}, frameGeneration?: number) {
  const valid = () => { if (!authority?.active()) throw Object.assign(new Error("Browser owner authentication required"), { status: 401 }); };
  valid(); const { owner, profileKey } = authority!;
  if (method === "GET") {
    if (frameGeneration !== undefined) return controller.frame(profileKey, frameGeneration);
    await controller.connect(profileKey); valid(); return { ...controller.status(profileKey), owned: controller.status(profileKey).owner === owner, canReclaim: authority!.canReclaim === true };
  }
  if (method !== "POST") throw Object.assign(new Error("Browser route requires GET or POST"), { status: 405 });
  if (JSON.stringify(body).length > 16_384) throw Object.assign(new Error("Browser input exceeds its bound"), { status: 413 });
  const generation = body.generation;
  if (body.action !== "take" && !Number.isSafeInteger(generation)) throw Object.assign(new Error("A current browser generation is required"), { status: 400 });
  switch (body.action) {
    case "reclaim": if (!authority!.canReclaim) throw Object.assign(new Error("Only the desktop owner may reclaim control"), { status: 403 }); await controller.reclaim(profileKey, owner); break;
    case "take": await controller.take(profileKey, owner); break;
    case "release": await controller.release(profileKey, owner, generation as number); break;
    case "navigate": if (typeof body.url !== "string") throw new Error("A browser address is required"); await controller.navigate(profileKey, owner, generation as number, body.url); break;
    case "input": if (!body.event || typeof body.event !== "object" || Array.isArray(body.event)) throw new Error("A browser input event is required"); controller.input(profileKey, owner, generation as number, body.event as Record<string, unknown>); break;
    case "reopen": await controller.reopen(profileKey, owner, generation as number); break;
    default: throw Object.assign(new Error("Unknown browser action"), { status: 400 });
  }
  valid(); const status = controller.status(profileKey); return { ...status, owned: status.owner === owner, canReclaim: authority!.canReclaim === true };
}
