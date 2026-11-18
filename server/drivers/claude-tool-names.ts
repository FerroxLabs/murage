// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Native CLI identities shared by the driver and the HighLevel classifier.
// Keep this leaf module independent of the driver/engine-policy import cycle.
export const CLAUDE_NATIVE_SHELL_TOOLS = Object.freeze({ bash: 'Bash', powershell: 'PowerShell' } as const);
