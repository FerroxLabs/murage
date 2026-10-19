// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The words for "which Murage am I running": the line the Copy version button
// puts on the clipboard, for a support message or a bug report.

/** "Murage 1.0.2 (darwin/arm64)". The build is left out where the host does not say it (the browser door), never guessed. */
export function copyVersionText(version: string, platform?: string | null, arch?: string | null): string {
  const build = [platform, arch].map((part) => part?.trim()).filter(Boolean).join("/");
  return build ? `Murage ${version} (${build})` : `Murage ${version}`;
}
