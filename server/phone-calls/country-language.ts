// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
// Owners: F3 provides the country step of call-language resolution; the tables are C0's (tables.ts).
import { COUNTRY_CODES, COUNTRY_LANGUAGE, type CallLanguage } from "./tables.ts";

/** The E.164 calling code of a number: country codes are prefix-free, so at most one of the 1-3 digit prefixes is assigned. */
export function callingCode(to: string): string | undefined {
  if (!/^\+[1-9][0-9]{6,14}$/.test(to)) return undefined;
  for (const length of [1, 2, 3]) {
    const code = to.slice(1, 1 + length);
    if (COUNTRY_CODES.has(code)) return code;
  }
  return undefined;
}

/** The language a business at this number most likely speaks. Multilingual countries are absent from the table on purpose. */
export function countryLanguage(to: string): CallLanguage | undefined {
  const code = callingCode(to);
  return code === undefined ? undefined : COUNTRY_LANGUAGE[code];
}
