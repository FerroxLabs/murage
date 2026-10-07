// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// Contact turns and the saved image library.
//
// Saved prompt blocks and reference packs are the owner's: a brand lock, a
// product shot, a face they reuse. They are read, saved and pulled into a
// render only on a turn whose audience is the owner, the one predicate of
// owner-audience.ts, the same way the connected apps are the owner's
// (connector-requests.ts): not in a linked channel person's conversation or a
// turn it started (whose image routes internal-route-authority.ts already
// refuses), and not on words in the owner's own thread that nobody proved
// are the owner's, whose capability carries notOwnerAudience.
//
// Enforced here, in the harness routes, whatever the proxy lists: the tool
// list only follows (shared/image-library-audience.ts).
import { turnAudienceIsOwner } from "./owner-audience.ts";
import { murageToolOnThisServer } from "./murage-tool-surface.ts";

/** Is everyone this turn answers to the workspace owner? An audience that
 *  cannot be read is not the owner's. */
export function imageLibraryOwnerAudience(claim: { threadId: string; notOwnerAudience?: boolean }): boolean {
  if (claim.notOwnerAudience === true) return false;
  try { return turnAudienceIsOwner(claim.threadId); } catch { return false; }
}

/** What the bot reads when it reaches for the library on such a turn. */
export const IMAGE_LIBRARY_CONTACT_REFUSAL = `Saved prompt blocks and reference packs belong to the owner, so they cannot be used in this conversation. Write what you need into the prompt and call ${murageToolOnThisServer("generate_image")} without prompt_blocks or reference_pack.`;

/** The refusal this internal request earns, or null when it may proceed. A
 * render that names no saved block or pack keeps whatever rule it has. */
export function imageLibraryRouteRefusal(input: { path: string; body?: unknown; claim: { threadId: string; notOwnerAudience?: boolean } }): string | null {
  const library = input.path.startsWith("/api/internal/image-prompt-block") || input.path.startsWith("/api/internal/image-reference-pack");
  if (!library && input.path !== "/api/internal/generate-image") return null;
  if (!library) {
    const body = (input.body ?? {}) as { promptBlocks?: unknown; referencePack?: unknown };
    const blocks = Array.isArray(body.promptBlocks) ? body.promptBlocks.length > 0 : body.promptBlocks !== undefined;
    if (!blocks && body.referencePack === undefined) return null;
  }
  return imageLibraryOwnerAudience(input.claim) ? null : IMAGE_LIBRARY_CONTACT_REFUSAL;
}
