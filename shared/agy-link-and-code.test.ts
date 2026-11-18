// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { AGY_OAUTH_CLIENT_ID, AGY_OAUTH_REDIRECT, checkedGoogleLink, checkedOsc8Link, osc8Link } from "./agy-oauth-link.mjs";
import { SIGNIN_CODE_SHAPE, looksLikeSignInCode } from "./signin-code-shape.mjs";

const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"; // 43 characters, the RFC 7636 example
const link = (extra = "", base = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${AGY_OAUTH_CLIENT_ID}&redirect_uri=${encodeURIComponent(AGY_OAUTH_REDIRECT)}&response_type=code&code_challenge=${CHALLENGE}&code_challenge_method=S256&state=s1`) => base + extra;

describe("agy's Google link check", () => {
  it("accepts agy's own link, on either authorization path", () => {
    expect(checkedGoogleLink(link())).toBe(link());
    expect(checkedGoogleLink(link("", link().replace("/v2/auth", "/auth")))).not.toBeNull();
  });
  it("refuses another client, no PKCE, a short challenge, a duplicated parameter, a port, userinfo, http, another host, another path or another response type", () => {
    const bad = [
      link("", link().replace(AGY_OAUTH_CLIENT_ID, "other.apps.googleusercontent.com")), link("", link().replace("&code_challenge_method=S256", "")), link("", link().replace(CHALLENGE, "abc")),
      link("&redirect_uri=https%3A%2F%2Fevil.example%2F"), link("&client_id=x"), link("&state=s2"), link("&code_challenge=" + CHALLENGE),
      link("", link().replace("https://accounts.google.com", "https://accounts.google.com:8443")), link("", link().replace("https://", "https://u:p@")), link("", link().replace("https:", "http:")),
      link("", link().replace("accounts.google.com", "accounts.google.com.evil.example")), link("", link().replace("/o/oauth2/v2/auth", "/o/oauth2/token")), link("", link().replace("response_type=code", "response_type=token")),
    ];
    for (const raw of bad) expect(checkedGoogleLink(raw), raw).toBeNull();
  });
  it("finds the link inside an OSC 8 hyperlink and skips targets that fail the check", () => {
    const wrap = (target: string) => `\x1b]8;;${target}\x1b\\Open this link\x1b]8;;\x1b\\`;
    expect(osc8Link(wrap("https://x.example/"))).toBe("https://x.example/");
    expect(checkedOsc8Link(wrap("https://x.example/") + wrap(link()))).toBe(link());
    expect(checkedOsc8Link(wrap("https://x.example/"))).toBeNull();
    expect(checkedOsc8Link("no link here")).toBeNull();
  });
});

describe("the one code shape", () => {
  it("matches a Google code and the characters its pieces use, and nothing short or spaced", () => {
    expect(looksLikeSignInCode("4/0AfJohXn_abcdefghijklmnopqrstuvwxyz0123456789-ABC")).toBe(true);
    expect(looksLikeSignInCode("  4/0AfJohXn+abc#def%2Fghi.jklmnopqrstu  ")).toBe(true);
    for (const text of ["hello", "short-code-1234", "two words here that are long enough", "4/0AfJohXn_abc\n4/0AfJohXn_abc", "x".repeat(513), 12, undefined]) expect(looksLikeSignInCode(text), String(text)).toBe(false);
    expect(SIGNIN_CODE_SHAPE.test("a".repeat(20))).toBe(true);
  });
  it("is not an embedded scan: a code inside a sentence is not a match", () => {
    expect(looksLikeSignInCode("my code is 4/0AfJohXn_abcdefghijklmnopqrstuvwxyz0123")).toBe(false);
  });
});
