// SPDX-License-Identifier: AGPL-3.0-or-later
import { mergeConfig } from "vitest/config";
import config from "./vite.config.ts";
import NightlySequencer from "./scripts/nightly-sequencer.mjs";

export default mergeConfig(config, {
  test: { sequence: { sequencer: NightlySequencer } },
});
