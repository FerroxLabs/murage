// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
export class WindowsSecurityTimeoutError extends Error {
  constructor(){super('security read timed out');}
}
