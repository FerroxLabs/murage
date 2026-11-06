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
    // BOT-RESPOND-ROUTE-UNIFY: one copy, inside respondToCard, which both respond routes call (pinned below)
    expect(source.match(/const onComputer = isDesktopApp\(req\.headers, url\.searchParams\);/g)).toHaveLength(1);
    expect(source).toContain('if (!isDesktopApp(req.headers, url.searchParams)) return json(res, 403, browserExtError("browserExt.full.errorDesktopOnly"));');
    expect(source).toContain('if (mode !== "full" && !isDesktopApp(req.headers, url.searchParams) && rank[mode]');
    expect(source).toContain("const ownerDesktop = isDesktopApp(req.headers, url.searchParams);");
    expect(source).toContain("const desktopSurface = isDesktopApp(req.headers, url.searchParams);");
    expect(source).toContain('if (!isDesktopApp(req.headers, url.searchParams)) return json(res, 403, { error: PUBLISH_NEEDS_COMPUTER });');
    expect(source).not.toMatch(/const onComputer = requestSurface\(/);
    expect(source).not.toContain("requestFromComputer(");
  });

  it("gates publish Allow on BOTH respond routes: each calls respondToCard, whose one onComputer check runs before answerRequest", () => {
    const fnStart = source.indexOf("async function respondToCard(");
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = source.indexOf("\n}\n", fnStart);
    const fn = source.slice(fnStart, fnEnd);
    const check = fn.indexOf("const onComputer = isDesktopApp(req.headers, url.searchParams);");
    const gate = fn.indexOf('if (!publishAnswerAllowed(requestId, behavior, onComputer ? "desktop" : "elsewhere")) return json(res, 403, { error: PUBLISH_NEEDS_COMPUTER });');
    const answer = fn.indexOf("await answerRequest(threadId, asked.instanceId, requestId, behavior,");
    expect(check).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(check);
    expect(answer).toBeGreaterThan(gate);
    // two answerRequest calls only: the question-card branch (a question is never a publish card) and the gated one, last
    expect(fn.match(/answerRequest\(/g)).toHaveLength(2);
    expect(fn.indexOf('if (question.kind === "deliver") {')).toBeGreaterThan(-1);
    expect(fn.indexOf("answerRequest(")).toBeGreaterThan(fn.indexOf('if (question.kind === "deliver") {'));
    expect(fn.lastIndexOf("answerRequest(")).toBe(answer + "await ".length);
    const route = (pattern: string): string => {
      const at = source.indexOf(pattern);
      expect(at, pattern).toBeGreaterThan(-1);
      return source.slice(at, source.indexOf("\n    }\n", at));
    };
    const botRoute = route("m = path.match(/^\\/api\\/bots\\/([\\w-]+)\\/respond$/);");
    const threadRoute = route("m = path.match(/^\\/api\\/threads\\/([\\w-]+)\\/respond$/);");
    expect(botRoute).toMatch(/return await respondToCard\(\{ req, url, res \}, bot\.threadId, body, undefined, \{ botId: bot\.id \}\);/);
    expect(threadRoute).toMatch(/return await respondToCard\(\{ req, url, res \}, threadId, await readBody\(req\)\);/);
    for (const r of [botRoute, threadRoute]) {
      expect(r).not.toContain("answerRequest(");
      expect(r).not.toContain("publishAnswerAllowed(");
    }
  });
});

describe("All chats answers a Cloud home's paired phone as the phone (chats slice 1)", () => {
  const source = readFileSync(join(here, "index.ts"), "utf8");
  it("splits desktop from phone with isDesktopApp and admits only the desktop app or the owner acting", () => {
    expect(source).toContain("const chatsDesktop = chatsView && isDesktopApp(req.headers, url.searchParams);");
    // ownerActs, not companionAuthorized: a Cloud browser with a remembered owner login gets no previews or owner-audience hits
    expect(source).toContain('if (chatsView && !chatsDesktop && !ownerActs(req.headers)) return json(res, 404, { error: "no such route" });');
    expect(source).toContain("const visible = chatsDesktop ? null : new Set(store.visibleThreadIds());");
    expect(source).toContain("scope = chatSearchThreads(chatSource(chatsDesktop), chatFiltersFromQuery(url.searchParams))");
    const chats = source.slice(source.indexOf('if (method === "GET" && path === "/api/chats") {'));
    expect(chats).toMatch(/^[^]*?const desktop = isDesktopApp\(req\.headers, url\.searchParams\);\s*if \(!desktop && !ownerActs\(req\.headers\)\) return json\(res, 404, \{ error: "no such route" \}\);/);
  });
});
