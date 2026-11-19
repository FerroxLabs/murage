// SPDX-License-Identifier: AGPL-3.0-or-later
export const PICTURE_FILE: string;
export const PICTURE_VERSION: number;
export const PICTURE_MAX_BYTES: number;
export function isInertSvg(svg: unknown): boolean;
export function validatePicture(value: unknown): { v: 1; tipNext: number; faceA: string; faceB: string; team?: { faces: string[]; more: number }; tip: { id: string; head: string; line: string; try: string }; at: number } | null;
export function readStartupPicture(options?: { userData?: string | (() => string); fsImpl?: unknown }): ReturnType<typeof validatePicture>;
export function writeStartupPicture(options?: { userData?: string | (() => string); picture?: unknown; fsImpl?: unknown }): boolean;
