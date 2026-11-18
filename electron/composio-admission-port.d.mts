import type { ComposioLifecycle } from "./composio-lifecycle.mjs";
export function createComposioAdmissionHost(options: {
  authority(): ComposioLifecycle;
  send(message: object): void;
  isCurrent?: () => boolean;
}): { transport: typeof fetch; receive(message: unknown): boolean; dispose(): void };
