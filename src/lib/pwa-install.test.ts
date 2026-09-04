// "Add to Home Screen" is a contract spread across four files that never
// import each other, which is exactly the shape of thing that rots silently.
//
// The manifest names icons. index.html names the manifest and a different
// icon (iOS reads its own tag, not the manifest). The build copies `public/`
// into `dist/`. And the browser door serves a file only if its path is on an
// allowlist in another package — a path that is not on it 404s, so a missing
// entry does not look like a bug, it looks like an install that quietly will
// not offer itself.
//
// Nothing about that fails a typecheck, a lint, or a render. So it gets a
// test, and the test asks the door the same question the phone asks.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { denyReason } from "../../companion/src/routes";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const html = readFileSync(join(root, "index.html"), "utf8");
const manifest = JSON.parse(readFileSync(join(root, "public/manifest.webmanifest"), "utf8")) as {
  name: string;
  start_url: string;
  scope: string;
  display: string;
  background_color: string;
  theme_color: string;
  icons: { src: string; sizes: string; type: string; purpose: string }[];
};

/** Every absolute path the document or the manifest asks a browser to fetch. */
const referenced = [
  ...[...html.matchAll(/(?:href|content)="(\/[^"]+\.(?:svg|png|ico|webmanifest))"/g)].map(([, p]) => p),
  ...manifest.icons.map((icon) => icon.src),
];

describe("the installable web app", () => {
  it("declares what a browser needs before it will offer an install", () => {
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/");
    // Scope must contain start_url or the installed app opens in a tab the
    // moment anyone follows a link.
    expect(manifest.scope).toBe("/");
    expect(manifest.name).toBe("Murage");
    // 192 and 512 are the two Chrome requires; below both, install is refused
    // with no error a user can see.
    const any = manifest.icons.filter((icon) => icon.purpose === "any").map((icon) => icon.sizes);
    expect(any).toContain("192x192");
    expect(any).toContain("512x512");
  });

  it("ships a maskable icon, because Android crops the other one", () => {
    // An adaptive launcher masks the tile to a shape of its choosing. A
    // transparent-cornered icon there shows the launcher's own background
    // through the corners, which is the "why does it look wrong on my phone"
    // report nobody files.
    const maskable = manifest.icons.filter((icon) => icon.purpose === "maskable");
    expect(maskable.map((icon) => icon.sizes).sort()).toEqual(["192x192", "512x512"]);
  });

  it("hands iOS its own tag, which is the only one iOS reads", () => {
    expect(html).toContain('rel="apple-touch-icon" href="/icons/murage-180.png"');
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
  });

  it("tracks both palettes in the browser chrome", () => {
    // The manifest carries one theme colour; the app has two. Without these
    // a light user gets black chrome above a white app.
    expect(html).toMatch(/theme-color" media="\(prefers-color-scheme: light\)" content="#f7f7f7"/);
    expect(html).toMatch(/theme-color" media="\(prefers-color-scheme: dark\)" content="#0a0a0a"/);
  });

  it("actually ships every file it points at", () => {
    for (const path of referenced) {
      expect(existsSync(join(root, "public", path)), `public${path} is missing`).toBe(true);
    }
  });

  it("is served as a manifest by BOTH things that serve it", () => {
    // Wrong content type is the quietest possible failure: 200, correct
    // bytes, and no install prompt ever, with nothing in any log. The
    // harness serves the desktop and the door serves the phone, and they
    // keep separate tables, so both are asserted here.
    for (const file of ["server/index.ts", "companion/src/browser.ts"]) {
      const source = readFileSync(join(root, file), "utf8");
      expect(source, `${file} does not map .webmanifest`).toContain(
        '".webmanifest": "application/manifest+json"',
      );
    }
  });

  it("can be fetched through the browser door, which is the whole point", () => {
    // The door is an allowlist with a default deny. Every path above has to
    // be on it or the install silently never offers itself on the one
    // surface — a phone over the tailnet — this was all built for.
    for (const path of referenced) {
      const denial = denyReason({ method: "GET", path, authenticated: true, surface: "browser" });
      expect(denial, `the door refuses GET ${path}: ${denial?.error}`).toBeNull();
    }
  });
});

describe("the service worker, without which none of the above fires", () => {
  // Chrome does not offer to install a site that has no service worker. Every
  // other piece of this contract was already correct and the app was still
  // never installable on Android — `installInvite` returned "hidden" because
  // `beforeinstallprompt` had never fired, and nothing anywhere said why.
  //
  // So the worker gets the same treatment as the manifest: asserted to exist,
  // to be registered, to be reachable through the door, and to keep its hands
  // off the harness.
  const sw = readFileSync(join(root, "public/sw.js"), "utf8");

  it("ships and has a fetch handler, which is the installability requirement", () => {
    expect(existsSync(join(root, "public/sw.js"))).toBe(true);
    expect(sw).toContain('addEventListener("fetch"');
  });

  it("is actually registered by the app, not merely present", () => {
    // A worker nobody registers is a file, not a worker.
    const entry = readFileSync(join(root, "src/main.tsx"), "utf8");
    expect(entry).toContain("registerServiceWorker()");
    const register = readFileSync(join(root, "src/lib/register-sw.ts"), "utf8");
    expect(register).toContain('navigator.serviceWorker.register("/sw.js"');
  });

  it("can be fetched through the browser door", () => {
    // Same default-deny allowlist as the manifest. A missing entry here 404s
    // registration and the failure is completely silent.
    const denial = denyReason({ method: "GET", path: "/sw.js", authenticated: true, surface: "browser" });
    expect(denial, `the door refuses GET /sw.js: ${denial?.error}`).toBeNull();
  });

  it("never intercepts the harness", () => {
    // A cached /api response is a stale bot roster or a replayed turn. The
    // worker must fall through, and this asserts the guard rather than the
    // intent behind it.
    expect(sw).toContain('url.pathname.startsWith("/api/")');
    expect(sw).toContain('request.method !== "GET"');
  });
});
