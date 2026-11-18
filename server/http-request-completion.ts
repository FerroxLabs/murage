// SPDX-License-Identifier: AGPL-3.0-or-later
// Response-fence producer owner: sfx-fixture. HTTP completion owner: new3-g4b.
import type { ServerResponse } from 'node:http';

/** The response fence owns the fixed terminal refusal. Node's HTTP callback
 * does not observe rejected handler promises, so consume that refusal here
 * after its writer has ended (or close the socket if no response was accepted).
 * Other failures retain their identity and the existing server failure path. */
export function completeHttpRequest(work: Promise<unknown>, response: ServerResponse): Promise<unknown> {
  return work.catch(error => {
    if ((error as { code?: unknown } | null)?.code !== 'MEMORY_CONTEXT_REVOKED') throw error;
    if (!response.writableEnded && !response.destroyed) response.destroy();
  });
}
