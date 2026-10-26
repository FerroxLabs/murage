// Release finding 10-B1/B2: a Cloud home's `owner-phone` session maps to the `desktop` surface, so four decisions only the
// computer running Murage may make (putting a site online, the browser's Full mode, approved sites, wider message reach)
// were reachable from a phone. `requestFromComputer` is the question those handlers now ask.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { setCloudIdentity } from "./cloud-request-identity.ts";
import type { CloudDevice } from "./cloud-sessions.ts";
import { publishAnswerAllowed } from "./publish/publish-ops.ts";
import { isDesktopApp } from "./cloud-owner-surface.ts";
import { requestFromComputer, requestSurface } from "./sse-visibility.ts";

const here = dirname(fileURLToPath(import.meta.url));
const saved = process.env.MURAGE_CLOUD_ROLE;
afterEach(() => {
  if (saved === undefined) delete process.env.MURAGE_CLOUD_ROLE;
  else process.env.MURAGE_CLOUD_ROLE = saved;
});

const withScope = (scope: string): Record<string, string> => {
  const headers = {};
  setCloudIdentity(headers, { scope } as unknown as CloudDevice);
  return headers;
};

describe("which Cloud sessions are the computer", () => {
  it("is the owner's desktop, and not the owner's phone", () => {
    process.env.MURAGE_CLOUD_ROLE = "home";
    const phone = withScope("owner-phone");
    const desktop = withScope("owner-desktop");
    // the phone keeps ordinary owner access...
    expect(requestSurface(phone)).toBe("desktop");
    // ...but is not the computer
    expect(requestFromComputer(phone)).toBe(false);
    expect(requestFromComputer(desktop)).toBe(true);
    expect(requestFromComputer(withScope("browser"))).toBe(false);
    // the publish gate then refuses an Allow from it
    expect(publishAnswerAllowed("publish-1", "allow", requestFromComputer(phone) ? "desktop" : "elsewhere")).toBe(false);
    expect(publishAnswerAllowed("publish-1", "allow", requestFromComputer(desktop) ? "desktop" : "elsewhere")).toBe(true);
  });
});

describe("one desktop-app predicate (int/104-rc1 collapse)", () => {
  it("requestFromComputer and isDesktopApp agree for every Cloud scope, on and off a Cloud home", () => {
    for (const role of ["home", undefined]) {
      if (role) process.env.MURAGE_CLOUD_ROLE = role;
      else delete process.env.MURAGE_CLOUD_ROLE;
      for (const scope of ["owner-phone", "owner-desktop", "browser", "companion", "none"]) {
        const headers = withScope(scope);
        expect(requestFromComputer(headers)).toBe(isDesktopApp(headers));
      }
      expect(requestFromComputer({})).toBe(isDesktopApp({}));
    }
  });
});

describe("the handlers ask the computer, not the surface", () => {
  const source = readFileSync(join(here, "index.ts"), "utf8");
  it("gates publish Allow, Full mode, approved sites, message reach and putting a site online on isDesktopApp", () => {
    expect(source.match(/const onComputer = isDesktopApp\(req\.headers, url\.searchParams\);/g)).toHaveLength(2);
    expect(source).toContain('if (!isDesktopApp(req.headers, url.searchParams)) return json(res, 403, browserExtError("browserExt.full.errorDesktopOnly"));');
    expect(source).toContain('if (mode !== "full" && !isDesktopApp(req.headers, url.searchParams) && rank[mode]');
    expect(source).toContain("const ownerDesktop = isDesktopApp(req.headers, url.searchParams);");
    expect(source).toContain("const desktopSurface = isDesktopApp(req.headers, url.searchParams);");
    expect(source).toContain('if (!isDesktopApp(req.headers, url.searchParams)) return json(res, 403, { error: PUBLISH_NEEDS_COMPUTER });');
    expect(source).not.toMatch(/const onComputer = requestSurface\(/);
    expect(source).not.toContain("requestFromComputer(");
  });
});

describe("All chats answers a Cloud home's paired phone as the phone (chats slice 1)", () => {
  const source = readFileSync(join(here, "index.ts"), "utf8");
  it("splits desktop from phone with isDesktopApp and admits only the desktop app or a companion-proven caller", () => {
    expect(source).toContain("const chatsDesktop = chatsView && isDesktopApp(req.headers, url.searchParams);");
    expect(source).toContain('if (chatsView && !chatsDesktop && !companionAuthorized(req.headers)) return json(res, 404, { error: "no such route" });');
    expect(source).toContain("const visible = chatsDesktop ? null : new Set(store.visibleThreadIds());");
    expect(source).toContain("scope = chatSearchThreads(chatSource(chatsDesktop), chatFiltersFromQuery(url.searchParams))");
    const chats = source.slice(source.indexOf('if (method === "GET" && path === "/api/chats") {'));
    expect(chats).toMatch(/^[^]*?const desktop = isDesktopApp\(req\.headers, url\.searchParams\);\s*if \(!desktop && !companionAuthorized\(req\.headers\)\) return json\(res, 404, \{ error: "no such route" \}\);/);
  });
});
