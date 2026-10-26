// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// The paste a chat's "Review and keep" hands to Settings > Memory > Learn
// about me (PASTE-CAPTURE-FIX 3.3). It stays in this window: nothing reaches
// the server until the owner keeps a line. Learn about me reads it once when
// it opens, then it is cleared.
let handed: string | null = null;

export function handLamText(text: string): void { handed = text; }
export function peekLamText(): string | null { return handed; }
export function clearLamText(): void { handed = null; }
