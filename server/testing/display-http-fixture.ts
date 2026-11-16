// SPDX-License-Identifier: AGPL-3.0-or-later
// Public projection owner: l5a. Evidence/action adapter owner: c4-misc-d.
import { fixtureDisplayReply, fixtureMessageEvidence } from "./display-fixture.ts";

/** MAIN RULING INT-CONFLICT-DEFAULT a62419d6d5 / 3ad2b8f428:
 * execution-card assertions use durable evidence only for actually displayed
 * rows, after the existing helper proves opaque handles and no native id.
 * Plain messages and the separate host own-write protocol stay as displayed. */
export function fixtureDisplayedResponse(database: string, body: any): any {
  if (!body || !Array.isArray(body.messages)) return body;
  return { ...body, messages: body.messages.map((message: any) => {
    if (!/^[pq]\./.test(message.card?.requestHandle ?? "")) return message;
    const [evidence] = fixtureMessageEvidence(database, [message]);
    return { ...message, card: evidence.card };
  }) };
}

/** Keep malformed/unknown requests malformed; known native evidence submits
 * the same opaque action that the renderer sends through the real route. */
export function fixtureDisplayRequest(database: string, path: string, body: any): any {
  return path.endsWith("/respond") ? fixtureDisplayReply(database, body) : body;
}
