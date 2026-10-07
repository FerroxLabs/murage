// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CATEGORY_DOMAINS, CATEGORY_LIST_VERSION, categoryFor, registrableDomain, type SiteCategory } from "./browser-site-categories.ts";
import { PROTECTED_DOMAINS } from "./browser-protected-domains.ts";
import { PSL_EXCEPTIONS, PSL_RULES, PSL_WILDCARDS } from "./public-suffix-snapshot.ts";

const table: Array<[string, SiteCategory]> = [
  // askEveryStep: banks, brokerage, crypto, payments
  ["accounts.chase.com", "askEveryStep"],
  ["chase.com", "askEveryStep"],
  ["www.schwab.com", "askEveryStep"],
  ["www.paypal.com", "askEveryStep"],
  ["dashboard.stripe.com", "askEveryStep"],
  ["app.wise.com", "askEveryStep"],
  ["www.coinbase.com", "askEveryStep"],
  ["online.hsbc.co.uk", "askEveryStep"],
  ["login.barclays.co.uk", "askEveryStep"],
  ["www.navyfederal.org", "askEveryStep"],
  // askEveryStep: government and sensitive TLDs
  ["irs.gov", "askEveryStep"],
  ["www.irs.gov", "askEveryStep"],
  ["gov.uk", "askEveryStep"],
  ["www.tax.service.gov.uk", "askEveryStep"],
  ["service.gc.ca", "askEveryStep"],
  ["www.impots.gouv.fr", "askEveryStep"],
  ["www.bundesregierung.bund.de", "askEveryStep"],
  ["sede.gob.es", "askEveryStep"],
  ["my.gov.au", "askEveryStep"],
  ["www.army.mil", "askEveryStep"],
  ["www.example.bank", "askEveryStep"],
  ["www.example.insurance", "askEveryStep"],
  // askEveryStep: health, payroll, e-signing, insurance
  ["mychart.com", "askEveryStep"],
  ["www.kp.org", "askEveryStep"],
  ["app.gusto.com", "askEveryStep"],
  ["app.docusign.com", "askEveryStep"],
  ["www.geico.com", "askEveryStep"],
  // handover: password managers, stores
  ["bitwarden.com", "handover"],
  ["vault.bitwarden.com", "handover"],
  ["my.1password.com", "handover"],
  ["chromewebstore.google.com", "handover"],
  ["chrome.google.com", "handover"],
  ["microsoftedge.microsoft.com", "handover"],
  ["addons.mozilla.org", "handover"],
  // neverDefault: adult and piracy
  ["www.pornhub.com", "neverDefault"],
  ["onlyfans.com", "neverDefault"],
  ["example.xxx", "neverDefault"],
  ["thepiratebay.org", "neverDefault"],
  ["proxy.1337x.to", "neverDefault"],
  // normal
  ["example.com", "normal"],
  ["www.google.com", "normal"],
  ["mail.google.com", "normal"],
  ["docs.microsoft.com", "normal"],
  ["example.co.uk", "normal"],
  ["www.example.co.uk", "normal"],
  ["foo.github.io", "normal"],
  ["foo.bar.github.io", "normal"],
  ["localhost", "normal"],
  // a lookalike is not a subdomain
  ["notchase.com", "normal"],
  ["chase.com.evil.example", "normal"],
  ["irs.gov.example.com", "normal"],
  ["bitwarden.com.example.org", "normal"],
  // case, trailing dot
  ["ACCOUNTS.CHASE.COM", "askEveryStep"],
  ["accounts.chase.com.", "askEveryStep"],
  ["IRS.GOV.", "askEveryStep"],
  // IP literals are normal
  ["127.0.0.1", "normal"],
  ["192.168.1.20", "normal"],
  ["[::1]", "normal"],
  ["::1", "normal"],
  ["2001:db8::1", "normal"],
  // IDN: unicode and punycode forms of the same host agree
  ["bücher.example", "normal"],
  ["xn--bcher-kva.example", "normal"],
  ["münchen.de", "normal"],
  ["xn--chse-0ra.com", "normal"],
  // unsure means stricter
  ["", "askEveryStep"],
  ["   ", "askEveryStep"],
  [".", "askEveryStep"],
  ["..", "askEveryStep"],
  ["a..b", "askEveryStep"],
  ["bad host.com", "askEveryStep"],
  ["http://chase.com", "askEveryStep"],
  ["a/b.com", "askEveryStep"],
  ["user@chase.com", "askEveryStep"],
  ["exa mple.com", "askEveryStep"],
  ["-.com", "askEveryStep"],
  // Opus gate M1: an invalid input is classified by the hostname it carries, and the stricter result wins
  ["bitwarden.com:443", "handover"],
  ["user@pornhub.com", "neverDefault"],
  ["bitwarden.com..", "handover"],
  ["bitwarden.com...", "handover"],
  ["https://vault.bitwarden.com/#/login", "handover"],
  ["pornhub.com/videos", "neverDefault"],
  ["accounts.chase.com:8443", "askEveryStep"],
  ["face.cafe:80", "askEveryStep"],
  ["dead:beef", "askEveryStep"],
  ["1:2:3:4:5:6:7:8:9", "askEveryStep"],
  ["::ffff:127.0.0.1", "normal"],
  ["fe80::1:2", "normal"],
  // Opus gate M2: password managers on other hosts and regions
  ["passwords.google.com", "handover"],
  ["google.com", "normal"],
  ["1password.eu", "handover"],
  ["my.1password.ca", "handover"],
  ["vault.bitwarden.eu", "handover"],
  ["keepersecurity.eu", "handover"],
  ["lastpass.eu", "handover"],
  ["pass.proton.me", "handover"],
  // Opus gate M3: MyChart on a health system's own domain
  ["mychart.example-health.org", "askEveryStep"],
  ["mychart.clevelandclinic.org", "askEveryStep"],
  ["mychart.bitwarden.com", "handover"],
  ["notmychart.example.org", "normal"],
  // Opus gate Low: national portals
  ["www.elster.de", "askEveryStep"],
  ["www.canada.ca", "askEveryStep"],
  ["digid.nl", "askEveryStep"],
  ["mijn.belastingdienst.nl", "askEveryStep"],
  ["assure.ameli.fr", "askEveryStep"],
];

