// SPDX-License-Identifier: AGPL-3.0-or-later
// Deferral producer owner: scperf-p1. Memory retry consumers owner: scperf-p1.
export class BgDeferred extends Error {
 readonly retryInMs:number;
 constructor(retryInMs=60_000){super("BG_DEFERRED");this.retryInMs=retryInMs;}
}
export const isBgDeferred=(error:unknown):error is BgDeferred=>error instanceof BgDeferred;
