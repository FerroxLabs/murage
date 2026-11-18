// Serialization checks never grant authority to a later write. Only the
// registered synchronous writer closure can release the immutable frame.
export type EngineWireRelease = <T>(wire: string, write: () => T, validate?: () => void) => T;
const wireFences = new WeakMap<() => void, { check: (bytes: number) => void; release: EngineWireRelease }>();
export function bindEngineWireFence(before: () => void, check: (bytes: number) => void, release: EngineWireRelease): void {
  wireFences.set(before, { check, release });
}
export function accountEngineWire(before: (() => void) | undefined, wire: string): string {
  if (before) wireFences.get(before)?.check(Buffer.byteLength(wire));
  return wire;
}
export function emitEngineWire<T>(before: (() => void) | undefined, wire: string, write: () => T, validate?: () => void): T {
  const fence = before ? wireFences.get(before) : undefined;
  if (fence) return fence.release(wire, write, validate);
  validate?.();
  return write();
}
export function engineJsonLine(value: unknown, beforeWrite?: () => void): string {
  return accountEngineWire(beforeWrite, JSON.stringify(value) + "\n");
}
export function engineJsonBody(value: unknown, beforeWrite?: () => void): string {
  return accountEngineWire(beforeWrite, JSON.stringify(value));
}
