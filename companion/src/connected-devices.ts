/** Count live authenticated event streams per device. A phone may briefly
 * overlap old and replacement streams while changing routes, so presence is a
 * reference count rather than a boolean. */
export function createConnectedDeviceTracker() {
  const streams = new Map<string, number>();

  const open = (deviceId: string): (() => void) => {
    streams.set(deviceId, (streams.get(deviceId) ?? 0) + 1);
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      const remaining = (streams.get(deviceId) ?? 1) - 1;
      if (remaining > 0) streams.set(deviceId, remaining);
      else streams.delete(deviceId);
    };
  };

  const ids = (): string[] => [...streams.keys()];

  return Object.freeze({ open, ids });
}
