/** Explicit reviewable exception on a transport argument, never a file-wide exemption. */
export function NotModelRequest<T>(reason: string, value: T): T {
  void reason;
  return value;
}

/** Transport classes and adapters expose this brand so the inventory follows
 * receivers through aliases and interfaces, including unfamiliar SDK methods. */
export interface EngineTransport {
  readonly engineTransport: true;
}
