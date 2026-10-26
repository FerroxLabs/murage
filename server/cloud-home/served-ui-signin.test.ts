// SPDX-License-Identifier: AGPL-3.0-or-later
// A Cloud home serves the built web app to the customer's browser (MURAGE_STATIC_DIR, /opt/murage/dist in the image).
// This proves the build the home would serve carries the sign-in UI: the "<Engine> is set up on this home" copy.
// It needs a built dist: the image gate sets MURAGE_REQUIRE_UI_BUILD=1 after `vite build`; elsewhere it skips when dist is absent.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const dist = resolve(process.env.MURAGE_STATIC_DIR ?? "dist");
const required = process.env.MURAGE_REQUIRE_UI_BUILD === "1";

function jsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? jsFiles(join(dir, e.name)) : e.name.endsWith(".js") ? [join(dir, e.name)] : [],
  );
}

describe("home-served UI build", () => {
  (existsSync(dist) || required ? it : it.skip)("includes the Cloud sign-in UI", () => {
    expect(existsSync(dist), `no UI build at ${dist}`).toBe(true);
    const bundle = jsFiles(dist).map((f) => readFileSync(f, "utf8")).join("\n");
    expect(bundle).toContain(" is set up on this home");
    // the chat sign-in gate (cloud chat: read the bot's own sign-in, show the prompt before send)
    expect(bundle).toContain(" needs its own ");
    expect(bundle).toContain("before you can chat.");
    expect(bundle).toContain("/api/cloud/engine-signins");
  });
});
