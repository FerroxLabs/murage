// SPDX-License-Identifier: AGPL-3.0-or-later
// Test-only preload for a real job launcher: its own launch meter treats the relay proxy fixture as an owned entry,
// exactly as a packaged launcher treats a bundled proxy.
import {registerOwnedChildForTest} from "../io-child-meter.ts";
registerOwnedChildForTest("testing/relay-io-proxy.fixture");
