// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Bot, InstanceInfo } from "@/state/store";
import { builtInBrowserEnabled, type FeatureFlagConfig } from "./feature-flags";

/** Mirrors the server predicate using the panel's mode and browser signals. */
export function browserIsThePlace(
  bot: Pick<Bot, "computer" | "browser">,
  config: FeatureFlagConfig | null | undefined,
  instance: Pick<InstanceInfo, "capabilities"> | undefined,
): boolean {
  return (bot.computer === "off" || bot.computer === "browser")
    && builtInBrowserEnabled(config)
    && bot.browser !== false
    && instance?.capabilities?.browserMcp === true;
}
