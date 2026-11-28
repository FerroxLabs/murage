// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test-process-only preload for a spawned server child (node --import <this file>), 1021 Retry live witness (MAIN ruling
// option B). It reclassifies POST /api/threads/:t/requests/:r/retry-delivery from "desktop" to "conversation" in THIS
// process's route policy, so a caller the gate admits to a conversation route (the browser door) reaches the retry handler
// and the handler's own owner gate (mayApprove) is what answers it. The shipped policy is untouched: no other process
// loads this file, and server/undelivered-card-attention.test.ts pins the desktop class at the route layer.
import { ROUTE_POLICY } from "../route-policy.ts";

const at = ROUTE_POLICY.findIndex(entry => typeof entry.path !== "string" && entry.path.test("/api/threads/t-1/requests/r-1/retry-delivery"));
if (at < 0 || ROUTE_POLICY[at].class !== "desktop") throw new Error("retry-route-conversation-preload: the retry-delivery entry moved");
ROUTE_POLICY[at] = { ...ROUTE_POLICY[at], class: "conversation" };
