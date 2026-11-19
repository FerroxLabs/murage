// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one line a refused turn is told with. It lives in a module that imports nothing, because spawned MCP proxies load it
// (through proxy-turn-release.ts) before they answer `initialize`: taking it from ledger-refusal.ts loaded the server's
// fence and lease graph into every proxy and made each list its tools late (nativecrash-g0-proxy-import-1019.test.ts).
export const LEDGER_REFUSAL_LINE = "I stopped this turn because some of its context is no longer available.";
