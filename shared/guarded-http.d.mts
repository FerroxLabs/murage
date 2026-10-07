// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Readable } from "node:stream";
import type { LocalConfirmation, RequestKind } from "./remote-mcp-url.mjs";

export class GuardedHttpError extends Error {
  code: string;
  needs?: LocalConfirmation;
  detail?: string;
  constructor(code: string, extra?: { needs?: string; cause?: unknown });
}

export interface GuardedRequestOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  kind?: RequestKind;
  mode?: "inspect" | "request";
  confirmed?: LocalConfirmation | null;
  maxBytes?: number;
  dnsMs?: number;
  connectMs?: number;
  totalMs?: number;
  signal?: AbortSignal;
  responseMode?: "buffer" | "stream";
  resolver?: (hostname: string) => Promise<ReadonlyArray<{ address: string; family?: number }>>;
}

export interface GuardedResponseBase {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  remoteAddress: string;
  url: string;
  hops: number;
  discard(): void;
}
export interface GuardedBufferResponse extends GuardedResponseBase { body: Buffer }
export interface GuardedStreamResponse extends GuardedResponseBase { stream: Readable; close(): void }

export function guardedRequest(options: GuardedRequestOptions & { responseMode: "stream" }): Promise<GuardedStreamResponse>;
export function guardedRequest(options: GuardedRequestOptions & { responseMode?: "buffer" }): Promise<GuardedBufferResponse>;
export function guardedRequest(options: GuardedRequestOptions): Promise<GuardedBufferResponse | GuardedStreamResponse>;
export function validateRequestHeaders(headers: Record<string, string> | undefined): Record<string, string>;
