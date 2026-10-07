// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Types for the server's use of desktop-relaunch.mjs (Murage for Chrome
// registers its helper through the AppImage file). The desktop imports the
// module as JavaScript.
export const APPIMAGE_RELAUNCH_SCRIPT: string;
export function runningAppImage(options?: { platform?: string; env?: Record<string, string | undefined>; execPath?: string }): string | null;
export function appImageLaunchable(file: string, options?: { access?: (file: string, mode?: number) => void; stat?: (file: string) => { isFile(): boolean } }): boolean;
export function relaunchBlockedCode(options?: Record<string, unknown>): string | null;
export function appImageRelaunchEnv(env: Record<string, string | undefined>, appDir: string): Record<string, string | undefined>;
export function relaunchDesktop(options: Record<string, unknown>): unknown;
