// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// Contact turns and the saved image library.
//
// Saved prompt blocks and reference packs are the owner's: a brand lock, a
// product shot, a face they reuse. They are read, saved and pulled into a
// render only on a turn whose audience is the owner, the same rule as the
// owner's standing material (standing-context.ts): not in a linked channel
// person's conversation (whose turn internal-route-authority.ts already
// refuses every image route), and not on words in the owner's own thread
// that nobody proved are the owner's (an unproven send, or a peer turn such
// words started), whose capability carries notOwnerAudience.
//
// Enforced here, in the harness routes, whatever the proxy lists: the tool
// list only follows (shared/image-library-audience.ts).
import { isWorkspaceOwner, threadHumanPrincipal } from "./human-principals.ts";
import { murageTool } from "./tool-call-context.ts";

/** Is everyone this turn answers to the workspace owner? */
export function imageLibraryOwnerAudience(claim: { threadId: string; notOwnerAudience?: boolean }): boolean {
  return claim.notOwnerAudience !== true && isWorkspaceOwner(threadHumanPrincipal(claim.threadId));
}

/** What the bot reads when it reaches for the library on such a turn. */
export function imageLibraryContactRefusal(): string {
  return `Saved prompt blocks and reference packs belong to the owner, so they cannot be used in this conversation. Write what you need into the prompt and call ${murageTool("generate_image")} without prompt_blocks or reference_pack.`;
}

const LIBRARY_ROUTE = /^\/api\/internal\/image-(?:prompt-blocks?|reference-packs?)$/;

/** The refusal this internal request earns, or null when it may proceed. A
 * render that names no saved block or pack keeps whatever rule it has. */
export function imageLibraryRouteRefusal(input: { path: string; body?: unknown; ownerAudience: boolean }): string | null {
  if (input.ownerAudience) return null;
  if (LIBRARY_ROUTE.test(input.path)) return imageLibraryContactRefusal();
  if (input.path === "/api/internal/generate-image") {
    const body = (input.body ?? {}) as { promptBlocks?: unknown; referencePack?: unknown };
    const blocks = Array.isArray(body.promptBlocks) ? body.promptBlocks.length > 0 : body.promptBlocks !== undefined;
    if (blocks || body.referencePack !== undefined) return imageLibraryContactRefusal();
  }
  return null;
}
