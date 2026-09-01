// The desktop has to say it is the desktop.
//
// The harness scopes its transcript routes to a phone's narrow view BY
// DEFAULT — a paired device must not receive frames for hidden bots or
// bot-to-bot rooms simply by holding the events stream open, and it must not
// be able to talk its way out by setting a header. Fail-closed is the whole
// point of the polarity.
//
// The cost of that choice is that this renderer, which is the desktop app on
// loopback and is entitled to everything, must opt out explicitly at every
// call site. Miss one and there is no error: the sidebar just quietly loses
// every hidden bot and every dm room on hydration, and the live updates for
// them stop arriving. That is the exact failure this file exists to prevent,
// so it asserts the opt-out at each of the three places it has to happen.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { liveEventsUrl } from "./live-events.ts";

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

describe("the desktop opts out of the scoped surface", () => {
  it("puts the surface in the live stream's query string", () => {
    // EventSource cannot send headers. The query string is the only channel
    // this stream has, which is why the harness accepts it here and nowhere
    // that a device could reach.
    expect(new URL(liveEventsUrl(), "http://x").searchParams.get("surface")).toBe("desktop");
  });

  it("keeps the surface when the stream is asked to resume or drop screens", () => {
    for (const options of [{ since: "abc:12" }, { screens: false }, { since: "a:1", screens: false }]) {
      const url = new URL(liveEventsUrl(options), "http://x");
      expect(url.searchParams.get("surface"), JSON.stringify(options)).toBe("desktop");
    }
  });

  it("sends the surface header on every api() call, and does not let a caller drop it", () => {
    // `init` must be spread BEFORE `headers`. Spread last — which is how this
    // was written — a caller passing headers of its own replaced the whole
    // object, taking the surface and the content-type with it.
    const source = read("../state/store.tsx");
    const call = source.slice(source.indexOf("export async function api("));
    const body = call.slice(0, call.indexOf("\n}"));
    expect(body).toContain('"x-murage-surface": "desktop"');
    expect(body.indexOf("...init,")).toBeLessThan(body.indexOf("headers:"));
    expect(body).toContain("...init?.headers");
  });

  it("carries the surface on the inspector's own raw fetch", () => {
    // It does not go through api(), and it reads prompts and tool traffic —
    // precisely what the scoped default withholds.
    const source = read("../components/InspectorPanel.tsx");
    expect(source).toMatch(/\/events\?limit=400[\s\S]{0,200}x-murage-surface/);
  });
});
