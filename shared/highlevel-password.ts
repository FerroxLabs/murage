// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Provider policy shared by the private server generator and provider-body schema. */
export function validHighLevelPassword(value: unknown): value is string {
  return typeof value === "string" && value.length >= 12 && /[A-Z]/u.test(value)
    && /[a-z]/u.test(value) && /[0-9]/u.test(value) && /[^A-Za-z0-9\s]/u.test(value);
}
