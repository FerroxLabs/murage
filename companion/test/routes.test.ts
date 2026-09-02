// The allowlist.
//
// The proxy tests prove the app's own calls reach a real harness. These prove
// the other half, which no end-to-end test can: that everything else does
// not. The case worth caring about is the last one — a route nobody here has
// heard of is denied, because that is the property the whole file exists for
// and the one that quietly stopped being true once before.
import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { BROWSER_DENIED, BROWSER_STATIC, denyReason, type Surface } from "../src/routes.ts";

const ask = (method: string, path: string, authenticated = true, surface: Surface = "device") =>
  denyReason({ method, path, authenticated, surface });

/** The same question, asked at the other door. */
const askBrowser = (method: string, path: string, authenticated = true) =>
  ask(method, path, authenticated, "browser");

const allowed = (method: string, path: string) => ask(method, path) === null;

describe("credentials", () => {
  it("lets an unpaired device pair, and do nothing else", () => {
    expect(ask("POST", "/api/pair", false)).toBeNull();
    expect(ask("GET", "/api/bots", false)).toEqual({
      status: 401,
      error: "pair this device from Phone settings in Murage on your computer",
    });
    expect(ask("POST", "/api/files", false)?.status).toBe(401);
  });

  it("lets anyone curl liveness — it is the unauthenticated smoke test", () => {
    expect(ask("GET", "/api/health", false)).toBeNull();
    // the bypass is one method on one path, not a family
    expect(ask("POST", "/api/health", false)?.status).toBe(401);
    expect(ask("GET", "/api/healthz", false)?.status).toBe(401);
  });
});

describe("what the app may do", () => {
  // Every request in ios/Sources/CompanionCore/Client.swift. If one of these
  // fails, a screen on the phone is broken.
  const calls: Array<[string, string]> = [
    ["GET", "/api/health"],
    ["GET", "/api/config"],
    ["GET", "/api/events"],
    ["GET", "/api/instances"],
    ["GET", "/api/companion/endpoints"],
    ["GET", "/api/bots"],
    ["POST", "/api/bots"],
    ["POST", "/api/sidebar-sections"],
    ["POST", "/api/bots/bot_123/messages"],
    ["POST", "/api/bots/bot_123/interrupt"],
    ["POST", "/api/bots/bot_123/read"],
    ["POST", "/api/bots/bot_123/always-allow"],
    ["POST", "/api/bots/bot_123/messages/msg_2/edit"],
    ["POST", "/api/bots/bot_123/active-branch"],
    ["POST", "/api/bots/bot_123/tasks"],
    ["POST", "/api/bots/bot_123/tasks/th_1"],
    ["PATCH", "/api/bots/bot_123/tasks/th_1"],
    ["DELETE", "/api/bots/bot_123/tasks/th_1"],
    ["PATCH", "/api/bots/bot_123/profile"],
    ["POST", "/api/bots/bot_123/avatar/generate"],
    ["POST", "/api/bots/bot_123/computer/join"],
    ["POST", "/api/groups/room-1/messages"],
    ["POST", "/api/groups/room-1/read"],
    ["POST", "/api/groups/room-1/tasks"],
    ["POST", "/api/groups/room-1/tasks/th_1"],
    ["PATCH", "/api/groups/room-1/tasks/th_1"],
    ["DELETE", "/api/groups/room-1/tasks/th_1"],
    ["GET", "/api/threads/th_1/messages"],
    ["GET", "/api/threads/th_1/messages/msg_2/image"],
    ["POST", "/api/threads/th_1/messages/msg_2/reactions"],
    ["GET", "/api/threads/th_1/export"],
    ["POST", "/api/threads/th_1/respond"],
    ["POST", "/api/attachments"],
    ["GET", "/api/attachments/avatar-123.webp"],
    ["POST", "/api/files"],
    ["GET", "/api/tts/voices"],
    ["POST", "/api/tts/speak"],
    ["GET", "/api/routines"],
    ["POST", "/api/routines"],
    ["PATCH", "/api/routines/routine_1"],
    ["DELETE", "/api/routines/routine_1"],
    ["POST", "/api/routines/routine_1/run"],
    ["GET", "/api/connectors/catalog"],
    ["GET", "/api/connectors/connected"],
    ["GET", "/api/connectors"],
  ];

  for (const [method, path] of calls) {
    it(`allows ${method} ${path}`, () => expect(ask(method, path)).toBeNull());
  }
});

