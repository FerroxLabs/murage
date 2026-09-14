export const limits: Readonly<{ frame: number; control: number; key: number; bytes: number }>;
export function safePath(value: unknown): boolean;
export function encodeRequest(request: Record<string, unknown>, identity?: string): { header: Buffer; key: Buffer };
export interface ControlProtocol {
  readonly state: string;
  readonly plaintextComplete: boolean;
  plaintext(bytes: number): void;
  command(event: string): string;
  receive(bytes: Buffer): { event: string; fields: string[] }[];
  close(code: number | null): { guardsClosed: boolean; helperClosed: boolean };
}
export function createControlProtocol(nonce: string, operation: string, maxBytes?: number): ControlProtocol;
