// SPDX-License-Identifier: AGPL-3.0-or-later
// Keep the cancellation fence and transport invocation in the same job.
export function scheduleDelivery<T>(dispatch:()=>T|Promise<T>):Promise<T>{
 return Promise.resolve().then(dispatch);
}
