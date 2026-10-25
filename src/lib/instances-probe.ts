// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// The shared-request idea follows OpenMausBot's engine setup refresh (Apache-2.0), see NOTICE.

/** One engine probe in flight at a time per address. The store's focus refresh,
 *  the setup card's Check again and a returning tab all ask for /api/instances
 *  within moments of each other; each of those used to spawn its own version
 *  check on every engine. Callers that arrive while one is running get its
 *  answer. A failure reaches all of them, and the next call starts fresh. */
const inFlight = new Map<string, Promise<unknown>>();

export function probeInstances<T>(path: string, request: (path: string) => Promise<T>): Promise<T> {
  const running = inFlight.get(path);
  if (running) return running as Promise<T>;
  const started = request(path).finally(() => {
    if (inFlight.get(path) === started) inFlight.delete(path);
  });
  inFlight.set(path, started);
  return started;
}
