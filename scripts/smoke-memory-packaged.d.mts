import type { ChildProcess } from "node:child_process";
export function answerHelperProtocol(child: Pick<ChildProcess, "send">, message: unknown, settled?: Array<{ id: unknown; used: number }>): boolean;
export function probeEnvironment(options: { root: string; home: string; resources: string | null; backend: string; systemRoot?: string }): Record<string, string>;
export function recallUntilAnswered<A extends { hits?: Array<{ id: string }>; partial?: boolean }, R>(attempt: () => Promise<{ raw: R | undefined; answer: A }>, options?: { timeoutMs?: number; pauseMs?: number }): Promise<{ raw: R; answer: A; cutoffRetries: number }>;
