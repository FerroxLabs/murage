// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one list of engines the engine-login relay accepts. The relay
// (engine-login.ts) and the route policy (route-policy.ts, which puts these
// paths in the `engine-login` class: owner-desktop session + step-up) both
// read it, so an engine the relay accepts can never reach it without step-up.
// Kept dependency-free: route-policy.ts imports nothing heavier than this.

export const ENGINE_LOGIN_ENGINES = ["codex", "claudeAgent", "antigravityAgent", "grokAgent", "kimiAgent", "opencodeGo"] as const;
export type EngineLoginEngine = (typeof ENGINE_LOGIN_ENGINES)[number];
export const ENGINE_LOGIN_PATH = new RegExp(`^/api/engine-login/(${ENGINE_LOGIN_ENGINES.join("|")})$`);
