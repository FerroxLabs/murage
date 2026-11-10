// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Windows anchored-open helper for the Claude Code copy import (CONTRACTS-B 1.3 with amendments R1-R22), kept in its own translation
// unit like exclusion-lsa.c. exclusion.c calls anchored_win_register() from its init, Windows only.
#ifndef MURAGE_ANCHORED_WIN_H
#define MURAGE_ANCHORED_WIN_H
#include <node_api.h>

/** Adds anchorBegin, anchorOpen, anchorList, anchorRead, anchorStat, anchorClose and anchorEnd to `exports` (and, in a build made with
 * -DANCHOR_TEST_HOOKS, anchorTestStall, anchorTestRelease and anchorTestFail). */
void anchored_win_register(napi_env env, napi_value exports);
#endif