describe("what it may not", () => {
  it("refuses host configuration, and says where it happens", () => {
    for (const [method, path] of [
      ["PUT", "/api/config"],
      ["PATCH", "/api/config"],
      ["GET", "/api/devices"],
      ["GET", "/api/companion"],
      ["POST", "/api/local-computer/start"],
      ["POST", "/api/webhooks"],
      ["POST", "/api/webhooks/wh_1/rotate"],
      ["DELETE", "/api/connectors/gmail"],
      ["POST", "/api/teams/import"],
    ] as Array<[string, string]>) {
      const denial = ask(method, path);
      expect(denial?.status, `${method} ${path}`).toBe(403);
      expect(denial?.error, `${method} ${path}`).toMatch(/on your computer/);
    }
    expect(ask("GET", "/api/devices")).toEqual({
      status: 403,
      error: "Phone settings are managed on your computer",
    });
    expect(ask("GET", "/api/companion")).toEqual({
      status: 403,
      error: "Phone settings are managed on your computer",
    });
  });

  it("keeps endpoint refresh authenticated and exact-method only", () => {
    expect(ask("GET", "/api/companion/endpoints", false)?.status).toBe(401);
    expect(ask("GET", "/api/companion/endpoints")).toBeNull();
    expect(ask("POST", "/api/companion/endpoints")?.status).toBe(403);
    expect(ask("GET", "/api/companion/endpoints/extra")?.status).toBe(403);
  });

  it("describes only refused routine operations as computer-only", () => {
    for (const [method, path] of [
      ["GET", "/api/routines/routine_1"],
      ["PUT", "/api/routines/routine_1"],
      ["POST", "/api/routines/routine_1/cancel"],
    ] as Array<[string, string]>) {
      const denial = ask(method, path);
      expect(denial, `${method} ${path}`).toEqual({
        status: 403,
        error: "this routine operation is only available on your computer",
      });
    }
    expect(ask("GET", "/api/routines")).toBeNull();
    expect(ask("POST", "/api/routines/routine_1/run")).toBeNull();
  });

  // Both of these were allowed once. Removing a line from an allowlist leaves
  // no trace, so the refusal is asserted here rather than merely implied by
  // the absence above.
  it("refuses the cross-thread transcript grep outright", () => {
    // No visibility scoping exists on this route: `?q=e` returned hits from
    // every thread on the machine. There is no per-thread form to allow, so
    // it is denied as a route the companion has never heard of.
    expect(ask("GET", "/api/search")).toEqual({
      status: 404,
      error: "no route: GET /api/search",
    });
  });

  it("lets the phone see connected apps but never bind a new one", () => {
    expect(allowed("GET", "/api/connectors")).toBe(true);
    expect(allowed("GET", "/api/connectors/catalog")).toBe(true);
    expect(allowed("GET", "/api/connectors/connected")).toBe(true);
    // Binding and revoking are both keyboard decisions.
    expect(ask("POST", "/api/connectors/gmail/authorize")).toEqual({
      status: 403,
      error: "connected apps are set up on your computer",
    });
    expect(ask("DELETE", "/api/connectors/gmail")?.status).toBe(403);
  });

  it("denies the peer-agent endpoints exist at all", () => {
    expect(ask("GET", "/api/internal/peers")?.status).toBe(404);
    expect(ask("POST", "/api/internal/ask-bot")?.status).toBe(404);
  });

  it("does not serve the desktop UI", () => {
    expect(ask("GET", "/")?.status).toBe(404);
    expect(ask("GET", "/index.html")?.status).toBe(404);
  });

  it("opens only a fresh cloud viewer, not the cloud computer control API", () => {
    expect(allowed("POST", "/api/bots/bot_123/computer/join")).toBe(true);
    expect(allowed("GET", "/api/bots/bot_123/computer")).toBe(false);
    expect(allowed("POST", "/api/bots/bot_123/computer/provision")).toBe(false);
    expect(allowed("POST", "/api/bots/bot_123/computer/sleep")).toBe(false);
    expect(allowed("POST", "/api/bots/bot_123/computer/exec")).toBe(false);
    expect(allowed("POST", "/api/bots/bot_123/computer/screenshot")).toBe(false);
  });

  // The method is part of the allowance, not decoration: reading the fleet
  // and deleting a bot are the same path.
  it("allows a path only for the methods it was allowed for", () => {
    expect(allowed("GET", "/api/bots")).toBe(true);
    expect(allowed("DELETE", "/api/bots/bot_123")).toBe(false);
    expect(allowed("POST", "/api/threads/th_1/messages")).toBe(false);
    expect(allowed("GET", "/api/groups/room-1")).toBe(false);
    expect(allowed("PATCH", "/api/bots/bot_123")).toBe(false);
    expect(allowed("PATCH", "/api/bots/bot_123/profile/execution-policy")).toBe(false);
    expect(allowed("GET", "/api/sidebar-sections")).toBe(false);
    expect(allowed("PATCH", "/api/sidebar-sections")).toBe(false);
    expect(allowed("POST", "/api/sidebar-sections/extra")).toBe(false);
    expect(allowed("PUT", "/api/config")).toBe(false);
    expect(allowed("GET", "/api/attachments/../config.json")).toBe(false);
    expect(allowed("GET", "/api/files")).toBe(false);
    expect(allowed("POST", "/api/files/anything")).toBe(false);
    expect(allowed("POST", "/api/routine-runs/run_1/cancel")).toBe(false);
    expect(allowed("DELETE", "/api/connectors/slack")).toBe(false);
    expect(allowed("GET", "/api/connectors/connected/all")).toBe(false);
    // revocation is a Mac-only affordance: the phone can list and add
    // accounts but the account DELETE route is deliberately not allowed
    expect(allowed("DELETE", "/api/connectors/slack/accounts/ca_123")).toBe(false);
    expect(allowed("PATCH", "/api/groups/room-1")).toBe(false);
  });

  // Patterns are anchored, so a path that merely starts right is still a
  // path nobody allowed.
  it("is not fooled by a prefix", () => {
    expect(allowed("GET", "/api/bots/bot_123/computer")).toBe(false);
    expect(allowed("GET", "/api/botsandthensome")).toBe(false);
    expect(allowed("GET", "/api/events/all")).toBe(false);
    expect(allowed("GET", "/api/threads/th_1/messages/msg_2/image/../../../config")).toBe(false);
    expect(allowed("GET", "/api/bots%2f..%2fwebhooks")).toBe(false);
  });

  // The one that matters. Upstream adds routes on its own schedule, and the
  // sidecar must not carry them to a phone because nobody wrote a rule
  // against a thing that did not exist yet.
  it("denies a route it has never heard of", () => {
    for (const path of [
      "/api/whatever-ships-next",
      "/api/bots/bot_123/some-new-verb",
      "/api/secrets",
    ]) {
      expect(allowed("GET", path), path).toBe(false);
      expect(allowed("POST", path), path).toBe(false);
      expect(allowed("DELETE", path), path).toBe(false);
    }
  });
});

