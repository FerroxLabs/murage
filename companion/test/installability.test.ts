// What "Add to Home Screen" actually needs, pinned.
//
// The bug this file pins: Murage shipped a service worker, put HTTPS in front
// via `tailscale serve`, listed every PWA file on the door's static allowlist
// — and Android was STILL never offered an install. Three correct halves and
// no working whole.
//
// The missing piece was credentials. A manifest is fetched in "omit" mode by
// default, so the browser door — which wants the session cookie on every
// route — answered 401 and Chrome silently refused to consider the site
// installable. Measured against the live door while signed in:
//
//     fetch("/manifest.webmanifest", { credentials: "omit" })        -> 401
//     fetch("/manifest.webmanifest", { credentials: "same-origin" }) -> 200
//     fetch("/manifest.webmanifest", { credentials: "include" })     -> 200
//
// Installability needs BOTH a worker with a fetch handler and a manifest the
// browser could actually read. The worker alone was never enough.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { BROWSER_STATIC } from "../src/routes.ts";

const indexHtml = readFileSync(fileURLToPath(new URL("../../index.html", import.meta.url)), "utf8");

/** The `<link rel="manifest" …>` tag, whatever order its attributes are in. */
const manifestLink = (): string => {
  const match = indexHtml.match(/<link[^>]*rel="manifest"[^>]*>/);
  if (!match) throw new Error("index.html has no <link rel=\"manifest\"> at all");
  return match[0];
};

describe("installability", () => {
  it("fetches the manifest with credentials, because the door requires them", () => {
    // Without this the door 401s the manifest and the install prompt never
    // fires. `use-credentials` is the only value that sends the cookie;
    // `anonymous` is the same as omitting it for this purpose.
    expect(manifestLink()).toContain('crossorigin="use-credentials"');
  });

  it("still points at the manifest the build actually emits", () => {
    expect(manifestLink()).toContain('href="/manifest.webmanifest"');
  });

  it("lets the door serve the manifest and the worker", () => {
    const allowed = (path: string) =>
      BROWSER_STATIC.some((route) => route.method === "GET" && route.path.test(path));
    expect(allowed("/manifest.webmanifest")).toBe(true);
    expect(allowed("/sw.js")).toBe(true);
  });

  it("lists each PWA route exactly once", () => {
    // `/sw.js` was listed twice: harmless to `some()`, but the allowlist's
    // whole property is that every entry is a decision someone made, and a
    // duplicate makes that list harder to audit rather than easier.
    const sources = BROWSER_STATIC.map((route) => `${route.method} ${route.path.source}`);
    expect(new Set(sources).size).toBe(sources.length);
  });
});
