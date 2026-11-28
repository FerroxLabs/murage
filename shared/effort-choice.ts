// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

export function effortSelectionConflict({ effort, variant }: { effort?: unknown; variant?: unknown }): string | undefined {
  if (effort !== undefined && variant !== undefined) return "Choose one effort setting";
}