// ── the two doors ────────────────────────────────────────────────────────
//
// The property being pinned is not "the browser can do these things". It is
// that the two lists cannot drift into each other: a route added for one door
// does not thereby appear at the other, and the routes that compose into
// arbitrary code execution are refused at the browser door explicitly, before
// anything is allowed to allow them.
describe("surfaces do not converge", () => {
  it("keeps the UI shell off the device port entirely", () => {
    // Every shell path, asked at the device door. If any of these returns
    // null the phone's allowlist has quietly grown a static file server.
    for (const entry of BROWSER_STATIC) {
      const path =
        entry.path.source === "^\\/$" ? "/"
        : entry.path.source.includes("assets") ? "/assets/index-B7zzSDok.js"
        : entry.path.source.includes("chat|rooms") ? "/chat/bot_123"
        : entry.path.source.includes("icons") ? "/icons/murage-192.png"
        : entry.path.source.includes("murage-logo") ? "/murage-logo.png"
        : entry.path.source.replace(/[\\^$]/g, "").replace(/\(\?:.*/, "");
      expect(ask("GET", path), path).not.toBeNull();
      expect(askBrowser("GET", path), path).toBeNull();
    }
  });

  it("gives the browser no pairing and no liveness bypass", () => {
    // Both are unauthenticated at the device door on purpose. Neither is a
    // thing a browser does, and an unauthenticated route is the most
    // expensive kind to have by accident.
    expect(ask("POST", "/api/pair", false)).toBeNull();
    expect(askBrowser("POST", "/api/pair", false)?.status).toBe(401);
    expect(ask("GET", "/api/health", false)).toBeNull();
    expect(askBrowser("GET", "/api/health", false)?.status).toBe(401);
    // and they are not merely unauthenticated-only: a signed-in browser has
    // no route to them either
    expect(askBrowser("POST", "/api/pair")?.status).toBe(404);
    expect(askBrowser("GET", "/api/health")?.status).toBe(404);
  });

  it("points an unauthenticated browser at a page rather than at a settings panel", () => {
    expect(askBrowser("GET", "/api/bots", false)).toEqual({
      status: 401,
      error: "sign in",
      signIn: "/enter",
    });
  });

  it("refuses the two halves of the two-request RCE, and the VM lifecycle", () => {
    // Explicit, and checked before the allowlist — so this holds whatever
    // BROWSER_ALLOWED grows to say.
    for (const [method, path] of [
      ["POST", "/api/cli-test"],
      ["PATCH", "/api/instances/claude"],
      ["POST", "/api/local-computer"],
      ["POST", "/api/local-computer/start"],
      ["POST", "/api/bots/bot_123/local-computer"],
      ["POST", "/api/bots/bot_123/local-computer/exec"],
    ] as const) {
      expect(askBrowser(method, path), `${method} ${path}`).toEqual({
        status: 404,
        error: `no route: ${method} ${path}`,
      });
    }
  });

  it("keeps the unscoped-grep and desktop-only routes off the browser", () => {
    for (const [method, path] of [
      // scoped in the harness now, but still unbounded in `q` — see the note
      // on BROWSER_ALLOWED
      ["GET", "/api/search"],
      // connection candidates are for a native client choosing an address
      ["GET", "/api/companion/endpoints"],
      // the desktop's broad patch, destruction, credentials, public ingress
      ["PATCH", "/api/bots/bot_123"],
      ["DELETE", "/api/bots/bot_123"],
      ["PUT", "/api/config"],
      ["POST", "/api/webhooks"],
      ["POST", "/api/connectors/slack/authorize"],
      ["POST", "/api/bots/bot_123/computer/exec"],
      ["GET", "/api/cli-candidates"],
      ["GET", "/api/internal/peer"],
    ] as const) {
      expect(askBrowser(method, path), `${method} ${path}`).not.toBeNull();
    }
  });

  it("still applies the browser's own list rather than the phone's", () => {
    // Present on the phone, absent on the browser.
    expect(ask("GET", "/api/companion/endpoints")).toBeNull();
    expect(askBrowser("GET", "/api/companion/endpoints")).not.toBeNull();
    // Present on the browser, absent on the phone.
    expect(askBrowser("GET", "/")).toBeNull();
    expect(ask("GET", "/")).not.toBeNull();
  });

  it("denies a route it has never heard of at the browser door too", () => {
    for (const path of ["/api/whatever-ships-next", "/api/secrets", "/not-a-page"]) {
      expect(askBrowser("GET", path), path).not.toBeNull();
      expect(askBrowser("POST", path), path).not.toBeNull();
    }
  });
});

// The second lock, as its own layer.
//
// NC18 in the negative-control run is why this exists. Deleting a line from
// BROWSER_DENIED did *not* turn anything red, because none of those four
// routes is in BROWSER_ALLOWED either — default-deny caught them, and the
// second lock could have been silently absent. That is exactly the failure
// this list is supposed to survive: an allowlist edit re-opening one of them.
// So the layer is pinned directly rather than through its effect.
describe("the execution routes are refused by name, not by omission", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/routes.ts", import.meta.url)), "utf8");

  it("names all four, each on its own line", () => {
    const shapes = BROWSER_DENIED.map((r) => `${r.method} ${r.path.source}`);
    expect(shapes).toEqual([
      "POST ^\\/api\\/cli-test$",
      "PATCH ^\\/api\\/instances\\/[\\w.-]+$",
      "POST ^\\/api\\/local-computer(?:\\/.*)?$",
      "POST ^\\/api\\/bots\\/[\\w-]+\\/local-computer(?:\\/.*)?$",
    ]);
  });

  it("consults them before anything can allow anything", () => {
    // Order in the source, because order is the property. If the allowlist
    // were consulted first, adding a family to it would re-open these.
    const body = source.slice(source.indexOf("export function denyReason"));
    const denied = body.indexOf("BROWSER_DENIED.some");
    const allowed = body.indexOf("const allowed =");
    expect(denied).toBeGreaterThan(-1);
    expect(allowed).toBeGreaterThan(-1);
    expect(denied).toBeLessThan(allowed);
  });

  it("keeps the two lists disjoint, so neither lock is doing the other's job", () => {
    // If a denied route ever appeared in BROWSER_ALLOWED the deny list would
    // be the only thing holding, which is worth knowing rather than
    // discovering. Today both hold independently.
    for (const denied of BROWSER_DENIED) {
      const sample =
        denied.path.source.includes("cli-test") ? "/api/cli-test"
        : denied.path.source.includes("instances") ? "/api/instances/claude"
        : denied.path.source.includes("bots") ? "/api/bots/bot_1/local-computer/exec"
        : "/api/local-computer/start";
      // Refused, and refused with the harness's own wording.
      expect(askBrowser(denied.method, sample)).toEqual({
        status: 404,
        error: `no route: ${denied.method} ${sample}`,
      });
    }
  });
});

