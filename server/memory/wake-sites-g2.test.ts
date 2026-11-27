// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MEMORY V2 lane W, W-COMMIT per site through the real entry points (testing/commit-site-harness.ts), drivers in testing/site-drivers/g2.ts.
import { siteSuite } from "./testing/commit-site-harness.ts";
import { DRIVERS } from "./testing/site-drivers/g2.ts";

siteSuite("W-COMMIT per site: g2", DRIVERS);
