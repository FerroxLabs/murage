// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Sidebar headings that are not teams (src/lib/new-team.ts, plus the
 * Projects heading the sidebar adds). */
export const RESERVED_TEAM_NAMES = ["General", "Bots", "Channels", "Bot Chats", "Pinned", "Projects"] as const;
export const TEAM_NAME_MAX = 60;