// ── the intake, at the browser door ──────────────────────────────────────
//
// The door shipped with no library routes at all, so a phone that opened a
// blank bot 404'd every request the intake makes. The count came back −1 —
// which is the value the seeded quiz renders on — and Browse was an empty
// box. These pin the six reads that fix it, and, more importantly, the three
// writes that must not come with them.
describe("the new-bot intake reaches the browser door", () => {
  const READS = [
    // the skill count the intake card branches on
    "/api/bots/bot_123/skills",
    // one sentence in, one profile or a short skill list out
    "/api/library/suggest",
    "/api/library/search",
    // Browse: facets from the skills, teams from the catalogue
    "/api/library/browse",
    "/api/team-library/catalog",
    "/api/team-library/teams/smart-trader",
  ] as const;

  it("allows the six reads the card and the panel actually make", () => {
    for (const path of READS) {
      expect(askBrowser("GET", path), path).toBeNull();
    }
  });

  it("allows none of them to a browser that has not signed in", () => {
    for (const path of READS) {
      expect(askBrowser("GET", path, false), path).toEqual({
        status: 401,
        error: "sign in",
        signIn: "/enter",
      });
    }
  });

  it("keeps every writer of a skill off the door", () => {
    // The harness refuses all three off the desktop already. This is the
    // second lock: if that gate were relaxed, the door would still refuse
    // them — and if this list ever grew a family instead of a route, this
    // is the test that would go red.
    for (const [method, path] of [
      // installs from a caller-supplied GitHub URL
      ["POST", "/api/bots/bot_123/skills"],
      // installs from the bundled library and enables what it installs
      ["POST", "/api/bots/bot_123/skills/library"],
      // applies a whole persona: renames the bot and installs its skills
      ["POST", "/api/bots/bot_123/assistant-profile"],
      // enable, disable, delete an installed skill
      ["PATCH", "/api/bots/bot_123/skills/writing"],
      ["DELETE", "/api/bots/bot_123/skills/writing"],
      // fetches an arbitrary GitHub URL from the request body
      ["POST", "/api/team-library/github"],
      // reads a folder off this machine's disk
      ["GET", "/api/teams/scout"],
      ["POST", "/api/teams/import"],
    ] as const) {
      expect(askBrowser(method, path), `${method} ${path}`).not.toBeNull();
    }
  });

  it("opens the reads on the browser only, never on the phone", () => {
    // The two lists do not converge, and adding six lines to one of them is
    // exactly the edit that would make them.
    for (const path of READS) {
      expect(ask("GET", path), path).not.toBeNull();
    }
  });

  it("anchors the library patterns rather than opening a family", () => {
    for (const path of [
      "/api/library",
      "/api/library/suggest/extra",
      "/api/library/../config",
      "/api/team-library",
      "/api/team-library/teams",
      "/api/team-library/teams/Smart-Trader",
      "/api/team-library/teams/../../config",
      "/api/team-library/teams/a%2F..%2Fb",
      "/api/bots/bot_123/skills/library",
    ]) {
      expect(askBrowser("GET", path), path).not.toBeNull();
    }
  });
});
