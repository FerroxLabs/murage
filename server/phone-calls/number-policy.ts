// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
// Owners: F1 supplies the number policy. F3 applies it to the final destination before placement.
import { COUNTRY_CODES, EMERGENCY_AND_SHORT, MIN_NATIONAL } from "./tables.ts";

export function phoneNumberAllowed(to: string): boolean {
  const digits = to.slice(1);
  const country = [digits.slice(0, 3), digits.slice(0, 2), digits.slice(0, 1)].find(code => COUNTRY_CODES.has(code));
  if (!country) return false;
  const national = digits.slice(country.length);
  if (country === "1") return /^[2-9][0-9]{9}$/.test(national) && national.slice(1, 3) !== "11";
  return national.length >= (MIN_NATIONAL[country] ?? 7) && !EMERGENCY_AND_SHORT.has(national);
}
