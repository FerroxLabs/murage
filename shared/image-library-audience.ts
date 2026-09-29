// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
/**
 * The saved image library (prompt blocks and reference packs) is the owner's
 * material. On a turn whose audience is not the owner, the harness refuses
 * every library route and a render that asks for a saved block or pack
 * (server/image-library-audience.ts), and the agents server of that turn is
 * told to leave the library out of its tool list, the way a channel person's
 * turn never gets the connected apps mounted.
 *
 * Pure and dependency-free: the bundled agents proxy imports it.
 */

/** The agents tools that read or write the saved library. */
export const IMAGE_LIBRARY_TOOLS = ["list_prompt_blocks", "get_prompt_block", "save_prompt_block", "list_reference_packs", "save_reference_pack"] as const;

/** "0" on the agents server of a turn whose audience is not the owner. */
export const IMAGE_LIBRARY_ENV = "MURAGE_IMAGE_LIBRARY";
