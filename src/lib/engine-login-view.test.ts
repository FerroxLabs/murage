// Codex, Grok and Claude below are what the pinned CLIs really printed on the build box (2026-11-01), escape codes and all.
// Kimi's is shaped like Grok's from the 2026-10-15 measurement (its CLI is not on the build box), so it is a likeness, not a capture.
import { describe, expect, it } from "vitest";

import { checkAuthUrl, findAuthLinks } from "./engine-login-terminal";
import { displayAddress, keepTail, KEEP_CHARS, parseSignIn } from "./engine-login-view";

const CODEX = "\r\nWelcome to Codex [v\u001b[90m0.151.0\u001b[0m]\r\n\r\nFollow these steps to sign in with ChatGPT using device code authorization:\r\n\r\n1. Open this link in your browser and sign in to your account\r\n   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\r\n\r\n2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m\r\n   \u001b[94mSOKN-ZVOHN\u001b[0m\r\n\r\n\u001b[90mContinue only if you started this login in Codex. If a website or another person gave you this code, cancel.\u001b[0m\r\n";
const GROK = "No routable interface for IPv6: IPv6 is disabled\r\nCouldn't get any nameserver address\r\nTo sign in, open this URL in your browser:\r\n\r\n  https://accounts.x.ai/oauth2/device?user_code=67SE-48EK\r\n\r\n  (Could not open browser automatically — open the URL above manually.)\r\n\r\nConfirm this code in your browser:\r\n\r\n  67SE-48EK\r\n\r\n\u001b[90mOnly continue with a code you requested. Don't share it with anyone.\u001b[0m\r\n\r\nWaiting for authorization...\r\n";
const CLAUDE_URL = "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&state=x6HdcD13NYUOpkz6PGJRwIF5NB4vwU5PQUl4FvjgrvY";
const CLAUDE = `Opening browser to sign in…\r\nIf the browser didn't open, visit: \u001b]8;;${CLAUDE_URL}\u0007${CLAUDE_URL}\u001b]8;;\u0007\r\nPaste code here if prompted > `;
const KIMI = "Please visit the following URL to finish authorization.\r\nVerification URL: https://www.kimi.ai/code/authorize_device?user_code=KM4T9XQ2\r\nUser code: KM4T9XQ2\r\n";

describe("what a customer needs out of a vendor sign-in screen", () => {
  it("Codex: the device page and the one-time code, without the colour codes", () => {
    expect(parseSignIn(CODEX)).toEqual({ url: "https://auth.openai.com/codex/device", code: "SOKN-ZVOHN" });
  });
  it("Grok: the page and the code, never the IPv6, nameserver or browser lines", () => {
    expect(parseSignIn(GROK)).toEqual({ url: "https://accounts.x.ai/oauth2/device?user_code=67SE-48EK", code: "67SE-48EK" });
  });
  it("Claude: the link once (the OSC 8 copy is not a second one) and no code, because the code is pasted back", () => {
    expect(parseSignIn(CLAUDE)).toEqual({ url: CLAUDE_URL });
  });
  it("Kimi: the page, and the code on its own line", () => {
    expect(parseSignIn(KIMI)).toEqual({ url: "https://www.kimi.ai/code/authorize_device?user_code=KM4T9XQ2", code: "KM4T9XQ2" });
  });
  it("says nothing until there is something to say, and never takes an off-list link", () => {
    expect(parseSignIn("")).toEqual({});
    expect(parseSignIn("Waiting for authorization...\r\nOnly continue with a code you requested.")).toEqual({});
    expect(parseSignIn("Open https://evil.example/device and enter ABCD-1234")).toEqual({ code: "ABCD-1234" });
  });
  it("joins a link the CLI broke across two lines", () => {
    expect(parseSignIn("Open this:\r\n  https://accounts.x.ai/oauth2/device?user_\r\ncode=67SE-48EK\r\n").url).toBe("https://accounts.x.ai/oauth2/device?user_code=67SE-48EK");
  });
  it("shows a link as a plain address", () => {
    expect(displayAddress("https://accounts.x.ai/oauth2/device?user_code=67SE-48EK")).toBe("accounts.x.ai/oauth2/device");
    expect(displayAddress(CLAUDE_URL)).toBe("claude.com/cai/oauth/authorize");
  });
  it("keeps only the tail of a long screen", () => {
    expect(keepTail("x".repeat(KEEP_CHARS + 50)).length).toBe(KEEP_CHARS);
  });
});

describe("the vendor pages every engine really prints are allowed", () => {
  const printed: Record<string, string> = {
    codex: "https://auth.openai.com/codex/device", grokAgent: "https://accounts.x.ai/oauth2/device?user_code=67SE-48EK",
    claudeAgent: CLAUDE_URL, kimiAgent: "https://www.kimi.ai/code/authorize_device?user_code=KM4T9XQ2",
  };
  for (const [engine, url] of Object.entries(printed)) it(`${engine}: ${new URL(url).hostname}`, () => expect(checkAuthUrl(url)).toBe(new URL(url).href));
  it("the real Grok screen yields a clickable link on the exact row the URL is on", () => {
    const rows = stripped(GROK).map((text) => ({ text, isWrapped: false }));
    const links = findAuthLinks(rows, 1);
    expect(links.map((link) => link.url)).toEqual(["https://accounts.x.ai/oauth2/device?user_code=67SE-48EK"]);
  });
});
function stripped(screen: string): string[] { return screen.replace(/\u001b\[[0-9;]*m/g, "").split("\r\n"); }
