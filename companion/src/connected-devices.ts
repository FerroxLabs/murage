/** Count live authenticated event streams per device. A phone may briefly
 * overlap old and replacement streams while changing routes, so presence is a
 * reference count rather than a boolean.
 *
 * A stream opened by a browser is also filed under the browser SESSION it was
 * authorised by. A device and a session are different boundaries: revoking a
 * device ends every stream it owns, while signing one browser out, evicting
 * it, or letting it expire must end that browser's streams and leave the
 * other browsers on the same device alone. The session key is the registry's
 * stable identity for the session record — never the cookie, which renewal
 * rotates while the session itself carries on. */
export function createConnectedDeviceTracker() {
  interface ConnectedStream {
    closed: boolean;
    deviceId: string;
    sessionId: string | null;
    terminate: () => void;
  }

  const streams = new Map<string, Set<ConnectedStream>>();
  const sessions = new Map<string, Set<ConnectedStream>>();

  const forget = (stream: ConnectedStream) => {
    const current = streams.get(stream.deviceId);
    current?.delete(stream);
    if (current?.size === 0) streams.delete(stream.deviceId);
    if (stream.sessionId === null) return;
    const bySession = sessions.get(stream.sessionId);
    bySession?.delete(stream);
    if (bySession?.size === 0) sessions.delete(stream.sessionId);
  };

  const terminateAll = (active: Iterable<ConnectedStream>) => {
    // Remove presence before terminating sockets. Their close handlers call
    // the per-stream cleanup again, which must be an idempotent no-op.
    const ending = [...active].filter((stream) => !stream.closed);
    for (const stream of ending) {
      stream.closed = true;
      forget(stream);
    }
    for (const stream of ending) {
      try {
        stream.terminate();
      } catch {
        // One broken socket must not keep the other revoked streams alive.
      }
    }
  };

  const open = (
    deviceId: string,
    terminate: () => void = () => {},
    sessionId: string | null = null,
  ): (() => void) => {
    const stream: ConnectedStream = { closed: false, deviceId, sessionId, terminate };
    const active = streams.get(deviceId) ?? new Set<ConnectedStream>();
    active.add(stream);
    streams.set(deviceId, active);
    if (sessionId !== null) {
      const bySession = sessions.get(sessionId) ?? new Set<ConnectedStream>();
      bySession.add(stream);
      sessions.set(sessionId, bySession);
    }
    return () => {
      if (stream.closed) return;
      stream.closed = true;
      forget(stream);
    };
  };

  const ids = (): string[] => [...streams.keys()];

  const disconnect = (deviceId: string): boolean => {
    const active = streams.get(deviceId);
    if (!active) return false;
    terminateAll(active);
    return true;
  };

  /** End every stream authorised by one browser session, and nothing else. */
  const disconnectSession = (sessionId: string): boolean => {
    const active = sessions.get(sessionId);
    if (!active) return false;
    terminateAll(active);
    return true;
  };

  return Object.freeze({ open, ids, disconnect, disconnectSession });
}
