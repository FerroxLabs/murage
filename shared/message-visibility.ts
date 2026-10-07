// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs

/** Error activity is a visible system row even when ordinary tool activity is hidden. */
export function isErrorActivity(message: { kind?: string; tool?: { name: string; ok?: boolean } }): boolean {
  return message.kind === "activity" && !!message.tool && (message.tool.ok === false || message.tool.name.startsWith("error:"));
}
