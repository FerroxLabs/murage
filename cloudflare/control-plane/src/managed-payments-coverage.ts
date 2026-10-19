// SPDX-License-Identifier: AGPL-3.0-or-later
// DATA, not logic: the buyer countries where Stripe Managed Payments takes on indirect-tax liability for cross-border sales of digital
// products (it calculates, collects, files and remits VAT/GST/sales tax). Managed Payments accepts buyers in more countries than these;
// outside this list the seller (Ferrox Labs) stays responsible for the tax, so a buyer there is only sold to when Ferrox has its own tax
// registration for that country (FERROX_TAX_COUNTRIES), else checkout stops with "please try again".
// Source: https://docs.stripe.com/payments/managed-payments/tax-compliance#cross-border-sales (checked 2026-10-10). Re-check when Stripe
// changes the list; the routing reads only this constant.
// Note from the same page: Serbia (RS) is covered only for sellers NOT registered for VAT in Serbia (Ferrox is not).
export const MANAGED_PAYMENTS_TAX_COVERAGE = {
  source: "https://docs.stripe.com/payments/managed-payments/tax-compliance#cross-border-sales",
  checkedAt: "2026-10-10",
  countries: [
    // Africa
    "CM", "EG", "GH", "KE", "NG", "UG", "ZA", "ZM", "ZW",
    // Asia Pacific
    "AM", "AU", "AZ", "BN", "GE", "HK", "ID", "IL", "IN", "JP", "KG", "KR", "KW", "KZ", "LA", "MO", "MY", "NP", "NZ", "PH", "QA", "SA", "SG",
    "TH", "TJ", "TR", "TW", "VN",
    // Europe (non-EU)
    "AL", "BY", "CH", "GB", "GI", "IS", "LI", "MD", "NO", "RS", "UA",
    // European Union
    "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT",
    "RO", "SE", "SI", "SK",
    // Latin America and the Caribbean
    "BB", "BM", "KY", "MX", "VG",
    // North America
    "CA", "US",
  ],
} as const;
