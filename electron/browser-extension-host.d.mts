// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Readable, Writable } from 'node:stream';
import type { Socket } from 'node:net';
export const MAX_NATIVE_FRAME: number;
export function encodeFrame(message: unknown, max?: number): Buffer;
export class FrameDecoder { constructor(onMessage: (message: unknown) => void, max?: number); push(chunk: Buffer): void; end(): void; }
export function authProof(token: string, role: string, serverNonce: string, hostNonce: string): string;
export function readHostConfig(configPath: string, options?: {platform?: string; uid?: number; verifyWindowsOwnership?: (path:string)=>boolean}): {version:1; token:string; socketPath:string};
export function runNativeHost(options: {input?:Readable;output?:Writable; config:{socketPath:string;token:string};connect?:(options:{path:string})=>Socket;handshakeTimeoutMs?:number}): {stop:()=>void};
