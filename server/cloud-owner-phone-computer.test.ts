// Release finding 10-B1/B2: a Cloud home's `owner-phone` session maps to the `desktop` surface, so four decisions only the
// computer running Murage may make (putting a site online, the browser's Full mode, approved sites, wider message reach)
// were reachable from a phone. `requestFromComputer` is the question those handlers now ask.
import { readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
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

// Fable M1 (MurageMain ruling, intended): on a Cloud home these sessions all read as the "desktop" surface, so the restore card and the restore routes treat
// them as owner surfaces that may start and dismiss. A local install's companion phone reads "remote" and stays read-only. This pins the mapping the card relies on
// (sse-visibility.ts requestSurface, Cloud branch).
describe("restore owner surfaces: the Cloud mapping the restore card relies on", () => {
  const P256 = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ type: "spki", format: "pem" }).toString();
  const as = (scope: string, extra: Record<string, unknown> = {}): Record<string, string> => { const headers = {}; setCloudIdentity(headers, { scope, ...extra } as unknown as CloudDevice); return headers; };
  it("on a Cloud home the owner desktop, owner phone, acting owner browser and settings-read browser are the desktop surface; a bare browser is not", () => {
    process.env.MURAGE_CLOUD_ROLE = "home";
    expect(requestSurface(as("owner-desktop"))).toBe("desktop");
    expect(requestSurface(as("owner-phone"))).toBe("desktop");
    expect(requestSurface(as("browser", { factor: "passkey", publicKey: P256, assertionKey: P256 }))).toBe("desktop");
    expect(requestSurface(as("browser", { settingsRead: true }))).toBe("desktop");
    expect(requestSurface(as("browser"))).toBe("remote");
    expect(requestSurface(as("companion"))).toBe("remote");
    expect(requestSurface({})).toBe("remote");
  });
  it("off a Cloud home an unmarked caller (the paired local phone) is remote, so the restore routes see it as read-only", () => {
    delete process.env.MURAGE_CLOUD_ROLE;
    expect(requestSurface({})).toBe("remote");
    expect(requestSurface(as("owner-phone"))).toBe("remote");
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
    // taking a site down: the computer, or the owner's browser behind a fresh code for exactly that request (browser-owner-gates.ts)
    expect(source).toContain('const refused = onOwnerBrowser(req.headers) ? await ownerCodeGate(req, routeActDigest(method, path + url.search, await readBody(req)), "take_down_site") : { status: 403, body: { error: PUBLISH_NEEDS_COMPUTER } };');
    expect(source).not.toMatch(/const onComputer = requestSurface\(/);
    expect(source).not.toContain("requestFromComputer(");
  });

  it("gates publish Allow on BOTH respond routes: each calls respondToCard, whose one onComputer check runs before answerRequest", () => {
    const fnStart = source.indexOf("async function respondToCard(");
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = source.indexOf("\n}\n", fnStart);
    const fn = source.slice(fnStart, fnEnd);
    const check = fn.indexOf("const onComputer = isDesktopApp(req.headers, url.searchParams);");
    const gate = fn.indexOf('if (!publishAnswerAllowed(requestId, behavior, onComputer ? "desktop" : provenHere ? "proven" : "elsewhere")) return json(res, 403, { error: PUBLISH_NEEDS_COMPUTER });');
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
    // chatsReader, not companionAuthorized: the owner browser (Sean 10-30, full owner) is admitted; a chat-only browser is not
    expect(source).toContain('if (chatsView && !chatsReader(req.headers, url.searchParams)) return json(res, 404, { error: "no such route" });');
    expect(source).toContain("const visible = chatsDesktop ? null : new Set(store.visibleThreadIds());");
    expect(source).toContain("orderedScope = chatSearchRows(chatSource(chatsDesktop), filters).filter(row => !visible || visible.has(row.threadId));");
    const chats = source.slice(source.indexOf('if (method === "GET" && path === "/api/chats") {'));
    expect(chats).toMatch(/^[^]*?const desktop = isDesktopApp\(req\.headers, url\.searchParams\);\s*if \(!chatsReader\(req\.headers, url\.searchParams\)\) return json\(res, 404, \{ error: "no such route" \}\);/);
  });
});

it("chatsReader admits only the desktop app, ownerActs, or a Cloud home owner browser", () => {
  const authority = readFileSync(join(here, "companion-authority.ts"), "utf8");
  const predicate = authority.slice(authority.indexOf("export const chatsReader ="));
  expect(predicate).toContain('isDesktopApp(headers, query) || ownerActs(headers) || (process.env.MURAGE_CLOUD_ROLE === "home" && isOwnerBrowser(cloudIdentity(headers)))');
  expect(predicate).not.toContain("companionAuthorized");
});
