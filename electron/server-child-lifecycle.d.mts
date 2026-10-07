// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
export declare const OWNED_WORK_TIMEOUT_MS: number;
export declare const GRACEFUL_CLOSE_MESSAGE: Readonly<{ type: "murage:close" }>;
export declare const GRACEFUL_CLOSE_TIMEOUT_MS: number;
export declare const SERVER_CHILD_STOP_TIMEOUT_MS: number;
export interface ServerChildLifecycle {
  readonly exited: boolean;
  readonly failed: boolean;
  readonly exit: Promise<void>;
  stop(options?: { graceful?: boolean }): Promise<void>;
}
export declare function createServerChildLifecycle(
  child: NodeJS.EventEmitter & { exitCode?: number | null; signalCode?: string | null; kill(): unknown; postMessage?(message: unknown): void },
  options?: { timeoutMs?: number; gracefulClose?: boolean; graceMs?: number },
): ServerChildLifecycle;
export declare function awaitOwnedWork(work: Promise<unknown>, label: string, timeoutMs?: number): Promise<void>;
