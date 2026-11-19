// SPDX-License-Identifier: AGPL-3.0-or-later
// Deferral producer owner: scperf-p1. Memory retry consumers owner: scperf-p1.
export class BgDeferred extends Error {
 readonly retryInMs:number;
 /** The refusal came from another holder's live reservation, not spent bytes: it clears when that reservation settles, so the retry may be shorter than the minute. */
 readonly reservationWait:boolean;
 constructor(retryInMs=60_000,reservationWait=false){super("BG_DEFERRED");this.retryInMs=retryInMs;this.reservationWait=reservationWait;}
}
export const isBgDeferred=(error:unknown):error is BgDeferred=>error instanceof BgDeferred;