describe("categoryFor table", () => {
  for (const [host, want] of table) {
    it(`${JSON.stringify(host)} -> ${want}`, () => {
      expect(categoryFor(host)).toBe(want);
    });
  }
  it("non-string input is askEveryStep", () => {
    expect(categoryFor(undefined as unknown as string)).toBe("askEveryStep");
    expect(categoryFor(null as unknown as string)).toBe("askEveryStep");
    expect(categoryFor(42 as unknown as string)).toBe("askEveryStep");
  });
});

describe("registrableDomain (public suffix snapshot)", () => {
  const cases: Array<[string, string | null]> = [
    ["example.com", "example.com"],
    ["a.b.example.com", "example.com"],
    ["example.co.uk", "example.co.uk"],
    ["www.example.co.uk", "example.co.uk"],
    ["co.uk", null],
    ["com", null],
    ["foo.github.io", "foo.github.io"],
    ["x.foo.github.io", "foo.github.io"],
    ["github.io", null],
    ["www.ck", "www.ck"], // exception !www.ck
    ["something.ck", null], // wildcard *.ck makes this a suffix
    ["foo.something.ck", "foo.something.ck"], // wildcard *.ck
    ["city.kawasaki.jp", "city.kawasaki.jp"], // exception !city.kawasaki.jp
    ["a.city.kawasaki.jp", "city.kawasaki.jp"],
    ["x.foo.kawasaki.jp", "x.foo.kawasaki.jp"], // wildcard *.kawasaki.jp
    ["xn--bcher-kva.example", "xn--bcher-kva.example"],
    ["bücher.example", "xn--bcher-kva.example"],
    ["localhost", null],
    ["127.0.0.1", null],
  ];
  for (const [host, want] of cases) it(`${host} -> ${want}`, () => expect(registrableDomain(host)).toBe(want));
});

describe("lists", () => {
  it("every domain on the legacy protected list is categorised (none fall to normal)", () => {
    for (const domain of PROTECTED_DOMAINS) {
      expect(categoryFor(domain), domain).not.toBe("normal");
      expect(categoryFor(`login.${domain}`), domain).not.toBe("normal");
    }
  });
  it("password managers and stores are handover, banks are not", () => {
    expect(categoryFor("proton.me")).toBe("handover");
    expect(categoryFor("nordpass.com")).toBe("handover");
    expect(categoryFor("capitalone.com")).toBe("askEveryStep");
  });
  it("exports a version, bumped for the Opus gate list changes", () => {
    expect(Number.isInteger(CATEGORY_LIST_VERSION)).toBe(true);
    expect(CATEGORY_LIST_VERSION).toBeGreaterThanOrEqual(2);
  });
  it("an all-hex host with a port is not taken for an IPv6 literal", () => {
    expect(categoryFor("face.cafe:80")).not.toBe("normal");
    expect(registrableDomain("face.cafe:80")).toBeNull();
  });
  it("no public-suffix rule equals or ends in a listed domain (subdomains must inherit)", () => {
    const listed = [...CATEGORY_DOMAINS.handover, ...CATEGORY_DOMAINS.neverDefault, ...CATEGORY_DOMAINS.askEveryStep];
    expect(listed.length).toBeGreaterThan(100);
    const rules = [...PSL_RULES, ...PSL_WILDCARDS, ...PSL_EXCEPTIONS];
    const clashes: string[] = [];
    for (const domain of listed) {
      for (const rule of rules) if (rule === domain || rule.endsWith(`.${domain}`)) clashes.push(`${rule} vs ${domain}`);
    }
    expect(clashes).toEqual([]);
  });
});

describe("public-suffix snapshot licence header", () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  it("the snapshot carries the MPL-2.0 data licence, not AGPL", () => {
    const first = read("./public-suffix-snapshot.ts").split("\n")[0];
    expect(first).toBe("// SPDX-License-Identifier: MPL-2.0");
  });
  it("the generator template writes the same header", () => {
    const generator = read("../scripts/generate-public-suffix-snapshot.mjs");
    expect(generator).toContain("const out = `// SPDX-License-Identifier: MPL-2.0\n");
  });
});
