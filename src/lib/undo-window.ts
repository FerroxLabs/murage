// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// How long an Undo stays open. Its own file so the approval card, which is on
// the first paint, can read the number without loading the Undo toast host.

export const UNDO_WINDOW_MS = 8000;
