import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EngineSignInGuide } from "./EngineSignInGuide";

const noop = () => {};
const grok = { label: "Grok", botName: "Ember", url: "https://accounts.x.ai/oauth2/device?user_code=67SE-48EK", code: "67SE-48EK", onOpen: noop };
const html = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(EngineSignInGuide, { ...grok, ...props } as never));
const BANNED = /terminal|IPv6|nameserver|browser automatically|Run this|\b(?:safe|unsafe|safety)\b|[–—]/i;

describe("the sign-in screen a customer sees", () => {
  it("opened for them: the code in large type with Copy, and the wait line", () => {
    const out = html({ opened: true });
    expect(out).toContain("Hey Ember, sign in to Grok");
    expect(out).toContain("Enter this code");
    expect(out).toContain("67SE-48EK");
    expect(out).toContain("Copy");
    expect(out).toContain("Waiting for you to finish in the other tab");
    expect(out).not.toMatch(BANNED);
  });
  it("could not open: the plain address and the code, Copy on both, and a button that opens it from a click", () => {
    const out = html({ opened: false });
    expect(out).toContain("Go to");
    expect(out).toContain("accounts.x.ai/oauth2/device");
    expect(out.match(/>Copy</g)?.length).toBe(2);
    expect(out).toContain("Open Grok sign-in");
    expect(out).not.toMatch(BANNED);
  });
  it("not tried yet: one big button", () => {
    expect(html({ opened: null })).toContain("Open Grok sign-in");
  });
  it("Claude has no code on the page, so no code line; its paste box rides in as a child", () => {
    const out = html({ label: "Claude", botName: undefined, url: "https://claude.com/cai/oauth/authorize?code=true", code: undefined, opened: true, children: createElement("input", { placeholder: "Paste the code" }) });
    expect(out).toContain("Sign in to Claude");
    expect(out).not.toContain("Enter this code");
    expect(out).toContain("Paste the code");
  });
  it("before the page is known it says it is getting ready, and shows no button", () => {
    const out = html({ url: undefined, code: undefined, opened: null });
    expect(out).toContain("sign-in ready");
    expect(out).not.toContain("<button");
  });
});
