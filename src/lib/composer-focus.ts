// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Composer.tsx listens for this and focuses the draft once it is on screen.
 *  `detail.botId` limits it to that bot's chat; `detail.slash` also opens the
 *  "/" menu on an empty draft. Its own module so a sender need not import the
 *  tray's hook (and the store) to send it. */
export const FOCUS_COMPOSER_EVENT = "murage:focus-composer";
