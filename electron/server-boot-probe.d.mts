// Types for the tests that read the desktop's boot probe from TypeScript.
export declare const launchOf: (nonce: unknown) => string;
export interface ServerIdentityOptions {
  port: number;
  nonce: () => unknown;
  bootTimeoutMs: number;
  isExited?: () => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
  extendWhile?: () => boolean;
  progressFresh?: () => boolean;
  bootProgressFresh?: () => boolean;
  [key: string]: unknown;
}
export declare function pollServerIdentity(options: ServerIdentityOptions): Promise<{ status?: string; [key: string]: unknown }>;
