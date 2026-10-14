// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Imported first by server/index.ts. ES modules run in import order, so this runs before any module that opens the database: the memory upgrade, if one
// is due, then answers /api/health (503, with progress) on the server's port from the first moment instead of leaving the port closed.
import "./boot-nonce.ts"; // takes the launch nonce out of the environment before anything else runs
import { enablePreListenHealth } from "./upgrade-health.ts";
enablePreListenHealth();
